// Online speaker labelling for meeting transcripts.
//
// The recogniser already hands back a 192-dim CAM++ embedding per utterance
// (it's the same vector the "only my voice" gate compares against), so putting
// names on turns costs nothing extra at capture time — just the arithmetic
// here. That's the whole reason this is worth doing: a transcript where you can
// see who said what is a document you can hand to an LLM and get a usable draft
// out of; an undifferentiated wall of sentences is not.
//
// This is greedy online clustering, not real diarization. It assigns each
// utterance to the nearest existing centroid if the cosine clears a threshold
// and opens a new speaker otherwise. What it cannot do: split two people
// talking over each other inside one utterance, or recover from an early
// mislabel. What it does do is separate 3-5 people in a normal meeting well
// enough to be worth reading, at zero additional model cost.
//
// The threshold comes from the same measurement that set the voiceprint gate —
// same speaker 0.586-0.862, different speakers 0.047-0.422 — nudged up from 0.5
// to 0.55 because the failure modes are not symmetric here. Merging two people
// into one label destroys information the reader can't reconstruct; splitting
// one person across two labels is obvious on sight and trivially fixed by
// renaming in the UI.

const DEFAULT_THRESHOLD = 0.55

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10)
}

function l2norm(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

/**
 * @param {object} [o]
 * @param {number} [o.threshold]     cosine below which a new speaker is opened
 * @param {number[]} [o.ownerVoiceprint]  the enrolled user's embedding; when
 *        given, whichever cluster matches it is labelled 我 instead of 说话人N
 * @param {number} [o.ownerThreshold]
 */
function createDiarizer({ threshold = DEFAULT_THRESHOLD, ownerVoiceprint = null, ownerThreshold = 0.5 } = {}) {
  // { id, centroid: number[], count, isOwner }
  const speakers = []
  const owner = ownerVoiceprint?.length ? l2norm(ownerVoiceprint) : null

  function label(sp) {
    if (sp.isOwner) return '我'
    // Number the non-owner speakers 1..N in first-appearance order, so a
    // transcript reads 我 / 说话人1 / 说话人2 rather than skipping numbers
    // around wherever the owner happened to land.
    //
    // Numbering is global across channels even though clustering is not, and
    // that is load-bearing rather than incidental: the label IS the join key.
    // Segments store it (store.cjs addSegment), the webhook groups turns by it,
    // and renaming a speaker in the UI rewrites by it — so a per-channel series
    // that produced two 说话人1 would silently merge two people the moment
    // either was renamed. Which channel a voice came from is carried by the
    // `channel` field instead, where it can't collide with anything.
    let n = 0
    for (const s of speakers) {
      if (s.isOwner) continue
      n++
      if (s === sp) return `说话人${n}`
    }
    return sp.id
  }

  /**
   * @param {number[]|null} embedding
   * @param {object} [opts]
   * @param {'mic'|'system'} [opts.channel='mic']
   *        Which capture channel the utterance arrived on. Clusters never match
   *        across channels: 'system' is the machine's own output, so by
   *        construction it did not come from the user's microphone, and no
   *        cosine should be able to argue otherwise. Without this the far end
   *        of a call lands in whichever cluster it happens to sit nearest —
   *        including the owner's, which would attribute the other party's words
   *        to the person reading the transcript.
   * @param {boolean} [opts.canBeOwner=true]
   *        False for anything that cannot be the enrolled user. Guards the
   *        new-cluster branch; channel scoping guards the match branch. Both
   *        are needed — 我 is inherited from a matched cluster, not recomputed.
   * @returns {{id:string, label:string, similarity:number, isNew:boolean, isOwner:boolean}}
   */
  function assign(embedding, { channel = 'mic', canBeOwner = true } = {}) {
    if (!embedding?.length) {
      // No embedding (speaker model not loaded, or an empty clip): everything
      // lands in one bucket rather than inventing a speaker per sentence — one
      // bucket per channel, because there is no vector to tell the room and the
      // far end apart and the source already does.
      const seed = speakers.find((sp) => !sp.centroid && sp.channel === channel)
      const sp = seed || { id: `S${speakers.length + 1}`, centroid: null, count: 0, isOwner: false, channel }
      if (!seed) speakers.push(sp)
      sp.count++
      // isNew stays false even when this opened the bucket: there is no vector,
      // so nothing was recognised as new — the caller is being told "same
      // bucket as always", which is what this branch means.
      return { id: sp.id, label: label(sp), similarity: 0, isNew: false, isOwner: !!sp.isOwner }
    }

    const v = l2norm(embedding)
    let best = null
    let bestSim = -1
    for (const sp of speakers) {
      if (!sp.centroid) continue
      if (sp.channel !== channel) continue
      const sim = cosine(v, sp.centroid)
      if (sim > bestSim) { bestSim = sim; best = sp }
    }

    if (best && bestSim >= threshold) {
      // Running mean, then re-normalise: the centroid stays a unit vector so
      // cosine against it means the same thing on utterance 2 and utterance 200.
      const c = best.centroid
      const n = best.count
      for (let i = 0; i < c.length; i++) c[i] = (c[i] * n + v[i]) / (n + 1)
      best.centroid = l2norm(c)
      best.count++
      return { id: best.id, label: label(best), similarity: bestSim, isNew: false, isOwner: !!best.isOwner }
    }

    const isOwner = canBeOwner && !!owner && cosine(v, owner) >= ownerThreshold && !speakers.some((s) => s.isOwner)
    const sp = { id: `S${speakers.length + 1}`, centroid: v.slice(), count: 1, isOwner, channel }
    speakers.push(sp)
    return { id: sp.id, label: label(sp), similarity: bestSim < 0 ? 0 : bestSim, isNew: true, isOwner }
  }

  /** Snapshot for the meeting doc / webhook payload. Centroids stay internal. */
  function summary() {
    return speakers.map((sp) => ({
      id: sp.id,
      label: label(sp),
      segments: sp.count,
      isOwner: !!sp.isOwner,
      channel: sp.channel || 'mic',
    }))
  }

  return { assign, summary, get size() { return speakers.length } }
}

module.exports = { createDiarizer, cosine, l2norm, DEFAULT_THRESHOLD }
