// What happens to a sentence between "the recogniser produced text" and "it is
// somewhere the user wanted it".
//
// Extracted from main.cjs so it can be run without Electron — which is the only
// way to test the decisions that actually matter here (does the voiceprint gate
// fire, does a meeting swallow the injection, does the right speaker label come
// out) against the real code rather than a paraphrase of it.
//
// Dependencies come in through the constructor: the store, and a `sendText`
// with inject.cjs's signature. Nothing in this file knows about windows, IPC or
// the clipboard.

const { createDiarizer, cosine, l2norm } = require('./diarize.cjs')

/**
 * @param {object} o
 * @param {ReturnType<import('./store.cjs').createStore>} o.store
 * @param {(text:string, opts:object)=>Promise<object>} o.sendText
 * @param {(entry:object)=>void} [o.onHistory]
 * @param {(event:object)=>void} [o.onMeeting]
 */
/**
 * Speaker roster when there is no diarizer to ask: count the labels that were
 * actually used. Order is first appearance, so it reads the way the transcript
 * does.
 */
function rosterFromSegments(segments = []) {
  const seen = new Map()
  for (const seg of segments) {
    const lbl = seg.speaker || '我'
    const row = seen.get(lbl)
    if (row) row.segments++
    else seen.set(lbl, { id: `S${seen.size + 1}`, label: lbl, segments: 1, isOwner: lbl === '我' })
  }
  return [...seen.values()]
}

