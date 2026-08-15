// The durability claim ("nothing you said can be lost") is the one thing in
// this app that a user cannot verify for themselves until it has already
// failed, so it gets tested against a real filesystem — temp dirs, real fds,
// a store reopened from scratch — rather than against a mock of one.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStore, countWords, dayKey } = require('../electron/store.cjs')

let dir
const stores = []

function freshStore() {
  const s = createStore({ dir })
  stores.push(s)
  return s
}

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-test-')) })
after(() => {
  for (const s of stores) { try { s.close() } catch {} }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('countWords', () => {
  test('counts CJK per character and Latin per run', () => {
    assert.equal(countWords('你好世界'), 4)
    assert.equal(countWords('hello world'), 2)
    assert.equal(countWords('把 pull request 合掉'), 5)   // 把+合+掉 = 3, pull, request = 2
    assert.equal(countWords(''), 0)
    assert.equal(countWords('，。！'), 0)
  })
})

describe('settings', () => {
  test('defaults are present and a patch merges over them', () => {
    const s = freshStore()
    const initial = s.getSettings()
    assert.equal(initial.outputMode, 'type')
    assert.equal(initial.voiceprintEnabled, false)
    // On by default — a meeting transcript missing the remote half of the call
    // is the failure this exists to fix.
    assert.equal(initial.systemAudioInMeetings, true)

    s.setSettings({ outputMode: 'clipboard', asrSilenceMs: 1200 })
    const after = s.getSettings()
    assert.equal(after.outputMode, 'clipboard')
    assert.equal(after.asrSilenceMs, 1200)
    // Untouched keys survive a partial patch.
    assert.equal(after.asrSensitivity, 'medium')
  })

  test('survives a full reopen', () => {
    freshStore().setSettings({ webhookUrl: 'https://example.com/hook' })
    assert.equal(freshStore().getSettings().webhookUrl, 'https://example.com/hook')
  })

  test('reset restores defaults', () => {
    const s = freshStore()
    s.setSettings({ outputMode: 'none', systemAudioInMeetings: false })
    const after = s.resetSettings()
    assert.equal(after.outputMode, 'type')
    assert.equal(after.systemAudioInMeetings, true)
  })
})

describe('history durability', () => {
  test('entries written by one store are readable by a fresh one', () => {
    const a = freshStore()
    a.addHistory({ text: '第一句话', durationMs: 1200, decodeMs: 90 })
    a.addHistory({ text: '第二句话', durationMs: 900, decodeMs: 70 })
    // No close(), no flush — this is the crash case: the process simply stops
    // existing. fs.writeSync has already reached the OS, so a new reader sees
    // both lines.
    const b = freshStore()
    const { items, total } = b.listHistory({})
    assert.equal(total, 2)
    assert.equal(items[0].text, '第二句话')   // newest first
    assert.equal(items[1].text, '第一句话')
  })

  test('a torn trailing line costs only that entry', () => {
    const s = freshStore()
    s.addHistory({ text: '完整的一句' })
    s.close()
    // Simulate a kill mid-write: half a JSON object with no newline.
    fs.appendFileSync(path.join(dir, 'history.jsonl'), '{"id":"u_broken","text":"半句')
    const { items } = freshStore().listHistory({})
    assert.ok(items.some((e) => e.text === '完整的一句'))
    assert.ok(!items.some((e) => e.id === 'u_broken'))
  })

  test('entries carry computed chars/words and the requested metadata', () => {
    const s = freshStore()
    const e = s.addHistory({ text: 'hello 世界', mode: 'dictation', output: 'type', app: 'Notepad' })
    assert.equal(e.chars, 8)
    assert.equal(e.words, 3)
    assert.equal(e.output, 'type')
    assert.equal(e.app, 'Notepad')
    assert.ok(e.id.startsWith('u_'))
  })
})

describe('history queries', () => {
  let s
  before(() => {
    s = freshStore()
    s.clearHistory()
    s.addHistory({ text: '开个会讨论排期', mode: 'meeting', meetingId: 'mt_1', speaker: '我' })
    s.addHistory({ text: '把这段代码重构一下', mode: 'dictation' })
    s.addHistory({ text: '记得买牛奶', mode: 'dictation' })
  })

  test('filters by mode', () => {
    assert.equal(s.listHistory({ mode: 'meeting' }).total, 1)
    assert.equal(s.listHistory({ mode: 'dictation' }).total, 2)
  })

  test('filters by substring', () => {
    const r = s.listHistory({ query: '牛奶' })
    assert.equal(r.total, 1)
    assert.equal(r.items[0].text, '记得买牛奶')
  })

  test('filters by meeting', () => {
    assert.equal(s.listHistory({ meetingId: 'mt_1' }).total, 1)
  })

  test('paginates', () => {
    const page = s.listHistory({ limit: 2, offset: 0 })
    assert.equal(page.items.length, 2)
    assert.equal(page.total, 3)
    assert.equal(s.listHistory({ limit: 2, offset: 2 }).items.length, 1)
  })

  test('delete removes exactly one and the rest survive a reopen', () => {
    const target = s.listHistory({ query: '牛奶' }).items[0]
    assert.equal(s.deleteHistory(target.id), true)
    assert.equal(s.deleteHistory(target.id), false)
    assert.equal(freshStore().listHistory({}).total, 2)
  })
})

describe('stats', () => {
  test('aggregates, excludes rejects, and fills empty days', () => {
    const s = freshStore()
    s.clearHistory()
    const now = Date.now()
    s.addHistory({ text: '一二三四五', at: now, durationMs: 2000, decodeMs: 100 })
    s.addHistory({ text: 'abc def', at: now, durationMs: 1000, decodeMs: 50 })
    s.addHistory({ text: '这是别人说的', at: now, rejected: true })
    s.addHistory({ text: '会议里的一句', at: now, mode: 'meeting', meetingId: 'mt_x' })

    const st = s.stats({ days: 7 })
    assert.equal(st.total.count, 3)           // the rejected one is not counted
    assert.equal(st.total.rejected, 1)
    assert.equal(st.total.chars, 5 + 7 + 6)
    assert.equal(st.total.audioMs, 3000)
    assert.equal(st.meeting.count, 1)
    // 3000ms of audio decoded in 150ms
    assert.equal(st.avg.realtimeFactor, 20)
    assert.equal(st.series.length, 7)
    assert.equal(st.series[6].day, dayKey(now))
    assert.equal(st.series[6].count, 3)
    assert.equal(st.series[0].count, 0)       // gap-filled, not omitted
    assert.equal(st.byHour[new Date(now).getHours()], 3)
  })

  test('is safe on an empty history', () => {
    const s = freshStore()
    s.clearHistory()
    const st = s.stats({ days: 3 })
    assert.equal(st.total.count, 0)
    assert.equal(st.avg.realtimeFactor, 0)
    assert.equal(st.series.length, 3)
    assert.equal(st.firstAt, null)
  })
})

describe('meetings', () => {
  test('records segments with offsets and ends cleanly', () => {
    const s = freshStore()
    const started = Date.now()
    const doc = s.createMeeting({ title: '排期会', at: started })
    assert.equal(doc.status, 'recording')

    s.addSegment(doc.id, { at: started + 1000, durationMs: 900, speaker: '我', text: '我们先过进展' })
    s.addSegment(doc.id, { at: started + 4000, durationMs: 1400, speaker: '说话人1', text: '前端还差两个页面' })

    const loaded = s.getMeeting(doc.id)
    assert.equal(loaded.segments.length, 2)
    assert.equal(loaded.segments[0].offsetMs, 1000)
    assert.equal(loaded.segments[1].i, 1)
    assert.equal(loaded.segments[1].speaker, '说话人1')

    const ended = s.endMeeting(doc.id, { at: started + 60_000 })
    assert.equal(ended.status, 'ended')
    assert.equal(ended.endedAt - ended.startedAt, 60_000)
  })

  test('segments survive a reopen mid-meeting', () => {
    const a = freshStore()
    const doc = a.createMeeting({ title: '中途崩溃' })
    a.addSegment(doc.id, { text: '崩之前说的话' })
    const b = freshStore()
    assert.equal(b.getMeeting(doc.id).segments[0].text, '崩之前说的话')
  })

  test('list summarises and delete removes from the index', () => {
    const s = freshStore()
    const doc = s.createMeeting({ title: '要删掉的会' })
    s.addSegment(doc.id, { text: '一句话' })
    assert.ok(s.listMeetings({}).some((m) => m.id === doc.id && m.segments === 1))
    assert.equal(s.deleteMeeting(doc.id), true)
    assert.ok(!s.listMeetings({}).some((m) => m.id === doc.id))
    assert.equal(s.getMeeting(doc.id), null)
  })

  test('addSegment on a missing meeting throws rather than silently dropping', () => {
    const s = freshStore()
    assert.throws(() => s.addSegment('mt_nope', { text: 'x' }), /not found/)
  })
})

// A meeting is only "recording" while a live process holds it in memory. The
// status on disk is written at start and cleared at end, so a crash, a
// force-quit or a dev restart strands it — and a stranded meeting showed a red
// dot forever with an 结束 button that could not possibly work, because the
// pipeline it calls into has nothing active on a fresh process.
describe('abandoned meetings', () => {
  test('a meeting left recording is closed on the next open', () => {
    const a = freshStore()
    const m = a.createMeeting({ title: '被打断的会' })
    a.addSegment(m.id, { text: '说了一句', speaker: '我', durationMs: 1000, at: m.startedAt + 5000 })
    a.close()   // the process dies here — endMeeting never ran

    const b = freshStore()
    // `includes`, not `deepEqual`: every describe in this file shares one temp
    // dir, so earlier blocks have left their own unfinished meetings behind.
    assert.ok(b.closeAbandonedMeetings().includes(m.id))
    const doc = b.getMeeting(m.id)
    assert.equal(doc.status, 'ended')
    assert.equal(doc.interrupted, true)
    // Dated to the end of the last segment, not to now: the meeting stopped
    // when the app did, and stamping it with this launch would invent however
    // many hours the machine was off as meeting time.
    assert.equal(doc.endedAt, m.startedAt + 6000)
  })

  test('a meeting with no segments ends where it began', () => {
    const a = freshStore()
    const m = a.createMeeting({})
    a.close()
    const b = freshStore()
    b.closeAbandonedMeetings()
    const doc = b.getMeeting(m.id)
    assert.equal(doc.endedAt, doc.startedAt)
    assert.equal(doc.status, 'ended')
  })

  test('properly ended meetings are left alone, and it is idempotent', () => {
    const s = freshStore()
    s.closeAbandonedMeetings()   // settle whatever earlier blocks left behind
    const m = s.createMeeting({})
    s.endMeeting(m.id, { at: m.startedAt + 1234 })
    assert.deepEqual(s.closeAbandonedMeetings(), [])
    assert.equal(s.getMeeting(m.id).endedAt, m.startedAt + 1234)
    assert.equal(s.getMeeting(m.id).interrupted, undefined)
    // Running it twice must not reopen or re-date anything.
    assert.deepEqual(s.closeAbandonedMeetings(), [])
  })

  test('after reconciling, nothing in the list still claims to be recording', () => {
    // This is the symptom the user saw: several rows with a live red dot.
    const a = freshStore()
    a.createMeeting({ title: '一' })
    a.createMeeting({ title: '二' })
    a.close()
    const b = freshStore()
    b.closeAbandonedMeetings()
    assert.equal(b.listMeetings({}).some((m) => m.status === 'recording'), false)
  })
})

// A global shortcut belongs OS-wide to whoever registers it first, so two
// settings holding the same combination does not produce two behaviours or an
// error — it silently deletes the second one, and the feature is just gone.
describe('hotkey de-duplication', () => {
  test('the push-to-talk split does not strand continuous dictation', () => {
    // The real regression. An old settings.json says hotkeyToggle is
    // Control+Shift+Space (that was its default once). The redesign gave that
    // combination to the new hotkeyPushToTalk and moved toggle to
    // Control+Shift+D — but saved values win over defaults, so both ended up on
    // Space, push-to-talk registered first, and there was no working key for
    // continuous dictation at all: press it, say one sentence, watch it stop.
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hotkeyToggle: 'Control+Shift+Space' }),
    )
    const s = freshStore().getSettings()
    assert.equal(s.hotkeyPushToTalk, 'Control+Shift+Space', '按住说话保留这个组合键')
    assert.equal(s.hotkeyToggle, 'Control+Shift+D', '一直录音退回自己的默认值')
  })

  test('the repair is written back, not just held in memory', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hotkeyToggle: 'Control+Shift+Space' }),
    )
    freshStore()
    // Otherwise the settings page shows the fixed value while the file still
    // holds the broken one, and every launch repairs it again.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    assert.equal(onDisk.hotkeyToggle, 'Control+Shift+D')
  })

  test('all five stay distinct, and none is lost', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ hotkeyToggle: 'Control+Shift+Space' }),
    )
    const s = freshStore().getSettings()
    const keys = ['hotkeyPushToTalk', 'hotkeyToggle', 'hotkeyMeeting', 'hotkeyMute', 'hotkeyPanel']
    const combos = keys.map((k) => s[k])
    assert.equal(combos.filter(Boolean).length, 5, JSON.stringify(combos))
    assert.equal(new Set(combos).size, 5, combos.join(' / '))
  })

  test('a write cannot create a collision either', () => {
    // The settings page refuses a duplicate before it gets here, so this is the
    // backstop. It asserts the invariant — no two the same, none lost — rather
    // than which of the two moves: that is decided by HOTKEY_KEYS order, and
    // pinning it here would make the order untouchable for no good reason.
    const s = freshStore()
    s.resetSettings()
    const contested = s.getSettings().hotkeyPanel
    const after = s.setSettings({ hotkeyMute: contested })
    const combos = ['hotkeyPushToTalk', 'hotkeyToggle', 'hotkeyMeeting', 'hotkeyMute', 'hotkeyPanel']
      .map((k) => after[k]).filter(Boolean)
    assert.equal(new Set(combos).size, combos.length, combos.join(' / '))
    assert.equal(after.hotkeyMute, contested, '写进去的那个值被保留')
    // Panel loses it and has nowhere to go — its own default IS the contested
    // combination — so it ends up unset. Unset is visible in the settings page
    // as 未设置; the thing this must never do is leave both claiming it, where
    // one of them would silently never fire.
    assert.equal(after.hotkeyPanel, '')
  })

  test('when the default is taken too, the setting is cleared rather than silently dead', () => {
    const s = freshStore()
    s.resetSettings()
    // Ask for Mute's own default on Panel: Mute holds it, and Panel's default
    // is free, so Panel falls back there.
    const after = s.setSettings({ hotkeyPanel: 'Control+Shift+X' })
    assert.equal(after.hotkeyPanel, 'Control+Shift+H')
    // Now force a case with no way out: two keys both wanting a third's combo.
    const both = s.setSettings({ hotkeyMute: 'Control+Shift+M', hotkeyPanel: 'Control+Shift+M' })
    assert.equal(both.hotkeyMeeting, 'Control+Shift+M', '会议先到先得')
    assert.notEqual(both.hotkeyMute, 'Control+Shift+M')
    assert.notEqual(both.hotkeyPanel, 'Control+Shift+M')
  })

  test('hotkeyConflict names the holder so the UI can say who', () => {
    const s = freshStore()
    s.resetSettings()
    assert.equal(s.hotkeyConflict('hotkeyMute', 'Control+Shift+H'), 'hotkeyPanel')
    assert.equal(s.hotkeyConflict('hotkeyMute', 'Control+Alt+Q'), '')
    assert.equal(s.hotkeyConflict('hotkeyPanel', 'Control+Shift+H'), '', '自己不算冲突')
  })
})
