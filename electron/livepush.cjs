// Real-time per-utterance delivery to the project backend.
//
// Separate from the outbox in webhook.cjs, and the reason is the retry policy
// rather than the payload. The outbox backs off 30s → 2m → 10m → 30m → 2h,
// which is exactly right for "this meeting's transcript is owed and must not be
// lost" and exactly wrong for a live feed — a sentence redelivered two hours
// later arrives in the middle of somebody's next meeting. So: a short bounded
// retry, and then the sentence is dropped and counted.
//
// Dropping is acceptable here only because it is never the last word. The
// transcript is already on disk the instant it is recognised, and the whole
// meeting is pushed again through the durable outbox when it ends. The live
// feed is a convenience on top of a record that is already safe.
//
// Order matters as much as delivery: a transcript whose sentences arrive
// shuffled is worse than one that arrives late. Everything goes through one
// serial promise chain, so utterance N+1 is never in flight before N settled.

const os = require('os')
const { deliver, isoLocal, SPEC_VERSION } = require('./webhook.cjs')

const SEGMENT_EVENT = 'meeting.segment'
// Two retries, seconds apart. Long enough to ride out a reloading backend,
// short enough that the chain behind it doesn't build a backlog — at roughly
// one utterance every few seconds, a stall longer than this is a backend that
// is down, not one that is busy.
const RETRY_DELAYS_MS = [800, 2500]

/**
 * The project block, or nothing at all.
 *
 * Omitted rather than nulled when the meeting has no project: that is the
 * documented fallback shape for "the list endpoint isn't configured", and a
 * receiver should be able to branch on the key's presence instead of having to
 * know that `{project: {id: null}}` means unassigned.
 */
function projectBlock(doc) {
  if (!doc?.projectId) return null
  return {
    id: doc.projectId,
    ...(doc.projectName ? { name: doc.projectName } : {}),
    ...(doc.projectMeetingId ? { meetingId: doc.projectMeetingId } : {}),
  }
}

/**
 * One recognised sentence, ready to POST.
 *
 * @param {object} doc  the meeting document
 * @param {object} seg  the segment as stored (see store.addSegment)
 */
function buildSegmentPayload(doc, seg, { appVersion = '0.0.0', device = os.hostname(), platform = process.platform } = {}) {
  const project = projectBlock(doc)
  return {
    event: SEGMENT_EVENT,
    specVersion: SPEC_VERSION,
    meeting: {
      id: doc.id,
      title: doc.title || '',
      startedAt: isoLocal(doc.startedAt),
    },
    ...(project ? { project } : {}),
    segment: {
      i: seg.i,
      at: isoLocal(seg.at),
      offsetMs: seg.offsetMs || 0,
      durationMs: seg.durationMs || 0,
      speaker: seg.speaker || '',
      // Absent for the microphone, 'system' for loopback — the far end of the
      // call. A receiver that wants only the remote half can filter on it.
      ...(seg.source ? { source: seg.source } : {}),
      text: seg.text || '',
    },
    source: { app: 'kuaishuo', version: appVersion, platform, device },
  }
}

/** Add the same project block to an end-of-meeting payload from buildPayload. */
function withProject(payload, doc) {
  const project = projectBlock(doc)
  return project ? { ...payload, project } : payload
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Serial sender with bounded retry.
 *
 * @param {object} o
 * @param {string} [o.appVersion]
 * @param {(meetingId:string, res:object, stats:object)=>void} [o.onResult]
 *        Fired once per sentence, after it has either landed or been given up
 *        on. The stats are what the console shows — a live feed that is
 *        silently failing should be visible, not discovered later.
 */
function createLiveSender({ appVersion = '0.0.0', onResult = () => {}, delays = RETRY_DELAYS_MS } = {}) {
  let chain = Promise.resolve()
  const stats = new Map()   // meetingId -> {sent, failed}

  function statsFor(id) {
    if (!stats.has(id)) stats.set(id, { sent: 0, failed: 0 })
    return stats.get(id)
  }

  /**
   * Queue one sentence. Returns a promise that settles when it has been dealt
   * with, but callers are not expected to await it — the transcript must never
   * wait on the network.
   */
  function push(doc, seg, config) {
    const meetingId = doc.id
    const payload = buildSegmentPayload(doc, seg, { appVersion })
    chain = chain.then(async () => {
      let res = null
      for (let attempt = 0; ; attempt++) {
        res = await deliver(payload, {
          url: config.url, secret: config.secret || '', headers: config.headers || {}, appVersion,
        })
        if (res.ok) break
        // A 4xx will say the same thing next time. Retrying a rejected
        // signature or a wrong path just triples the log noise.
        if (res.permanent) break
        if (attempt >= delays.length) break
        await sleep(delays[attempt])
      }
      const s = statsFor(meetingId)
      if (res.ok) s.sent++
      else s.failed++
      try { onResult(meetingId, res, { ...s }) } catch { /* a reporting bug must not break the chain */ }
    }).catch(() => { /* the chain outlives any single failure */ })
    return chain
  }

  /** Wait for everything queued so far. Used when a meeting ends. */
  function flush() { return chain }

  function statsOf(meetingId) { return { ...statsFor(meetingId) } }
  function forget(meetingId) { stats.delete(meetingId) }

  return { push, flush, statsOf, forget }
}

module.exports = {
  SEGMENT_EVENT, RETRY_DELAYS_MS,
  buildSegmentPayload, withProject, projectBlock, createLiveSender,
}
