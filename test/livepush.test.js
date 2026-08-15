// The live per-sentence feed to the project backend.
//
// Two properties are worth more than the rest: sentences arrive in the order
// they were spoken, and a failing endpoint neither blocks nor corrupts the
// meeting. Both are easy to write code that appears to satisfy and doesn't.

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildSegmentPayload, withProject, createLiveSender } = require('../electron/livepush.cjs')

const DOC = {
  id: 'mt_1', title: '周会', startedAt: Date.UTC(2026, 7, 12, 2, 0, 0),
  projectId: 'p1', projectName: '快说', projectMeetingId: 'm1',
}
const SEG = { i: 3, at: Date.UTC(2026, 7, 12, 2, 1, 0), offsetMs: 60000, durationMs: 1800, speaker: '说话人1', text: '这版先不做灰度' }

describe('buildSegmentPayload', () => {
  test('carries the meeting, the project and the segment', () => {
    const p = buildSegmentPayload(DOC, SEG, { appVersion: '1.2.3', device: 'box', platform: 'win32' })
    assert.equal(p.event, 'meeting.segment')
    assert.equal(p.specVersion, '1.0')
    assert.equal(p.meeting.id, 'mt_1')
    assert.deepEqual(p.project, { id: 'p1', name: '快说', meetingId: 'm1' })
    assert.equal(p.segment.i, 3)
    assert.equal(p.segment.text, '这版先不做灰度')
    assert.equal(p.segment.speaker, '说话人1')
    assert.deepEqual(p.source, { app: 'kuaishuo', version: '1.2.3', platform: 'win32', device: 'box' })
  })

  test('timestamps are local-offset ISO, not UTC Z', () => {
    const p = buildSegmentPayload(DOC, SEG, {})
    assert.match(p.meeting.startedAt, /[+-]\d{2}:\d{2}$/)
    assert.match(p.segment.at, /[+-]\d{2}:\d{2}$/)
  })

  test('an unassigned meeting has NO project key at all', () => {
    // Not `project: null`. A receiver should be able to branch on the key's
    // presence — that is the documented shape for "no list endpoint configured".
    const p = buildSegmentPayload({ id: 'mt_2', title: '', startedAt: Date.now() }, SEG, {})
    assert.equal('project' in p, false)
  })

  test('the source tag rides along only when it is not the microphone', () => {
    const mic = buildSegmentPayload(DOC, SEG, {})
    assert.equal('source' in mic.segment, false)
    const sys = buildSegmentPayload(DOC, { ...SEG, source: 'system' }, {})
    assert.equal(sys.segment.source, 'system')
  })
})

describe('withProject', () => {
  test('adds the same block to an end-of-meeting payload', () => {
    const out = withProject({ event: 'meeting.completed', id: 'mt_1' }, DOC)
    assert.deepEqual(out.project, { id: 'p1', name: '快说', meetingId: 'm1' })
  })

  test('leaves an unassigned payload untouched', () => {
    const base = { event: 'meeting.completed' }
    assert.deepEqual(withProject(base, { id: 'x' }), base)
  })
})

const servers = []
function startServer(handler) {
  return new Promise((resolve) => {
    const received = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        received.push(JSON.parse(raw))
        handler(req, res, received.length)
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve({ received, url: `http://127.0.0.1:${server.address().port}/ingest` })
    })
  })
}
after(() => { for (const s of servers) { try { s.close() } catch {} } })

describe('createLiveSender', () => {
  test('delivers in the order spoken even when responses come back out of order', async () => {
    // The failure this guards: firing each sentence as it arrives, letting the
    // network decide the order, and producing a shuffled transcript. A slow
    // first response must hold the second sentence back.
    const { received, url } = await startServer((req, res, n) => {
      const delay = n === 1 ? 120 : 0    // first request answers last
      setTimeout(() => { res.writeHead(200); res.end('{}') }, delay)
    })
    const sender = createLiveSender({ delays: [] })
    for (let i = 0; i < 4; i++) sender.push(DOC, { ...SEG, i, text: `句子${i}` }, { url })
    await sender.flush()
    assert.deepEqual(received.map((p) => p.segment.i), [0, 1, 2, 3])
  })

  test('counts what landed', async () => {
    const { url } = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const sender = createLiveSender({ delays: [] })
    sender.push(DOC, SEG, { url })
    sender.push(DOC, SEG, { url })
    await sender.flush()
    assert.deepEqual(sender.statsOf('mt_1'), { sent: 2, failed: 0 })
  })

  test('retries a 5xx, then gives up and counts it — without blocking what follows', async () => {
    const { received, url } = await startServer((req, res, n) => {
      // Fail the first sentence every time; succeed for the second.
      if (received[n - 1].segment.i === 0) { res.writeHead(503); res.end('down') }
      else { res.writeHead(200); res.end('{}') }
    })
    const sender = createLiveSender({ delays: [1, 1] })
    sender.push(DOC, { ...SEG, i: 0 }, { url })
    sender.push(DOC, { ...SEG, i: 1 }, { url })
    await sender.flush()
    const s = sender.statsOf('mt_1')
    assert.equal(s.failed, 1)
    assert.equal(s.sent, 1, 'a dead sentence must not take the next one with it')
    // 3 attempts for the doomed one (initial + 2 retries), 1 for the good one.
    assert.equal(received.length, 4)
  })

  test('a 4xx is not retried — it would say the same thing next time', async () => {
    const { received, url } = await startServer((req, res) => { res.writeHead(400); res.end('bad') })
    const sender = createLiveSender({ delays: [1, 1] })
    sender.push(DOC, SEG, { url })
    await sender.flush()
    assert.equal(received.length, 1)
    assert.equal(sender.statsOf('mt_1').failed, 1)
  })

  test('a dead endpoint neither throws nor stalls the chain', async () => {
    const sender = createLiveSender({ delays: [] })
    sender.push(DOC, SEG, { url: 'http://127.0.0.1:1/ingest' })
    await sender.flush()
    assert.equal(sender.statsOf('mt_1').failed, 1)
  })

  test('reports per sentence, and a throwing reporter does not break the chain', async () => {
    const { url } = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    let calls = 0
    const sender = createLiveSender({
      delays: [],
      onResult: () => { calls++; throw new Error('a bug in the console') },
    })
    sender.push(DOC, SEG, { url })
    sender.push(DOC, SEG, { url })
    await sender.flush()
    assert.equal(calls, 2)
    assert.equal(sender.statsOf('mt_1').sent, 2)
  })

  test('stats are per meeting and forgettable', async () => {
    const { url } = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const sender = createLiveSender({ delays: [] })
    sender.push(DOC, SEG, { url })
    sender.push({ ...DOC, id: 'mt_2' }, SEG, { url })
    await sender.flush()
    assert.equal(sender.statsOf('mt_1').sent, 1)
    assert.equal(sender.statsOf('mt_2').sent, 1)
    sender.forget('mt_1')
    assert.deepEqual(sender.statsOf('mt_1'), { sent: 0, failed: 0 })
  })
})
