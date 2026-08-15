// Meeting transcript delivery.
//
// The contract this file defines is the actual product surface for the "会议结束
// 自动开稿" workflow — whatever is on the other end (n8n, Dify, a Coze flow, a
// bare Express route) codes against this shape, so it is documented here rather
// than left implicit in whatever the builder happens to emit.
//
// ── Request ────────────────────────────────────────────────────────────────
//   POST <webhookUrl>
//   Content-Type: application/json; charset=utf-8
//   User-Agent: kuaishuo/<version>
//   X-Kuaishuo-Event: meeting.completed
//   X-Kuaishuo-Delivery: <uuid-ish, stable across retries of the same push>
//   X-Kuaishuo-Timestamp: <epoch seconds>
//   X-Kuaishuo-Signature: sha256=<hex HMAC over `${timestamp}.${rawBody}`>
//
// The signature covers the timestamp as well as the body so a captured request
// can't be replayed indefinitely — reject anything more than a few minutes old
// on your side. Signing is skipped entirely when no secret is configured.
//
// ── Body ───────────────────────────────────────────────────────────────────
// {
//   "event": "meeting.completed",
//   "specVersion": "1.0",
//   "id": "mt_20260809_153012_001",
//   "title": "周会",
//   "startedAt": "2026-08-09T15:30:12.000+08:00",
//   "endedAt":   "2026-08-09T16:12:40.000+08:00",
//   "durationMs": 2548000,
//   "source": { "app": "kuaishuo", "version": "1.0.0", "platform": "win32", "device": "DESKTOP-X" },
//   "stats": { "segments": 214, "chars": 9310, "words": 8800, "speakers": 3, "speechMs": 1904000 },
//   "speakers": [ { "id": "S1", "label": "我", "segments": 96, "isOwner": true }, … ],
//   "transcript": {
//     "text": "我：……\n说话人1：……",          // speaker-prefixed plain text
//     "markdown": "# 周会\n\n**我** …",         // ready to paste into a doc
//     "segments": [                            // omitted when includeSegments=false
//       { "i": 0, "speaker": "我", "offsetMs": 0, "durationMs": 3200,
//         "at": "2026-08-09T15:30:12.000+08:00", "text": "我们先过一下上周的进展" }
//     ]
//   },
//   "notes": ""                                 // free text typed in the console
// }
//
// ── Response ───────────────────────────────────────────────────────────────
// Any 2xx is success. 4xx is permanent (not retried — a 401 will still be a 401
// in ten minutes). 5xx, timeouts and connection errors go to the outbox and are
// retried with backoff, so a meeting that ended while the VPN was down still
// reaches the automation once the laptop reconnects.

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const os = require('os')

const SPEC_VERSION = '1.0'
const EVENT = 'meeting.completed'
const TIMEOUT_MS = 20_000
// 30s, 2m, 10m, 30m, 2h. Five attempts spread over ~3 hours covers the realistic
// failures (a flaky link, a webhook host restarting, a laptop that slept) without
// hammering an endpoint that is simply broken.
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000]

// ---- Formatting -------------------------------------------------------------