function createPipeline({ store, sendText, onHistory = () => {}, onMeeting = () => {} }) {
  // The meeting currently recording, if any. Held here rather than in a
  // renderer so a window reload can't lose it mid-call.
  let active = null   // { id, diarizer, startedAt }

  function currentMeetingId() { return active?.id || null }
  function currentMeeting() { return active ? store.getMeeting(active.id) : null }

  /**
   * @param {object} [o]
   * @param {string} [o.title]
   * @param {number} [o.at]
   * @param {string} [o.projectId]        chosen from the list endpoint, if configured
   * @param {string} [o.projectName]
   * @param {string} [o.projectMeetingId]
   */
  function startMeeting({ title = '', at = Date.now(), projectId = '', projectName = '', projectMeetingId = '' } = {}) {
    if (active) return store.getMeeting(active.id)
    const s = store.getSettings()
    const doc = store.createMeeting({ title, at, projectId, projectName, projectMeetingId })
    active = {
      id: doc.id,
      startedAt: doc.startedAt,
      diarizer: createDiarizer({
        threshold: s.meetingDiarizeThreshold,
        ownerVoiceprint: s.voiceprint,
        ownerThreshold: s.voiceprintThreshold,
      }),
    }
    onMeeting({ id: doc.id, started: true })
    return doc
  }

  function stopMeeting({ at = Date.now() } = {}) {
    if (!active) return null
    const id = active.id
    const doc = store.endMeeting(id, { at })
    active = null
    onMeeting({ id, ended: true })
    return doc
  }

  /**
   * One recognised utterance.
   *
   * @param {object} p
   * @param {string} p.text
   * @param {number} [p.at]
   * @param {number} [p.durationMs]  length of the audio
   * @param {number} [p.decodeMs]
   * @param {number[]|null} [p.embedding]
   * @param {'mic'|'system'} [p.source]  which capture channel produced it
   * @returns {Promise<{accepted:boolean, reason?:string, mode?:string, speaker?:string}>}
   */
  async function commit(p = {}) {
    const s = store.getSettings()
    const text = (p.text || '').trim()
    const at = p.at || Date.now()
    if (!text) return { accepted: false, reason: 'empty' }

    const inMeeting = !!active
    const fromSystem = p.source === 'system'

    // System audio with no meeting running is a decode that was still in the
    // queue when the meeting ended. It belongs to no transcript, and it must
    // never reach the injection path below: this is the one route by which a
    // video playing in the background could type itself into whatever document
    // the user happens to have focused. System audio is a meetings-only
    // feature, and "meetings-only" has to be enforced where the decision is
    // made, not only where the capture is started.
    if (fromSystem && !inMeeting) return { accepted: false, reason: 'system-no-meeting' }

    // The voiceprint gate. Bypassed in meetings by default — a meeting is other
    // people talking, and filtering them out leaves a transcript of one
    // person's half of a conversation.
    const gateOn = !!(s.voiceprintEnabled && s.voiceprint?.length) && !(inMeeting && s.meetingBypassVoiceprint)
    if (gateOn) {
      const sim = p.embedding?.length ? cosine(l2norm(p.embedding), l2norm(s.voiceprint)) : 0
      if (sim < (s.voiceprintThreshold ?? 0.5)) {
        // Recorded, not silently dropped: the stats page has to be able to
        // explain a quiet session, and the user has to be able to see that the
        // gate is the reason their colleague's voice didn't land in a document.
        const entry = store.addHistory({
          text, at, mode: inMeeting ? 'meeting' : 'dictation', rejected: true,
          durationMs: p.durationMs, decodeMs: p.decodeMs, source: p.source,
        })
        onHistory(entry)
        return { accepted: false, reason: 'voiceprint', similarity: +sim.toFixed(3) }
      }
    }

    if (inMeeting) {
      // Meetings transcribe; they do not type. Nobody wants an hour of other
      // people's sentences pasted into whatever document happened to be focused.
      // System audio is the machine's own output — the far end of the call. It
      // is never the person holding the microphone, whatever the embedding
      // says, so it clusters on its own side of the owner label. With
      // diarization off there is no clustering to do and the single bucket is
      // 我; that is still wrong for loopback, so it gets its own bucket.
      const who = s.meetingDiarize
        ? active.diarizer.assign(p.embedding, { channel: fromSystem ? 'system' : 'mic', canBeOwner: !fromSystem })
        : (fromSystem ? { label: '对方', id: 'S2' } : { label: '我', id: 'S1' })

      const seg = store.addSegment(active.id, {
        at, durationMs: p.durationMs || 0, speaker: who.label, text,
        ...(fromSystem ? { source: 'system' } : {}),
      })

      const doc = store.getMeeting(active.id)
      if (doc) {
        // With diarization off there is no clustering to summarise, so the
        // roster is counted straight off the segments. It used to be a hardcoded
        // single 我, which stopped being true the moment a second capture
        // channel could contribute turns.
        doc.speakers = s.meetingDiarize
          ? active.diarizer.summary()
          : rosterFromSegments(doc.segments)
        store.saveMeeting(doc)
      }

      const entry = store.addHistory({
        text, at, mode: 'meeting', meetingId: active.id, speaker: who.label,
        durationMs: p.durationMs, decodeMs: p.decodeMs, output: 'none',
        source: p.source,
      })
      onHistory(entry)
      onMeeting({ id: active.id, segment: seg })
      return { accepted: true, mode: 'meeting', speaker: who.label, segment: seg }
    }

    // Injection first, bookkeeping after: the user is watching for the text to
    // appear in their document, not for the history row.
    let result
    try {
      result = await sendText(text, {
        mode: s.outputMode,
        enter: s.pressEnterAfterType,
        restoreClipboard: s.restoreClipboard,
        appendSpace: s.appendSpace,
      })
    } catch (err) {
      result = { ok: false, mode: s.outputMode, chars: text.length, error: err.message || String(err) }
    }

    const entry = store.addHistory({
      text, at, mode: 'dictation',
      durationMs: p.durationMs, decodeMs: p.decodeMs,
      output: result?.ok ? s.outputMode : 'failed',
      app: result?.target,
    })
    onHistory(entry)
    return { accepted: true, mode: 'dictation', output: result, entry }
  }

  return { commit, startMeeting, stopMeeting, currentMeeting, currentMeetingId }
}

module.exports = { createPipeline }
