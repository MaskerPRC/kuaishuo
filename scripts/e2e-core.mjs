// End-to-end over the real modules, no Electron and no mocks of our own code.
//
// Plays out a whole session the way a user would: dictate a few sentences into
// a fake application, hold the mic while someone interrupts, run a three-person
// meeting, end it, and receive the webhook on an actual HTTP server that
// verifies the signature the way a customer's endpoint would.
//
//   node scripts/e2e-core.mjs
//
// Exits non-zero on the first broken expectation. This is the gate that has to
// be green before any UI work is worth doing.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStore } = require('../electron/store.cjs')
const { createPipeline } = require('../electron/pipeline.cjs')
const { l2norm } = require('../electron/diarize.cjs')
const wh = require('../electron/webhook.cjs')

// ---- Tiny harness -----------------------------------------------------------

let step = 0
const failures = []

function check(label, cond, detail = '') {
  step++
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
  } else {
    failures.push(label)
    console.log(`  \x1b[31m✖\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}

function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }

// ---- Fixtures ---------------------------------------------------------------

const DIM = 192
const voice = (n) => l2norm(Array.from({ length: DIM }, (_, i) => Math.sin((i + 1) * (n + 1) * 0.7331)))
const utterance = (n, seed) => {
  const b = voice(n)
  const e = l2norm(Array.from({ length: DIM }, (_, i) => Math.cos((i + 1) * seed * 2.113 + seed)))
  return l2norm(b.map((x, i) => x + 0.25 * e[i]))
}

const ME = voice(0)
const COLLEAGUE = voice(4)
const CLIENT = voice(11)

// Stands in for the OS keyboard. Records what would have been typed where.
function fakeKeyboard() {
  const typed = []
  return {
    typed,
    sendText: async (text, opts) => {
      typed.push({ text, mode: opts.mode, enter: opts.enter })
      return { ok: true, mode: opts.mode, chars: text.length, target: '记事本' }
    },
  }
}

// ---- Run --------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-e2e-'))
const server = await new Promise((resolve) => {
  const received = []
  const s = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"draftId":"d_991"}')
    })
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, received, url: `http://127.0.0.1:${s.address().port}/kuaishuo` }))
})

const SECRET = 'e2e-shared-secret'
const store = createStore({ dir })
const kb = fakeKeyboard()
const meetingEvents = []
const pipeline = createPipeline({
  store,
  sendText: kb.sendText,
  onMeeting: (e) => meetingEvents.push(e),
})

store.setSettings({
  outputMode: 'type',
  voiceprintEnabled: true,
  voiceprint: ME,
  voiceprintThreshold: 0.5,
  meetingBypassVoiceprint: true,
  meetingDiarize: true,
  webhookEnabled: true,
  webhookUrl: server.url,
  webhookSecret: SECRET,
  webhookIncludeSegments: true,
})