// ISO 8601 with the local UTC offset rather than a Z. The consumer of this is
// usually writing a document about a meeting that happened at a wall-clock
// time, and "16:12 +08:00" survives that trip intact where a UTC instant
// silently becomes the wrong afternoon.
function isoLocal(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = p(Math.floor(Math.abs(off) / 60))
  const om = p(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
         `${sign}${oh}:${om}`
}

function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

/** Speaker-prefixed plain text, one turn per line, consecutive turns merged. */
function transcriptText(segments) {
  const lines = []
  let last = null
  for (const s of segments) {
    if (s.speaker === last) lines[lines.length - 1] += s.text
    else { lines.push(`${s.speaker}：${s.text}`); last = s.speaker }
  }
  return lines.join('\n')
}

/** The same content as a document — timestamps kept, so quotes stay locatable. */
function transcriptMarkdown(doc, segments) {
  const head = [
    `# ${doc.title}`,
    '',
    `- 时间：${isoLocal(doc.startedAt)} — ${doc.endedAt ? isoLocal(doc.endedAt) : '进行中'}`,
    `- 时长：${hhmmss((doc.endedAt || Date.now()) - doc.startedAt)}`,
    `- 段落：${segments.length}`,
    '',
    '## 逐字稿',
    '',
  ]
  const body = []
  let last = null
  for (const s of segments) {
    if (s.speaker === last) {
      body[body.length - 1] += s.text
    } else {
      body.push(`**${s.speaker}** \`${hhmmss(s.offsetMs)}\`　${s.text}`)
      last = s.speaker
    }
  }
  const tail = doc.notes ? ['', '## 备注', '', doc.notes] : []
  return [...head, ...body, ...tail].join('\n')
}

/**
 * Build the request body for a finished (or in-progress) meeting.
 * Pure — no clock, no network — so the shape is testable on its own.
 */
function buildPayload(doc, { includeSegments = true, appVersion = '0.0.0', device = os.hostname(), platform = process.platform } = {}) {
  const segments = doc.segments || []
  const speakers = doc.speakers?.length
    ? doc.speakers
    : // Derive a speaker list from the turns when the meeting was recorded with
      // diarization off, so the field is never absent and consumers can rely on it.
      [...new Set(segments.map((s) => s.speaker))].map((label, i) => ({
        id: `S${i + 1}`, label, segments: segments.filter((s) => s.speaker === label).length, isOwner: label === '我',
      }))

  const chars = segments.reduce((n, s) => n + (s.text || '').length, 0)
  const speechMs = segments.reduce((n, s) => n + (s.durationMs || 0), 0)

  const payload = {
    event: EVENT,
    specVersion: SPEC_VERSION,
    id: doc.id,
    title: doc.title,
    startedAt: isoLocal(doc.startedAt),
    endedAt: doc.endedAt ? isoLocal(doc.endedAt) : null,
    durationMs: (doc.endedAt || doc.startedAt) - doc.startedAt,
    source: { app: 'kuaishuo', version: appVersion, platform, device },
    stats: {
      segments: segments.length,
      chars,
      words: segments.reduce((n, s) => n + (s.words || 0), 0) || undefined,
      speakers: speakers.length,
      speechMs,
    },
    speakers,
    transcript: {
      text: transcriptText(segments),
      markdown: transcriptMarkdown(doc, segments),
      ...(includeSegments
        ? {
            segments: segments.map((s) => ({
              i: s.i,
              speaker: s.speaker,
              offsetMs: s.offsetMs,
              durationMs: s.durationMs,
              at: isoLocal(s.at),
              // Present only for system audio, matching the live segment event.
              // Without it a receiver that correlates the two loses the
              // room/far-end distinction in the record it actually keeps.
              ...(s.source ? { source: s.source } : {}),
              text: s.text,
            })),
          }
        : {}),
    },
    notes: doc.notes || '',
  }
  if (payload.stats.words === undefined) delete payload.stats.words
  return payload
}

function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

// ---- Transport --------------------------------------------------------------

function postJson(url, body, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return reject(Object.assign(new Error(`bad webhook url: ${url}`), { permanent: true }))
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(Object.assign(new Error(`unsupported protocol ${target.protocol}`), { permanent: true }))
    }
    const client = target.protocol === 'https:' ? https : http
    const payload = Buffer.from(body, 'utf8')
    const req = client.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': payload.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000)
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, body: text })
          } else {
            // 4xx is us, not them: a wrong URL, a rejected signature, a payload
            // the endpoint refuses. Retrying can only reproduce it.
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)
            err.status = res.statusCode
            err.permanent = res.statusCode >= 400 && res.statusCode < 500
            err.body = text
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`webhook timeout after ${timeoutMs}ms`)))
    req.end(payload)
  })
}

/**
 * One delivery attempt. Returns a result record either way — callers store it
 * on the meeting doc so the console can show what happened and offer a retry.
 */
