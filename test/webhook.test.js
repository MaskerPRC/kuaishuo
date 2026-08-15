// Webhook delivery, tested against a real HTTP server on a real socket.
//
// This is the app's public contract — somebody else's automation is going to be
// coded against the exact bytes this sends — so the assertions are about the
// wire format and the retry behaviour, not about whether the functions were
// called.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wh = require('../electron/webhook.cjs')

// ---- A meeting to send ------------------------------------------------------

const T0 = new Date('2026-08-09T15:30:12+08:00').getTime()

function sampleDoc() {
  return {
    id: 'mt_20260809_153012_001',
    title: '周会',
    startedAt: T0,
    endedAt: T0 + 2_548_000,
    notes: '张三下周休假',
    speakers: [
      { id: 'S1', label: '我', segments: 2, isOwner: true },
      { id: 'S2', label: '说话人1', segments: 1, isOwner: false },
    ],
    segments: [
      { i: 0, at: T0 + 1000, offsetMs: 1000, durationMs: 2400, speaker: '我', text: '我们先过一下上周的进展。' },
      { i: 1, at: T0 + 4000, offsetMs: 4000, durationMs: 1800, speaker: '我', text: '前端那边呢？' },
      { i: 2, at: T0 + 7000, offsetMs: 7000, durationMs: 3100, speaker: '说话人1', text: '还差两个页面。' },
    ],
  }
}

// ---- Payload ----------------------------------------------------------------

describe('buildPayload', () => {
  test('emits the documented top-level shape', () => {
    const p = wh.buildPayload(sampleDoc(), { appVersion: '1.2.3', device: 'TEST-PC', platform: 'win32' })
    assert.equal(p.event, 'meeting.completed')
    assert.equal(p.specVersion, '1.0')
    assert.equal(p.id, 'mt_20260809_153012_001')
    assert.equal(p.title, '周会')
    assert.equal(p.durationMs, 2_548_000)
    assert.deepEqual(p.source, { app: 'kuaishuo', version: '1.2.3', platform: 'win32', device: 'TEST-PC' })
    assert.equal(p.stats.segments, 3)
    assert.equal(p.stats.speakers, 2)
    assert.equal(p.stats.speechMs, 2400 + 1800 + 3100)
    assert.equal(p.notes, '张三下周休假')
  })

  test('timestamps are ISO 8601 with a local offset, not UTC', () => {
    const p = wh.buildPayload(sampleDoc())
    // A meeting is a wall-clock event; the offset has to survive the trip or the
    // downstream document says the wrong afternoon.
    assert.match(p.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    assert.equal(new Date(p.startedAt).getTime(), T0)
  })

  test('endedAt is null while a meeting is still running', () => {
    const doc = sampleDoc()
    doc.endedAt = null
    const p = wh.buildPayload(doc)
    assert.equal(p.endedAt, null)
    assert.equal(p.durationMs, 0)
  })

  test('segments can be omitted for a lighter body', () => {
    const full = wh.buildPayload(sampleDoc(), { includeSegments: true })
    const lite = wh.buildPayload(sampleDoc(), { includeSegments: false })
    assert.equal(full.transcript.segments.length, 3)
    assert.equal(lite.transcript.segments, undefined)
    // The readable forms are always there — that's what makes the light body
    // still useful to an LLM.
    assert.ok(lite.transcript.text.length > 0)
    assert.ok(lite.transcript.markdown.length > 0)
  })

  test('derives a speaker list when the meeting was recorded without one', () => {
    const doc = sampleDoc()
    doc.speakers = []
    const p = wh.buildPayload(doc)
    assert.equal(p.speakers.length, 2)
    assert.equal(p.speakers.find((s) => s.label === '我').segments, 2)
    assert.equal(p.speakers.find((s) => s.label === '我').isOwner, true)
  })

  test('survives an empty meeting', () => {
    const p = wh.buildPayload({ id: 'mt_empty', title: '空会议', startedAt: T0, endedAt: T0 + 1000, segments: [], speakers: [] })
    assert.equal(p.stats.segments, 0)
    assert.equal(p.transcript.text, '')
    assert.ok(p.transcript.markdown.includes('空会议'))
  })
})

describe('transcript rendering', () => {
  test('merges consecutive turns from one speaker', () => {
    const text = wh.transcriptText(sampleDoc().segments)
    const lines = text.split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0], '我：我们先过一下上周的进展。前端那边呢？')
    assert.equal(lines[1], '说话人1：还差两个页面。')
  })

  test('markdown keeps timestamps so quotes stay locatable', () => {
    const doc = sampleDoc()
    const md = wh.transcriptMarkdown(doc, doc.segments)
    assert.ok(md.startsWith('# 周会'))
    assert.ok(md.includes('`00:00:01`'))
    assert.ok(md.includes('**说话人1**'))
    assert.ok(md.includes('## 备注'))
    assert.ok(md.includes('张三下周休假'))
  })

  test('hhmmss pads and rolls over into hours', () => {
    assert.equal(wh.hhmmss(0), '00:00:00')
    assert.equal(wh.hhmmss(61_000), '00:01:01')
    assert.equal(wh.hhmmss(3_661_000), '01:01:01')
    assert.equal(wh.hhmmss(-5), '00:00:00')
  })
})

