// End to end, minus Electron: a real store, the real pipeline, the real live
// sender, and two real HTTP servers standing in for a project backend.
//
// The pieces are each tested on their own elsewhere. What this file checks is
// the composition — main.cjs wires pipeline.onMeeting into the live sender and
// reads the project off the meeting doc, and every one of those hops passes
// through a whitelist that silently drops unknown fields. A projectId that is
// accepted by startMeeting and absent from the POST body is exactly the kind of
// bug that unit tests on both sides can miss.

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStore } = require('../electron/store.cjs')
const { createPipeline } = require('../electron/pipeline.cjs')
const { createLiveSender, withProject } = require('../electron/livepush.cjs')
const { fetchProjects } = require('../electron/projects.cjs')
const wh = require('../electron/webhook.cjs')

let dir
const servers = []

function startServer(handler) {
  return new Promise((resolve) => {
    const received = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        received.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
        handler(req, res, received.length)
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ received, url: `http://127.0.0.1:${server.address().port}/x` }))
  })
}

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-flow-')) })
after(() => {
  for (const s of servers) { try { s.close() } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

/**
 * Everything main.cjs does to connect a meeting to the project endpoint,
 * assembled the same way. If this drifts from main.cjs the test stops meaning
 * anything, so it is deliberately short enough to compare by eye.
 */
function wire(pushUrl) {
  const store = createStore({ dir })
  store.resetSettings()
  store.clearHistory()
  store.setSettings({ projectPushEnabled: true, projectPushUrl: pushUrl, outputMode: 'none' })

  const sender = createLiveSender({ appVersion: '9.9.9', delays: [] })
  const pipeline = createPipeline({
    store,
    sendText: async () => ({ ok: true, mode: 'none', chars: 0 }),
    onMeeting: (event) => {
      if (!event?.segment || !event.id) return
      const s = store.getSettings()
      if (!s.projectPushEnabled || !s.projectPushUrl) return
      const doc = store.getMeeting(event.id)
      if (doc) sender.push(doc, event.segment, { url: s.projectPushUrl })
    },
  })
  return { store, pipeline, sender }
}

beforeEach(() => { /* each test builds its own store over the same dir */ })

describe('project flow', () => {
  test('a filed meeting pushes every sentence with its project id, in order', async () => {
    const push = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const { store, pipeline, sender } = wire(push.url)

    // What the picker would have handed back after mapping the list response.
    const doc = pipeline.startMeeting({ projectId: 'p1', projectName: '快说', projectMeetingId: 'm1' })
    for (const t of ['第一句', '第二句', '第三句']) await pipeline.commit({ text: t, source: 'mic' })
    await sender.flush()

    assert.equal(push.received.length, 3)
    assert.deepEqual(push.received.map((r) => r.body.segment.text), ['第一句', '第二句', '第三句'])
    for (const r of push.received) {
      assert.equal(r.body.event, 'meeting.segment')
      assert.deepEqual(r.body.project, { id: 'p1', name: '快说', meetingId: 'm1' })
      assert.equal(r.body.meeting.id, doc.id)
      assert.equal(r.headers['x-kuaishuo-event'], 'meeting.segment')
    }
    // And the count is on the doc, so the console can show a failing feed.
    assert.equal(sender.statsOf(doc.id).sent, 3)
    store.close()
  })

  test('an unfiled meeting pushes the same events with no project block', async () => {
    // The documented fallback: no list endpoint configured, so the backend
    // receives everything undifferentiated rather than nothing at all.
    const push = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const { store, pipeline, sender } = wire(push.url)

    pipeline.startMeeting({})
    await pipeline.commit({ text: '无归属的一句' })
    await sender.flush()

    assert.equal(push.received.length, 1)
    assert.equal('project' in push.received[0].body, false)
    assert.equal(push.received[0].body.segment.text, '无归属的一句')
    store.close()
  })

  test('the end-of-meeting record carries the same project block', async () => {
    const push = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const { store, pipeline } = wire(push.url)

    pipeline.startMeeting({ projectId: 'p2', projectName: '项目二' })
    await pipeline.commit({ text: '一句话' })
    const ended = pipeline.stopMeeting()

    const payload = withProject(wh.buildPayload(store.getMeeting(ended.id), { appVersion: '9.9.9' }), store.getMeeting(ended.id))
    const res = await wh.deliver(payload, { url: push.url, appVersion: '9.9.9' })
    assert.equal(res.ok, true)

    const last = push.received[push.received.length - 1].body
    assert.equal(last.event, 'meeting.completed')
    assert.equal(last.project.id, 'p2')
    // Same shape as the legacy webhook, so a backend can share the parser.
    assert.equal(last.specVersion, '1.0')
    assert.ok(last.transcript.text.includes('一句话'))
    store.close()
  })

  test('a dead push endpoint costs nothing but the push', async () => {
    // The transcript is the product; the feed is a convenience on top of it.
    const { store, pipeline, sender } = wire('http://127.0.0.1:1/dead')
    const doc = pipeline.startMeeting({ projectId: 'p3' })
    await pipeline.commit({ text: '后端挂了也要记下来' })
    await sender.flush()

    assert.equal(sender.statsOf(doc.id).failed, 1)
    const saved = store.getMeeting(doc.id)
    assert.equal(saved.segments.length, 1, 'the transcript is untouched by a failed push')
    assert.equal(saved.segments[0].text, '后端挂了也要记下来')
    assert.equal(store.listHistory({}).total, 1)
    store.close()
  })

  test('the list response a picker sees round-trips into a filed meeting', async () => {
    // The full arc: someone else's nested JSON → mapping → picker item →
    // startMeeting → the id in the POST body.
    const list = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        code: 0,
        data: { list: [{ meetingId: 'm7', meetingName: '周会', project: { id: 'p7', name: '七号项目' } }] },
      }))
    })
    const picked = await fetchProjects({
      url: list.url, itemsPath: 'data.list', idField: 'meetingId',
      nameField: 'meetingName', projectIdField: 'project.id', groupField: 'project.name',
    })
    assert.equal(picked.items.length, 1)

    const push = await startServer((req, res) => { res.writeHead(200); res.end('{}') })
    const { store, pipeline, sender } = wire(push.url)
    const it = picked.items[0]
    pipeline.startMeeting({ projectId: it.projectId, projectName: it.name, projectMeetingId: it.id })
    await pipeline.commit({ text: '开始吧' })
    await sender.flush()

    assert.deepEqual(push.received[0].body.project, { id: 'p7', name: '周会', meetingId: 'm7' })
    store.close()
  })
})