async function deliver(payload, { url, secret = '', headers = {}, deliveryId = null, appVersion = '0.0.0' } = {}) {
  const id = deliveryId || crypto.randomUUID()
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const h = {
    'user-agent': `kuaishuo/${appVersion}`,
    'x-kuaishuo-event': payload.event || EVENT,
    'x-kuaishuo-delivery': id,
    'x-kuaishuo-timestamp': String(timestamp),
    ...(secret ? { 'x-kuaishuo-signature': sign(secret, timestamp, body) } : {}),
    ...headers,
  }
  try {
    const res = await postJson(url, body, { headers: h })
    return { ok: true, deliveryId: id, at: Date.now(), status: res.status, response: res.body.slice(0, 500) }
  } catch (err) {
    return {
      ok: false,
      deliveryId: id,
      at: Date.now(),
      status: err.status || 0,
      permanent: !!err.permanent,
      error: err.message || String(err),
    }
  }
}

// ---- Outbox -----------------------------------------------------------------
// A meeting that ended on a train is the case this exists for: the push fails,
// the transcript is already safe on disk, and the delivery is owed. The outbox
// is that debt, written down.

function createOutbox({ dir, appVersion = '0.0.0', onResult = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'outbox.json')

  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
  }
  function save(items) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2))
    fs.renameSync(tmp, file)
  }

  let timer = null

  function enqueue(entry) {
    const items = load()
    items.push({
      deliveryId: entry.deliveryId || crypto.randomUUID(),
      meetingId: entry.meetingId,
      // Which endpoint this is owed to. Two different backends can both be
      // owed the same meeting — the legacy webhook and the project push — and
      // without this they would report through the same callback and overwrite
      // each other's status on the meeting doc. Absent means the legacy
      // webhook, so entries written before this existed still resolve.
      kind: entry.kind || 'webhook',
      url: entry.url,
      secret: entry.secret || '',
      headers: entry.headers || {},
      payload: entry.payload,
      attempts: entry.attempts || 0,
      nextAt: Date.now() + RETRY_DELAYS_MS[Math.min(entry.attempts || 0, RETRY_DELAYS_MS.length - 1)],
      lastError: entry.lastError || '',
    })
    save(items)
    return items[items.length - 1]
  }

  function list() { return load() }

  function remove(deliveryId) {
    const items = load().filter((i) => i.deliveryId !== deliveryId)
    save(items)
  }

  /** Attempt every entry that is due. Safe to call on a timer and on demand. */
  async function flush({ force = false } = {}) {
    const items = load()
    if (!items.length) return { attempted: 0, delivered: 0, dropped: 0 }
    const now = Date.now()
    let attempted = 0, delivered = 0, dropped = 0
    const keep = []
    for (const item of items) {
      if (!force && item.nextAt > now) { keep.push(item); continue }
      attempted++
      const res = await deliver(item.payload, {
        url: item.url, secret: item.secret, headers: item.headers,
        deliveryId: item.deliveryId, appVersion,
      })
      onResult(item.meetingId, res, item.kind || 'webhook')
      if (res.ok) { delivered++; continue }
      const attempts = item.attempts + 1
      // Give up after the last backoff step, or immediately on a 4xx. The
      // entry is dropped from the queue but the failure is recorded on the
      // meeting doc, so it shows in the console as "推送失败 · 重试" rather
      // than disappearing.
      if (res.permanent || attempts >= RETRY_DELAYS_MS.length) { dropped++; continue }
      keep.push({
        ...item,
        attempts,
        nextAt: Date.now() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)],
        lastError: res.error,
      })
    }
    save(keep)
    return { attempted, delivered, dropped, pending: keep.length }
  }

  function start(intervalMs = 60_000) {
    if (timer) return
    timer = setInterval(() => { flush().catch(() => {}) }, intervalMs)
    if (timer.unref) timer.unref()
  }
  function stop() { if (timer) { clearInterval(timer); timer = null } }

  return { enqueue, list, remove, flush, start, stop, file }
}

module.exports = {
  SPEC_VERSION, EVENT, RETRY_DELAYS_MS,
  buildPayload, transcriptText, transcriptMarkdown, isoLocal, hhmmss,
  sign, deliver, postJson, createOutbox,
}