describe('signature', () => {
  test('binds the timestamp as well as the body', () => {
    const body = JSON.stringify({ a: 1 })
    const s1 = wh.sign('secret', 1000, body)
    const s2 = wh.sign('secret', 1001, body)
    assert.notEqual(s1, s2)
    assert.match(s1, /^sha256=[0-9a-f]{64}$/)
  })

  test('is reproducible by a receiver holding the same secret', () => {
    const body = JSON.stringify({ hello: '世界' })
    const ts = 1786000000
    const theirs = 'sha256=' + crypto.createHmac('sha256', 'shh').update(`${ts}.${body}`).digest('hex')
    assert.equal(wh.sign('shh', ts, body), theirs)
  })
})

// ---- Transport --------------------------------------------------------------

/** A server that records what it received and answers however the test says. */
function startServer(handler) {
  return new Promise((resolve) => {
    const received = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        received.push({ headers: req.headers, raw, body: JSON.parse(raw) })
        handler(req, res, received.length)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/hook` })
    })
  })
}

describe('deliver', () => {
  let ctx
  after(() => ctx?.server.close())

  test('posts the payload with the documented headers and verifies', async () => {
    ctx = await startServer((req, res) => { res.writeHead(200); res.end('ok') })
    const payload = wh.buildPayload(sampleDoc(), { appVersion: '9.9.9' })
    const res = await wh.deliver(payload, { url: ctx.url, secret: 'topsecret', appVersion: '9.9.9' })

    assert.equal(res.ok, true)
    assert.equal(res.status, 200)

    const got = ctx.received[0]
    assert.match(got.headers['content-type'], /application\/json/)
    assert.equal(got.headers['user-agent'], 'kuaishuo/9.9.9')
    assert.equal(got.headers['x-kuaishuo-event'], 'meeting.completed')
    assert.ok(got.headers['x-kuaishuo-delivery'])
    assert.equal(got.headers['x-kuaishuo-delivery'], res.deliveryId)

    // The receiver's half of the contract, run for real.
    const ts = got.headers['x-kuaishuo-timestamp']
    assert.equal(got.headers['x-kuaishuo-signature'], wh.sign('topsecret', ts, got.raw))

    // And the body survived the trip as UTF-8, which is the thing that breaks
    // when someone gets content-length wrong on Chinese text.
    assert.equal(got.body.transcript.text.split('\n')[0], '我：我们先过一下上周的进展。前端那边呢？')
  })

  test('omits the signature header when no secret is set', async () => {
    const s = await startServer((req, res) => { res.writeHead(204); res.end() })
    try {
      await wh.deliver(wh.buildPayload(sampleDoc()), { url: s.url })
      assert.equal(s.received[0].headers['x-kuaishuo-signature'], undefined)
    } finally { s.server.close() }
  })

  test('extra static headers are passed through', async () => {
    const s = await startServer((req, res) => { res.writeHead(200); res.end() })
    try {
      await wh.deliver(wh.buildPayload(sampleDoc()), { url: s.url, headers: { authorization: 'Bearer abc' } })
      assert.equal(s.received[0].headers.authorization, 'Bearer abc')
    } finally { s.server.close() }
  })

  test('4xx is permanent, 5xx is not', async () => {
    const s4 = await startServer((req, res) => { res.writeHead(401); res.end('nope') })
    const s5 = await startServer((req, res) => { res.writeHead(503); res.end('later') })
    try {
      const r4 = await wh.deliver(wh.buildPayload(sampleDoc()), { url: s4.url })
      assert.equal(r4.ok, false)
      assert.equal(r4.status, 401)
      assert.equal(r4.permanent, true)

      const r5 = await wh.deliver(wh.buildPayload(sampleDoc()), { url: s5.url })
      assert.equal(r5.ok, false)
      assert.equal(r5.permanent, false)
    } finally { s4.server.close(); s5.server.close() }
  })

  test('a dead endpoint fails without throwing', async () => {
    // Port 1 is reserved and nothing listens there.
    const r = await wh.deliver(wh.buildPayload(sampleDoc()), { url: 'http://127.0.0.1:1/hook' })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, false)
    assert.ok(r.error)
  })

  test('a malformed url is rejected as permanent', async () => {
    const r = await wh.deliver(wh.buildPayload(sampleDoc()), { url: 'not a url' })
    assert.equal(r.ok, false)
    assert.equal(r.permanent, true)
  })
})

// ---- Outbox -----------------------------------------------------------------

describe('outbox', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-outbox-')) })
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('a queued delivery goes out on the next flush and is then gone', async () => {
    const s = await startServer((req, res) => { res.writeHead(200); res.end('ok') })
    const results = []
    const box = wh.createOutbox({ dir, onResult: (id, r) => results.push([id, r.ok]) })
    try {
      box.enqueue({ meetingId: 'mt_1', url: s.url, payload: wh.buildPayload(sampleDoc()) })
      assert.equal(box.list().length, 1)

      const out = await box.flush({ force: true })
      assert.equal(out.attempted, 1)
      assert.equal(out.delivered, 1)
      assert.equal(box.list().length, 0)
      assert.deepEqual(results, [['mt_1', true]])
      assert.equal(s.received.length, 1)
    } finally { s.server.close() }
  })

  test('a 5xx keeps the entry and backs off; the retry uses the same delivery id', async () => {
    let calls = 0
    const s = await startServer((req, res) => {
      calls++
      if (calls === 1) { res.writeHead(500); res.end('boom') }
      else { res.writeHead(200); res.end('ok') }
    })
    const box = wh.createOutbox({ dir })
    try {
      box.enqueue({ meetingId: 'mt_2', url: s.url, payload: wh.buildPayload(sampleDoc()) })
      await box.flush({ force: true })

      const [pending] = box.list()
      assert.ok(pending, 'the failed delivery is still owed')
      assert.equal(pending.attempts, 1)
      assert.ok(pending.nextAt > Date.now(), 'backoff pushes the next attempt into the future')
      assert.match(pending.lastError, /500/)

      await box.flush({ force: true })
      assert.equal(box.list().length, 0)
      // Same id both times: the receiver can deduplicate a retry it already
      // processed but failed to acknowledge.
      assert.equal(s.received[0].headers['x-kuaishuo-delivery'], s.received[1].headers['x-kuaishuo-delivery'])
    } finally { s.server.close() }
  })

  test('a 4xx is dropped immediately rather than retried forever', async () => {
    const s = await startServer((req, res) => { res.writeHead(422); res.end('bad payload') })
    const box = wh.createOutbox({ dir })
    try {
      box.enqueue({ meetingId: 'mt_3', url: s.url, payload: wh.buildPayload(sampleDoc()) })
      const out = await box.flush({ force: true })
      assert.equal(out.dropped, 1)
      assert.equal(box.list().length, 0)
    } finally { s.server.close() }
  })

  test('entries survive a restart of the queue', async () => {
    const box = wh.createOutbox({ dir })
    box.enqueue({ meetingId: 'mt_4', url: 'http://127.0.0.1:1/x', payload: { event: 'x' } })
    const reopened = wh.createOutbox({ dir })
    assert.ok(reopened.list().some((i) => i.meetingId === 'mt_4'))
    reopened.remove(reopened.list().find((i) => i.meetingId === 'mt_4').deliveryId)
    assert.ok(!wh.createOutbox({ dir }).list().some((i) => i.meetingId === 'mt_4'))
  })

  test('entries that are not due yet are left alone', async () => {
    const box = wh.createOutbox({ dir })
    box.enqueue({ meetingId: 'mt_5', url: 'http://127.0.0.1:1/x', payload: { event: 'x' } })
    const out = await box.flush()   // not forced
    assert.equal(out.attempted, 0)
    assert.equal(box.list().length, 1)
    box.remove(box.list()[0].deliveryId)
  })
})

// Two different backends can be owed the same meeting: the legacy webhook and
// the project push endpoint. They report through one callback, so without a
// discriminator the second result overwrites the first on the meeting doc and
// one of the two appears never to have been attempted.
describe('outbox delivery kinds', () => {
  let dir
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-kind-')) })
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('the kind is carried through to onResult', async () => {
    const s = await startServer((req, res) => { res.writeHead(200); res.end('ok') })
    const seen = []
    const box = wh.createOutbox({ dir, onResult: (id, r, kind) => seen.push(kind) })
    try {
      box.enqueue({ meetingId: 'mt_1', kind: 'project', url: s.url, payload: wh.buildPayload(sampleDoc()) })
      box.enqueue({ meetingId: 'mt_1', url: s.url, payload: wh.buildPayload(sampleDoc()) })
      await box.flush({ force: true })
      // Same meeting, two entries, distinguishable — and the one that did not
      // ask for a kind still resolves to the legacy webhook.
      assert.deepEqual(seen, ['project', 'webhook'])
    } finally { s.server.close() }
  })
})

describe('segment source in the completed record', () => {
  test('rides along for system audio and is absent for the microphone', () => {
    // Must match the live meeting.segment event, or a backend correlating the
    // two loses the room/far-end distinction in the record it keeps.
    const doc = sampleDoc()
    doc.segments = [
      { i: 0, at: Date.now(), offsetMs: 0, durationMs: 1000, speaker: '我', text: '本地' },
      { i: 1, at: Date.now(), offsetMs: 2000, durationMs: 1000, speaker: '说话人1', text: '远端', source: 'system' },
    ]
    const segs = wh.buildPayload(doc).transcript.segments
    assert.equal('source' in segs[0], false)
    assert.equal(segs[1].source, 'system')
  })
})