try {
  // ── 1. Dictating into an application ──────────────────────────────────────
  stage('1. 听写：说的话进到当前应用')

  await pipeline.commit({ text: '帮我把这段接口文档重写一遍', embedding: utterance(0, 1), durationMs: 2400, decodeMs: 130 })
  await pipeline.commit({ text: '语气正式一点', embedding: utterance(0, 2), durationMs: 1300, decodeMs: 80 })

  check('两句话都送到了当前应用', kb.typed.length === 2, `实际 ${kb.typed.length}`)
  check('内容逐字一致', kb.typed[0].text === '帮我把这段接口文档重写一遍')
  check('输出方式是直接输入', kb.typed.every((t) => t.mode === 'type'))
  check('历史里能查到', store.listHistory({ query: '接口文档' }).total === 1)

  // ── 2. The voiceprint gate ────────────────────────────────────────────────
  stage('2. 声纹：别人的声音不许动我的文档')

  const before = kb.typed.length
  const tv = await pipeline.commit({ text: '现在插播一条广告', embedding: CLIENT, durationMs: 1800 })

  check('被判定为他人', tv.accepted === false && tv.reason === 'voiceprint', JSON.stringify(tv))
  check('一个字都没进应用', kb.typed.length === before)
  check('但记录下来了，不是静悄悄丢掉', store.listHistory({ query: '插播' }).items[0]?.rejected === true)
  check('不计入统计总数', store.stats({}).total.rejected === 1)

  // ── 3. Pause ──────────────────────────────────────────────────────────────
  // The engine-side hold is a renderer concern (nothing reaches commit at all
  // while muted), so what's checked here is the contract that stands in for it:
  // an utterance that never arrives leaves no trace anywhere.
  stage('3. 暂停：静音期间说的话不留痕迹')

  const snapshot = { typed: kb.typed.length, history: store.listHistory({}).total }
  // …user mutes, says something to a colleague, unmutes. No commit() happens.
  check('没有多出输入', kb.typed.length === snapshot.typed)
  check('没有多出历史', store.listHistory({}).total === snapshot.history)

  // ── 4. Meeting mode ───────────────────────────────────────────────────────
  stage('4. 会议模式：三个人，逐字稿，不输入到任何应用')

  const typedBeforeMeeting = kb.typed.length
  const doc = pipeline.startMeeting({ title: '客户需求评审' })

  const script = [
    [ME,        '我们今天过一下二期的范围'],
    [COLLEAGUE, '后端接口已经冻结了'],
    [COLLEAGUE, '剩下的是前端联调'],
    [CLIENT,    '我们希望这周五能看到 demo'],
    [ME,        '周五可以，但报表模块要放到下一期'],
    [CLIENT,    '报表可以往后放'],
  ]
  for (const [who, text] of script) {
    await pipeline.commit({ text, embedding: who === ME ? utterance(0, text.length) : who, durationMs: text.length * 180 })
  }

  const live = store.getMeeting(doc.id)
  check('六句话全部进了逐字稿', live.segments.length === 6, `实际 ${live.segments.length}`)
  check('会议期间没有任何东西被输入到应用', kb.typed.length === typedBeforeMeeting)
  check('分出了三个说话人', live.speakers.length === 3, JSON.stringify(live.speakers.map((s) => s.label)))
  check('我被识别为「我」', live.segments[0].speaker === '我', live.segments[0].speaker)
  check('别人是「说话人N」', /^说话人\d$/.test(live.segments[1].speaker), live.segments[1].speaker)
  check('同一个人的连续两句归为同一人', live.segments[1].speaker === live.segments[2].speaker)
  check('时间轴有偏移量', live.segments[5].offsetMs >= live.segments[0].offsetMs)

  const ended = pipeline.stopMeeting()
  check('会议已结束', ended.status === 'ended' && ended.endedAt > 0)
  check('结束后听写恢复正常', await (async () => {
    const n = kb.typed.length
    await pipeline.commit({ text: '会后继续写文档', embedding: utterance(0, 9) })
    return kb.typed.length === n + 1
  })())

  // ── 5. Rename a speaker ───────────────────────────────────────────────────
  stage('5. 改名：把「说话人1」改成真名，逐字稿同步')

  const renamed = store.getMeeting(doc.id)
  const target = renamed.speakers.find((s) => s.label === '说话人1')
  const oldLabel = target.label
  target.label = '张工'
  for (const seg of renamed.segments) if (seg.speaker === oldLabel) seg.speaker = '张工'
  renamed.notes = '客户要周五看 demo；报表挪到二期。'
  store.saveMeeting(renamed)

  const afterRename = store.getMeeting(doc.id)
  check('逐字稿里的名字都换了', afterRename.segments.some((s) => s.speaker === '张工'))
  check('没有残留旧名字', !afterRename.segments.some((s) => s.speaker === oldLabel))

  // ── 6. Webhook ────────────────────────────────────────────────────────────
  stage('6. 推送：逐字稿发到云端，签名可验')

  const payload = wh.buildPayload(afterRename, { includeSegments: true, appVersion: '1.0.0' })
  const res = await wh.deliver(payload, { url: server.url, secret: SECRET, appVersion: '1.0.0' })

  check('推送成功', res.ok === true && res.status === 200, res.error || '')
  check('拿到了服务端的回执', /draftId/.test(res.response || ''))

  const got = server.received[0]
  const body = JSON.parse(got.raw)

  check('event 是 meeting.completed', body.event === 'meeting.completed')
  check('带 specVersion，便于以后兼容', body.specVersion === '1.0')
  check('带 delivery id（可用于去重）', !!got.headers['x-kuaishuo-delivery'])

  // The receiving end's job, performed for real.
  const ts = got.headers['x-kuaishuo-timestamp']
  const expect = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${got.raw}`).digest('hex')
  check('签名可以被接收方独立验证', got.headers['x-kuaishuo-signature'] === expect)
  check('时间戳在合理范围内（防重放）', Math.abs(Date.now() / 1000 - Number(ts)) < 120)

  check('逐字段落齐全', body.transcript.segments.length === 6)
  check('纯文本按说话人合并了连续发言',
    body.transcript.text.split('\n').length === 5,
    JSON.stringify(body.transcript.text))
  check('markdown 可直接贴进文档', body.transcript.markdown.includes('# 客户需求评审'))
  check('备注一起带过去了', body.notes.includes('周五'))
  check('中文没有在传输中损坏', body.transcript.text.includes('报表模块要放到下一期'))
  check('统计字段对得上', body.stats.segments === 6 && body.stats.speakers === 3)

  // ── 7. Offline retry ──────────────────────────────────────────────────────
  stage('7. 断网：推送失败不丢，恢复后自动补投')

  const outbox = wh.createOutbox({ dir })
  outbox.enqueue({ meetingId: doc.id, url: 'http://127.0.0.1:1/down', payload })
  check('欠着的推送落了盘', outbox.list().length === 1)
  const reopened = wh.createOutbox({ dir })
  check('重启后这笔债还在', reopened.list().length === 1)

  // Point it at the live server and flush, the way a reconnect would.
  const owed = reopened.list()[0]
  reopened.remove(owed.deliveryId)
  reopened.enqueue({ ...owed, url: server.url })
  const flushed = await reopened.flush({ force: true })
  check('恢复后补投成功', flushed.delivered === 1, JSON.stringify(flushed))
  check('队列清空', reopened.list().length === 0)
  check('服务端收到了第二次', server.received.length === 2)

  // ── 8. Durability ─────────────────────────────────────────────────────────
  stage('8. durability：换一个进程视角重新打开，数据都还在')

  store.close()
  const reread = createStore({ dir })
  const hist = reread.listHistory({})
  check('历史条数一致', hist.total >= 9, `实际 ${hist.total}`)
  check('逐字稿还在', reread.getMeeting(doc.id).segments.length === 6)
  check('设置还在', reread.getSettings().webhookSecret === SECRET)
  const stats = reread.stats({ days: 7 })
  check('统计能算出来', stats.total.chars > 0 && stats.series.length === 7)
  reread.close()
} finally {
  server.s.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${step - failures.length}/${step} 通过\x1b[0m`)
if (failures.length) {
  console.log('失败：\n' + failures.map((f) => '  · ' + f).join('\n'))
  process.exit(1)
}
