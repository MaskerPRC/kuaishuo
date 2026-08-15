// The commit path — what happens to a sentence between the recogniser and the
// user's document. Runs the real pipeline.cjs over a real store in a temp dir,
// with a recording stub in place of the OS keyboard.
//
// These are the decisions that are expensive to get wrong: typing someone
// else's words into a document, or typing an hour of a meeting into whatever
// window happened to be focused.

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStore } = require('../electron/store.cjs')
const { createPipeline } = require('../electron/pipeline.cjs')
const { l2norm } = require('../electron/diarize.cjs')

const DIM = 192
const vec = (n) => l2norm(Array.from({ length: DIM }, (_, i) => Math.sin((i + 1) * (n + 1) * 0.7331)))
const near = (n, mix, seed) => {
  const b = vec(n)
  const e = l2norm(Array.from({ length: DIM }, (_, i) => Math.cos((i + 1) * seed * 2.113 + seed)))
  return l2norm(b.map((x, i) => x + mix * e[i]))
}

let dir, store, pipeline, sent, events

function build(settings = {}) {
  store = createStore({ dir })
  store.resetSettings()
  store.setSettings(settings)
  // One temp dir for the file, so each case starts from an empty log —
  // otherwise the history and the stats totals carry over between tests.
  store.clearHistory()
  sent = []
  events = { history: [], meeting: [] }
  pipeline = createPipeline({
    store,
    // Stands in for inject.sendText. Records rather than types.
    sendText: async (text, opts) => {
      sent.push({ text, opts })
      return { ok: true, mode: opts.mode, chars: text.length, target: 'TestApp' }
    },
    onHistory: (e) => events.history.push(e),
    onMeeting: (e) => events.meeting.push(e),
  })
}

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-pipe-')) })
after(() => { try { store?.close() } catch {}; try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
beforeEach(() => { try { store?.close() } catch {} })

describe('dictation', () => {
  test('types the text and records it', async () => {
    build({ outputMode: 'type' })
    const r = await pipeline.commit({ text: '把这段重构一下', durationMs: 1500, decodeMs: 120 })

    assert.equal(r.accepted, true)
    assert.equal(r.mode, 'dictation')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, '把这段重构一下')
    assert.equal(sent[0].opts.mode, 'type')

    const [entry] = store.listHistory({}).items
    assert.equal(entry.text, '把这段重构一下')
    assert.equal(entry.output, 'type')
    assert.equal(entry.app, 'TestApp')
    assert.equal(events.history.length, 1)
  })

  test('passes the output settings straight through', async () => {
    build({ outputMode: 'clipboard', pressEnterAfterType: true, appendSpace: true, restoreClipboard: false })
    await pipeline.commit({ text: 'hello' })
    assert.deepEqual(sent[0].opts, { mode: 'clipboard', enter: true, restoreClipboard: false, appendSpace: true })
  })

  test('empty text is a no-op, not an empty history row', async () => {
    build()
    const r = await pipeline.commit({ text: '   ' })
    assert.equal(r.accepted, false)
    assert.equal(r.reason, 'empty')
    assert.equal(sent.length, 0)
    assert.equal(store.listHistory({}).total, 0)
  })

  test('an injection failure is still recorded, flagged as failed', async () => {
    build({ outputMode: 'type' })
    // Rebuild with a sendText that throws the way a broken FFI would.
    pipeline = createPipeline({
      store,
      sendText: async () => { throw new Error('user32 unavailable') },
      onHistory: (e) => events.history.push(e),
    })
    const r = await pipeline.commit({ text: '这句没送出去' })
    assert.equal(r.accepted, true)          // it was recognised; the loss was downstream
    assert.equal(r.output.ok, false)
    assert.equal(store.listHistory({}).items[0].output, 'failed')
  })
})

describe('voiceprint gate', () => {
  const owner = vec(0)

  test('accepts the enrolled speaker', async () => {
    build({ voiceprintEnabled: true, voiceprint: owner, voiceprintThreshold: 0.5 })
    const r = await pipeline.commit({ text: '这是我说的', embedding: near(0, 0.2, 3) })
    assert.equal(r.accepted, true)
    assert.equal(sent.length, 1)
  })

  test('rejects a different voice without typing anything', async () => {
    build({ voiceprintEnabled: true, voiceprint: owner, voiceprintThreshold: 0.5 })
    const r = await pipeline.commit({ text: '这是电视里说的', embedding: vec(5) })
    assert.equal(r.accepted, false)
    assert.equal(r.reason, 'voiceprint')
    assert.equal(sent.length, 0, 'nothing may reach the keyboard')
    // Recorded so the stats page can explain the silence.
    const [entry] = store.listHistory({}).items
    assert.equal(entry.rejected, true)
    assert.equal(entry.text, '这是电视里说的')
    // …and excluded from the totals.
    assert.equal(store.stats({}).total.count, 0)
    assert.equal(store.stats({}).total.rejected, 1)
  })

  test('rejects when the gate is on but no embedding was computed', async () => {
    // Fail closed. An embedding that didn't arrive is not evidence of identity.
    build({ voiceprintEnabled: true, voiceprint: owner })
    const r = await pipeline.commit({ text: '来路不明的一句', embedding: null })
    assert.equal(r.accepted, false)
    assert.equal(sent.length, 0)
  })

  test('is off when no voiceprint has been enrolled, whatever the flag says', async () => {
    build({ voiceprintEnabled: true, voiceprint: null })
    const r = await pipeline.commit({ text: '没登记声纹也该能用', embedding: vec(7) })
    assert.equal(r.accepted, true)
    assert.equal(sent.length, 1)
  })

  test('a higher threshold rejects what a lower one accepts', async () => {
    build({ voiceprintEnabled: true, voiceprint: owner, voiceprintThreshold: 0.99 })
    assert.equal((await pipeline.commit({ text: '边缘情况', embedding: near(0, 0.5, 5) })).accepted, false)
    store.setSettings({ voiceprintThreshold: 0.4 })
    assert.equal((await pipeline.commit({ text: '边缘情况', embedding: near(0, 0.5, 5) })).accepted, true)
  })
})

describe('meeting mode', () => {
  test('transcribes without typing anything into the focused app', async () => {
    build({ outputMode: 'type' })
    const doc = pipeline.startMeeting({ title: '周会' })
    await pipeline.commit({ text: '我们先过进展', durationMs: 2000 })
    await pipeline.commit({ text: '前端还差两个页面', durationMs: 2600 })

    assert.equal(sent.length, 0, 'a meeting must never reach the keyboard')
    const saved = store.getMeeting(doc.id)
    assert.equal(saved.segments.length, 2)
    assert.equal(saved.segments[1].text, '前端还差两个页面')
    // Still in the history, tagged, so it is searchable alongside everything else.
    assert.equal(store.listHistory({ mode: 'meeting' }).total, 2)
  })

  test('labels speakers and keeps the owner as 我', async () => {
    build({ meetingDiarize: true, voiceprint: vec(0), voiceprintThreshold: 0.5 })
    const doc = pipeline.startMeeting({})
    await pipeline.commit({ text: '我先说', embedding: near(0, 0.2, 1) })
    await pipeline.commit({ text: '我补充一句', embedding: vec(5) })
    await pipeline.commit({ text: '我也说两句', embedding: vec(9) })
    await pipeline.commit({ text: '回到我', embedding: near(0, 0.2, 4) })

    const saved = store.getMeeting(doc.id)
    assert.deepEqual(saved.segments.map((s) => s.speaker), ['我', '说话人1', '说话人2', '我'])
    assert.equal(saved.speakers.length, 3)
    assert.equal(saved.speakers.find((s) => s.isOwner).segments, 2)
  })

  test('the voiceprint gate is bypassed so other people are captured', async () => {
    build({ voiceprintEnabled: true, voiceprint: vec(0), meetingBypassVoiceprint: true, meetingDiarize: true })
    pipeline.startMeeting({})
    const r = await pipeline.commit({ text: '同事说的话', embedding: vec(5) })
    assert.equal(r.accepted, true)
    assert.equal(r.speaker, '说话人1')
  })

  test('…unless the user asks for the gate to stay on', async () => {
    build({ voiceprintEnabled: true, voiceprint: vec(0), meetingBypassVoiceprint: false })
    pipeline.startMeeting({})
    const r = await pipeline.commit({ text: '同事说的话', embedding: vec(5) })
    assert.equal(r.accepted, false)
    assert.equal(r.reason, 'voiceprint')
  })

  test('with diarization off everything is attributed to 我', async () => {
    build({ meetingDiarize: false })
    const doc = pipeline.startMeeting({})
    await pipeline.commit({ text: 'a句', embedding: vec(0) })
    await pipeline.commit({ text: 'b句', embedding: vec(5) })
    const saved = store.getMeeting(doc.id)
    assert.deepEqual(saved.segments.map((s) => s.speaker), ['我', '我'])
    assert.equal(saved.speakers.length, 1)
  })

  test('starting twice keeps the same meeting', async () => {
    build()
    const a = pipeline.startMeeting({ title: '第一次' })
    const b = pipeline.startMeeting({ title: '第二次' })
    assert.equal(a.id, b.id)
    assert.equal(b.title, '第一次')
  })

  test('stopping ends it and returns dictation to normal', async () => {
    build({ outputMode: 'type' })
    const doc = pipeline.startMeeting({})
    await pipeline.commit({ text: '会里说的' })
    const ended = pipeline.stopMeeting()

    assert.equal(ended.id, doc.id)
    assert.equal(ended.status, 'ended')
    assert.equal(pipeline.currentMeeting(), null)

    await pipeline.commit({ text: '会后说的' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].text, '会后说的')
  })

  test('stopping when nothing is recording is harmless', () => {
    build()
    assert.equal(pipeline.stopMeeting(), null)
  })

  test('emits start / segment / end events for the UI', async () => {
    build()
    const doc = pipeline.startMeeting({})
    await pipeline.commit({ text: '一句' })
    pipeline.stopMeeting()
    assert.equal(events.meeting[0].started, true)
    assert.ok(events.meeting[1].segment)
    assert.equal(events.meeting[2].ended, true)
    assert.ok(events.meeting.every((e) => e.id === doc.id))
  })
})

// System audio: the far end of a call, captured from the machine's own output
// rather than through the microphone. It exists only inside a meeting, and the
// two things that must never happen are it being typed into a document and it
// being attributed to the user.
describe('system audio', () => {
  test('is never injected, even if a meeting ended while it was decoding', async () => {
    // The realistic route in: an utterance endpoints, the user stops the
    // meeting, and the decode lands a second later. If this reached sendText,
    // a video playing in the background would type itself into whatever
    // document happened to be focused.
    build({ outputMode: 'type' })
    const r = await pipeline.commit({ text: '视频里的一句话', source: 'system' })
    assert.equal(r.accepted, false)
    assert.equal(r.reason, 'system-no-meeting')
    assert.equal(sent.length, 0)
    assert.equal(store.listHistory({}).total, 0, 'and it belongs to no transcript')
  })

  test('a microphone utterance with no meeting is still typed', async () => {
    // The guard above must be about the source, not about meetings in general.
    build({ outputMode: 'type' })
    const r = await pipeline.commit({ text: '这句要打出来', source: 'mic' })
    assert.equal(r.accepted, true)
    assert.equal(sent.length, 1)
  })

  test('in a meeting it is transcribed but never labelled 我', async () => {
    build({ meetingDiarize: true, voiceprint: vec(0), voiceprintThreshold: 0.5 })
    pipeline.startMeeting({})
    // Deliberately the enrolled voice: the far end sounding like you must not
    // be enough to attribute it to you.
    const r = await pipeline.commit({ text: '对方在说话', source: 'system', embedding: near(0, 0.12, 3) })
    assert.equal(r.accepted, true)
    assert.notEqual(r.speaker, '我')
  })

  test('with diarization off it is still not 我', async () => {
    // The easy one to miss: that branch used to be a hardcoded 我 for every
    // utterance, which would have labelled the whole remote call as the user.
    build({ meetingDiarize: false })
    pipeline.startMeeting({})
    await pipeline.commit({ text: '我这边', source: 'mic' })
    const r = await pipeline.commit({ text: '对方那边', source: 'system' })
    assert.notEqual(r.speaker, '我')

    const doc = pipeline.currentMeeting()
    assert.deepEqual(doc.speakers.map((sp) => sp.label).sort(), ['对方', '我'])
    assert.equal(doc.speakers.find((sp) => sp.label === '我').segments, 1)
  })

  test('the segment records which side it came from', async () => {
    build()
    pipeline.startMeeting({})
    await pipeline.commit({ text: '本地', source: 'mic' })
    await pipeline.commit({ text: '远端', source: 'system' })
    const segs = pipeline.currentMeeting().segments
    // Absent for the microphone, so transcripts recorded before system audio
    // existed still read as exactly what they were.
    assert.equal(segs[0].source, undefined)
    assert.equal(segs[1].source, 'system')
  })
})

// Filing a recording under a project. The id has to survive from the start
// call all the way to the list projection — there are three whitelists between
// those two points and any of them silently drops an unknown field.
describe('project binding', () => {
  test('startMeeting carries the project onto the doc', () => {
    build()
    const doc = pipeline.startMeeting({ projectId: 'p1', projectName: '快说', projectMeetingId: 'm1' })
    assert.equal(doc.projectId, 'p1')
    assert.equal(doc.projectName, '快说')
    assert.equal(doc.projectMeetingId, 'm1')
    assert.deepEqual(doc.livePush, { sent: 0, failed: 0 })
  })

  test('and it reaches the list projection', () => {
    // store.listMeetings builds each row field-by-field, so a doc field that
    // isn't named there never reaches the console.
    build()
    pipeline.startMeeting({ projectId: 'p9', projectName: '九号项目' })
    pipeline.stopMeeting()
    const row = store.listMeetings({}).find((m) => m.projectId === 'p9')
    assert.ok(row, 'the meeting should be in the list')
    assert.equal(row.projectName, '九号项目')
  })

  test('an unassigned meeting is still perfectly valid', () => {
    build()
    const doc = pipeline.startMeeting({})
    assert.equal(doc.projectId, '')
    assert.equal(store.listMeetings({})[0].projectId, '')
  })

  test('the segment event carries what the live push needs', async () => {
    // main hooks the live feed onto onMeeting, so the segment has to arrive
    // there complete — this is the contract that wiring depends on.
    build()
    const doc = pipeline.startMeeting({ projectId: 'p1' })
    await pipeline.commit({ text: '一句话', source: 'system' })
    const ev = events.meeting.find((e) => e.segment)
    assert.equal(ev.id, doc.id)
    assert.equal(ev.segment.text, '一句话')
    assert.equal(ev.segment.source, 'system')
    assert.equal(typeof ev.segment.offsetMs, 'number')
  })
})
