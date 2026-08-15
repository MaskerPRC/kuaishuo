// Microphone diagnostic, run inside the real overlay window.
//
//   npm run probe:mic
//
// "没有声音输入" has at least six distinct causes and they need completely
// different fixes, so this walks the whole chain in order and reports where it
// actually stops:
//
//   1. is navigator.mediaDevices even there (secure context)
//   2. does the OS/Electron permission layer let us have it
//   3. is there an input device at all
//   4. does getUserMedia hand back a live track
//   5. does the AudioContext actually start (autoplay policy!) …
//   6. … and does the AudioWorklet deliver frames with real signal in them
//   7. separately: is the ASR model on disk, or is the app stuck downloading
//
// Step 5 is the one that bites: Chromium starts an AudioContext suspended
// unless the document has user activation, and a session started from a global
// hotkey or the tray has none — the graph builds cleanly, the mic light comes
// on, and not one frame ever arrives.

const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  // The detail strings here are diagnoses of a failure, not context for a pass.
  // Printing them on green lines makes a healthy run read like a broken one.
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}
function info(label, value) {
  console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`)
}
function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The same worklet source the app uses, so this measures the real graph rather
// than a simpler one that might work where the real one doesn't.
const PROBE = `(async () => {
  const out = { ok: false, steps: {} }
  const S = out.steps
  S.secureContext = window.isSecureContext
  S.origin = location.origin || location.href.slice(0, 40)
  S.hasMediaDevices = !!navigator.mediaDevices
  S.hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  if (!S.hasGUM) return out

  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    S.audioInputs = devs.filter(d => d.kind === 'audioinput').map(d => d.label || '(无标签)')
  } catch (e) { S.enumerateError = String(e && e.message || e) }

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
    S.getUserMedia = 'ok'
  } catch (e) {
    S.getUserMedia = 'FAILED'
    S.gumErrorName = e && e.name
    S.gumErrorMessage = e && e.message
    return out
  }

  const track = stream.getAudioTracks()[0]
  S.track = track ? { label: track.label, enabled: track.enabled, muted: track.muted, state: track.readyState } : null

  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  S.ctxStateInitial = ctx.state
  S.sampleRate = ctx.sampleRate
  try { await ctx.resume(); S.resumed = ctx.state } catch (e) { S.resumeError = String(e && e.message || e) }

  const src = \`
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(1024); this._n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i]
      if (this._n === this._buf.length) { this.port.postMessage(this._buf.slice(0)); this._n = 0 }
    }
    return true
  }
}
registerProcessor('probe-tap', PcmTap)\`

  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    S.workletLoaded = true
  } catch (e) {
    S.workletLoaded = false
    S.workletError = String(e && e.message || e)
    return out
  }

  const node = new AudioWorkletNode(ctx, 'probe-tap')
  let frames = 0, peakDb = -200, sumDb = 0
  node.port.onmessage = (e) => {
    frames++
    const d = e.data
    let sq = 0
    for (let i = 0; i < d.length; i++) sq += d[i] * d[i]
    const db = 20 * Math.log10(Math.sqrt(sq / d.length) + 1e-10)
    if (db > peakDb) peakDb = db
    sumDb += db
  }
  const source = ctx.createMediaStreamSource(stream)
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(node); node.connect(mute); mute.connect(ctx.destination)

  await new Promise(r => setTimeout(r, 2500))

  S.frames = frames
  S.expectedFrames = Math.round(2.5 * ctx.sampleRate / 1024)
  S.peakDb = Math.round(peakDb * 10) / 10
  S.avgDb = frames ? Math.round(sumDb / frames * 10) / 10 : null
  S.ctxStateEnd = ctx.state

  try { node.port.onmessage = null; source.disconnect(); node.disconnect(); mute.disconnect() } catch (e) {}
  for (const t of stream.getTracks()) { try { t.stop() } catch (e) {} }
  try { await ctx.close() } catch (e) {}

  out.ok = frames > 0
  return out
})()`

// Loopback capture, for meeting mode. Two things here are Chromium
// implementation details that the docs do not settle and that an Electron bump
// could change under us, so they are measured rather than assumed:
//
//   a) does the audio track survive stopping the video track — we only request
//      video because getDisplayMedia will not open a session without it, and
//      keeping a screen capture alive for nothing costs real CPU
//   b) does getDisplayMedia work at all without a user gesture
//
// (b) is why this runs with executeJavaScript(code, true): the `true` grants
// transient user activation to a window that is focusable:false and therefore
// never has any of its own. It is the same class of trap as the AudioContext
// one above, and it is also the production fallback — a meeting started from
// the tray gives this renderer no gesture either.
const LOOPBACK_PROBE = `(async () => {
  const out = { ok: false, steps: {} }
  const S = out.steps
  S.platform = navigator.userAgentData?.platform || navigator.platform
  S.hasGDM = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
  if (!S.hasGDM) return out

  // Audio-only first: that is the path the app actually uses now, and the
  // reason it exists is that answering it needs no desktopCapturer call, which
  // blocks the main process ~390ms on first use.
  try {
    const only = await navigator.mediaDevices.getDisplayMedia({ audio: true })
    S.audioOnly = only.getAudioTracks().length > 0 ? 'ok' : 'no-audio-track'
    S.audioOnlyVideoTracks = only.getVideoTracks().length
    for (const t of only.getTracks()) { try { t.stop() } catch {} }
  } catch (err) {
    S.audioOnly = 'FAILED'
    S.audioOnlyError = `${err.name}: ${err.message}`
  }

  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 320 }, height: { max: 180 }, frameRate: { max: 1 } },
      audio: true,
    })
    S.gdm = 'ok'
  } catch (err) {
    S.gdm = 'FAILED'
    S.gdmErrorName = err.name
    S.gdmErrorMessage = err.message
    return out
  }

  const audio = stream.getAudioTracks()[0]
  S.videoTracks = stream.getVideoTracks().length
  S.audioTracks = stream.getAudioTracks().length
  if (!audio) { for (const t of stream.getTracks()) { try { t.stop() } catch {} } return out }
  S.audioTrack = { label: audio.label, state: audio.readyState, muted: audio.muted }
  S.channelCount = audio.getSettings().channelCount

  // (a) — stop the video track, then look at the audio track.
  for (const t of stream.getVideoTracks()) { t.enabled = false; try { t.stop() } catch {} }
  await new Promise((r) => setTimeout(r, 250))
  S.afterStop = { state: audio.readyState, muted: audio.muted }
  S.survivedVideoStop = audio.readyState === 'live'

  const ctx = new AudioContext()
  S.ctxStateInitial = ctx.state
  try { await ctx.resume(); S.resumed = ctx.state } catch (err) { S.resumeError = String(err) }

  const src = \`
    class P extends AudioWorkletProcessor {
      constructor(){ super(); this._b = new Float32Array(1024); this._n = 0 }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0]
        if (!ch) return true
        for (let i = 0; i < ch.length; i++) {
          this._b[this._n++] = ch[i]
          if (this._n === 1024) { this.port.postMessage(this._b.slice(0)); this._n = 0 }
        }
        return true
      }
    }
    registerProcessor('probe-tap', P)
  \`
  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    S.workletLoaded = true
  } catch (err) {
    S.workletLoaded = false
    S.workletError = String(err)
    for (const t of stream.getTracks()) { try { t.stop() } catch {} }
    return out
  }

  // Mono downmix, exactly as openSystemAudioTap does — loopback is stereo and
  // the worklet only reads channel 0.
  const source = ctx.createMediaStreamSource(stream)
  const mono = ctx.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  const node = new AudioWorkletNode(ctx, 'probe-tap')
  const mute = ctx.createGain()
  mute.gain.value = 0
  source.connect(mono); mono.connect(node); node.connect(mute); mute.connect(ctx.destination)

  let frames = 0, peak = 0, sum = 0
  node.port.onmessage = (e) => {
    frames++
    let sq = 0
    for (let i = 0; i < e.data.length; i++) { const v = e.data[i]; sq += v * v; if (Math.abs(v) > peak) peak = Math.abs(v) }
    sum += Math.sqrt(sq / e.data.length)
  }
  await new Promise((r) => setTimeout(r, 2500))

  S.sampleRate = ctx.sampleRate
  S.framesAfterStop = frames
  S.expectedFrames = Math.round(2.5 * ctx.sampleRate / 1024)
  S.peakDb = frames ? +(20 * Math.log10(peak + 1e-10)).toFixed(1) : null
  S.avgDb = frames ? +(20 * Math.log10(sum / frames + 1e-10)).toFixed(1) : null
  S.trackAtEnd = { state: audio.readyState, muted: audio.muted }

  for (const t of stream.getTracks()) { try { t.stop() } catch {} }
  try { await ctx.close() } catch {}
  out.ok = true
  return out
})()`

async function probeLoopback(owc, store) {
  stage('5. 系统声音（会议模式的另一半）')

  if (process.platform !== 'win32') {
    info('系统声音捕获', '仅 Windows 支持，跳过')
    return
  }
  const s = store.getSettings()
  info('会议中录系统声音', s.systemAudioInMeetings ? '开' : '关')

  let r
  // `true` = grant transient user activation. Without it getDisplayMedia is
  // rejected by Blink before Electron's handler is ever consulted.
  try {
    r = await owc.executeJavaScript(LOOPBACK_PROBE, true)
  } catch (err) {
    check('系统声音探针能执行', false, err.message)
    return
  }
  const S = r.steps

  check('getDisplayMedia 存在', S.hasGDM === true)
  // The whole point of the audio-only path: no video source means main never
  // calls desktopCapturer, which is a ~390ms freeze of the entire app the first
  // time it runs. If this ever fails the app falls back to asking for video and
  // the freeze comes back — so it is worth a check rather than an assumption.
  check('只要音频就能拿到 loopback（不触发抓屏）', S.audioOnly === 'ok',
    S.audioOnlyError || S.audioOnly)
  if (S.audioOnly === 'ok') info('音频-only 时的视频轨数', S.audioOnlyVideoTracks)
  const ok = S.gdm === 'ok'
  check('拿到了 display capture 流', ok,
    ok ? '' : `${S.gdmErrorName}: ${S.gdmErrorMessage}\n      ` + hintForGdm(S.gdmErrorName))
  if (!ok) return

  check('流里有音轨（loopback 真的接上了）', S.audioTracks > 0,
    S.audioTracks === 0
      ? '只有视频没有音频 —— 主进程的 setDisplayMediaRequestHandler 没有返回 audio: "loopback"。'
      : '')
  if (!S.audioTracks) return
  info('音轨', S.audioTrack.label || '(无标签)')
  info('声道数', S.channelCount)

  // The judgement call this probe exists to make.
  check('停掉视频轨后音轨仍然活着', S.survivedVideoStop === true,
    S.survivedVideoStop === false
      ? '停掉视频轨把整个采集会话也带走了 —— openSystemAudioTap 会退回到保留视频轨（enabled=false）的路径，\n      '
        + '功能仍然可用，但会一直有一路屏幕采集在跑。'
      : JSON.stringify(S.afterStop))

  info('AudioContext 创建时状态', S.ctxStateInitial)
  check('AudioContext 能跑起来', S.resumed === 'running' || S.ctxStateInitial === 'running',
    S.resumeError || `resume() 之后是 ${S.resumed}`)
  check('停掉视频轨后仍在出帧', S.framesAfterStop > 0,
    S.framesAfterStop === 0 ? '音轨看起来是 live，但一帧都没有 —— 图建起来了却没有数据在流。' : '')
  if (!S.framesAfterStop) return

  info('2.5 秒内收到帧', `${S.framesAfterStop} / 预期约 ${S.expectedFrames}`)
  // Deliberately info, not check: a machine with nothing playing legitimately
  // reads as digital silence, and failing the run for that would teach people
  // to ignore this harness. Play something first if you want a real number.
  info('峰值电平', `${S.peakDb} dB${S.peakDb <= -90 ? '  ← 当前没有任何声音在播放？放首歌再跑一次' : ''}`)
  info('平均电平', `${S.avgDb} dB`)
}

function hintForGdm(name) {
  if (name === 'NotAllowedError') {
    return '被拒绝了。两种可能：主进程的权限处理器没有放行 display-capture，\n      '
      + '或者 Chromium 要求用户手势而这次调用没有 —— 后者正是 executeJavaScript(code, true) 要解决的。'
  }
  if (name === 'NotFoundError') return '没有可采集的源。desktopCapturer.getSources 返回空。'
  if (name === 'NotSupportedError') return '这个平台不支持 loopback 采集（Electron 只在 Windows 上支持）。'
  if (name === 'InvalidStateError') return '文档状态不对 —— 通常是缺少 transient user activation。'
  return ''
}

async function run({ overlay, store }) {
  console.log('\n=== 快说 · 麦克风链路诊断 ===')

  const ow = overlay.get()
  if (!ow) { console.log('悬浮窗不存在'); return 1 }
  const owc = ow.webContents
  if (owc.isLoading()) await new Promise((r) => owc.once('did-finish-load', r))
  await sleep(400)

  stage('1. 渲染进程环境')
  let r
  try {
    r = await owc.executeJavaScript(PROBE)
  } catch (err) {
    console.log('探针执行失败：', err.message)
    return 1
  }
  const S = r.steps

  info('origin', S.origin)
  check('是安全上下文（getUserMedia 的前提）', S.secureContext === true, String(S.secureContext))
  check('navigator.mediaDevices 存在', S.hasMediaDevices === true)
  check('getUserMedia 存在', S.hasGUM === true)

  stage('2. 设备与权限')
  if (S.enumerateError) info('enumerateDevices 报错', S.enumerateError)
  check('至少有一个音频输入设备', Array.isArray(S.audioInputs) && S.audioInputs.length > 0,
    JSON.stringify(S.audioInputs))
  if (Array.isArray(S.audioInputs)) for (const l of S.audioInputs) info('输入设备', l)

  const gumOk = S.getUserMedia === 'ok'
  check('getUserMedia 拿到了流', gumOk,
    gumOk ? '' : `${S.gumErrorName}: ${S.gumErrorMessage}\n      ` + hintForGum(S.gumErrorName))
  if (!gumOk) return finish()

  check('音轨是 live 且未静音',
    S.track && S.track.state === 'live' && S.track.muted === false,
    JSON.stringify(S.track))
  info('音轨', S.track && S.track.label)

  stage('3. AudioContext（最常见的坑）')
  info('创建时状态', S.ctxStateInitial)
  info('采样率', S.sampleRate)
  check('AudioContext 能跑起来', S.resumed === 'running' || S.ctxStateInitial === 'running',
    S.resumed === 'suspended'
      ? 'resume() 之后仍然 suspended —— 自动播放策略挡住了。\n      '
        + '没有用户手势的情况下（全局快捷键、托盘、开机自启）AudioContext 会一直挂起，\n      '
        + '音频图建得好好的、麦克风灯也亮，但一帧都不会来。'
      : (S.resumeError || ''))
  check('AudioWorklet 加载成功', S.workletLoaded === true, S.workletError || '')

  stage('4. 真的有帧进来吗')
  info('2.5 秒内收到帧', `${S.frames} / 预期约 ${S.expectedFrames}`)
  check('有音频帧到达', S.frames > 0,
    S.frames === 0 ? '一帧都没有 —— 这就是"没有任何音频输入"的直接原因。' : '')
  if (S.frames > 0) {
    info('平均电平', `${S.avgDb} dB`)
    info('峰值电平', `${S.peakDb} dB`)
    // -100dB 是数字静音；真实房间即使很安静也在 -70 以上。
    check('电平不是数字静音（麦克风确实在采集）', S.peakDb > -90,
      S.peakDb <= -90 ? '拿到帧了，但全是 0 —— 设备被系统静音，或选中的是一个没有信号的虚拟设备。' : '')
  }

  const s = store.getSettings()
  info('输出方式', s.outputMode)
  info('选中的麦克风', s.micDeviceId || '(系统默认)')

  await probeLoopback(owc, store)

  // ── A real click, through Chromium's input pipeline ───────────────────────
  // el.click() bypasses hit-testing, the drag handler and the non-focusable
  // window's mouse routing — i.e. exactly the things that could stop a human's
  // click from working while every DOM-level test still passes.
  stage('6. 用真实鼠标事件点圆点')

  const dot = await owc.executeJavaScript(`(() => {
    const r = document.querySelector('.dot').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  info('圆点坐标', `${dot.x}, ${dot.y}`)

  owc.sendInputEvent({ type: 'mouseMove', x: dot.x, y: dot.y })
  owc.sendInputEvent({ type: 'mouseDown', x: dot.x, y: dot.y, button: 'left', clickCount: 1 })
  await sleep(60)
  owc.sendInputEvent({ type: 'mouseUp', x: dot.x, y: dot.y, button: 'left', clickCount: 1 })
  await sleep(1500)

  const after = await owc.executeJavaScript(`(() => ({
    dotOn: !!document.querySelector('.dot.on'),
    // Armed-and-waiting: pressed, but the model is still coming down. The
    // session starts on its own the moment it lands.
    dotWaiting: !!document.querySelector('.dot.waiting'),
    status: (document.querySelector('.status')?.textContent || '').trim(),
    note: (document.querySelector('.note')?.textContent || '').trim(),
    hasWave: !!document.querySelector('canvas.wave'),
  }))()`)
  info('点击后 DOM', JSON.stringify(after))
  check('点击真的启动了会话（听写中 或 已就绪待模型）',
    after.dotOn === true || after.dotWaiting === true,
    '真实点击没有让会话进入任何活动状态 —— 命中测试或拖动逻辑吃掉了这次点击。')
  check('按下这件事被可见地确认了', after.dotOn || after.dotWaiting || after.note,
    '按下去以后条上没有任何变化，用户没法知道自己按到了没有。')

  // ── Model: either already installed, or the download starts ───────────────
  stage('7. 模型状态')

  const fs = require('fs')
  const path = require('path')
  const { app } = require('electron')
  const dir = path.join(app.getPath('userData'), 'asr-models')
  await sleep(2500)
  let entries = []
  try { entries = fs.readdirSync(dir) } catch (e) { /* not created yet */ }
  info('asr-models 目录', dir)
  info('目录内容', entries.length ? entries.join(', ') : '(空)')

  const st = await owc.executeJavaScript(`window.kuaishuo.asr.status()`).catch(() => null)
  if (st?.modelOnDisk) {
    info('模型', '已安装，跳过下载检查')
    check('模型就绪时不会多余地再下一次', !entries.some((f) => f.endsWith('.partial')),
      entries.join(', '))
  } else {
    check('下载已经开始（出现 .partial）',
      entries.some((f) => f.endsWith('.partial')),
      '目录仍是空的 —— ensureModel 从未被调用，或它一进去就失败了。')
  }

  // The strip must stay alive while it waits. A dead-looking strip during a
  // 228MB download is indistinguishable from a broken app, which is exactly the
  // report this probe was written to chase down.
  const said = await owc.executeJavaScript(`(() => ({
    status: (document.querySelector('.status')?.textContent || '').trim(),
    note: (document.querySelector('.note')?.textContent || '').trim(),
    wave: !!document.querySelector('canvas.wave'),
  }))()`)
  info('条上显示', JSON.stringify(said))
  check('波形始终活着（不是一条死掉的横条）', said.wave === true,
    '波形被状态文字顶掉了 —— 用户看到的就是"没有任何音频输入"。')

  // ── Changing the input device mid-session ─────────────────────────────────
  // Picking a microphone used to do nothing until dictation was stopped and
  // started again: you changed the setting, kept talking, and the old device
  // was still the one being recorded.
  //
  // Proving a switch happened is awkward from outside the renderer — the track
  // is internal. So prove it the other way round: point the setting at a device
  // that cannot exist. If the setting is being acted on, the reopen fails
  // loudly. If it is being ignored (the old bug), nothing happens at all and
  // the session sails on none the wiser.
  stage('8. 切换输入设备是否立即生效')

  const live = await owc.executeJavaScript(`(() => ({
    on: !!document.querySelector('.dot.on'),
    waiting: !!document.querySelector('.dot.waiting'),
  }))()`)
  if (!live.on) {
    info('跳过', `听写未处于监听状态（${JSON.stringify(live)}），无法测试热切换`)
  } else {
    await owc.executeJavaScript(`window.kuaishuo.settings.set({ micDeviceId: 'no-such-device-id' })`)
    const broke = await until(
      () => owc.executeJavaScript(`(() => ({
        err: (document.querySelector('.status')?.textContent || '').trim(),
        on: !!document.querySelector('.dot.on'),
      }))()`).catch(() => null),
      (s) => s && (!!s.err || s.on === false),
      6000,
    )
    info('切到不存在的设备后', JSON.stringify(broke))
    check('设置一改就立刻作用到正在跑的会话', !!broke && (!!broke.err || broke.on === false),
      '换了设备但会话毫无反应 —— 说明改动要等下次开始听写才生效。')
    check('报错是人话，不是 OverconstrainedError',
      broke?.err === '选中的麦克风不可用' || broke?.err === '',
      `条上显示的是 ${JSON.stringify(broke?.err)}`)

    // Put it back and confirm the strip can recover.
    await owc.executeJavaScript(`window.kuaishuo.settings.set({ micDeviceId: '' })`)
    await sleep(300)
  }

  return finish()
}

async function until(probe, ok, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (ok(last)) return last
    if (Date.now() >= deadline) return last
    await sleep(120)
  }
}

function hintForGum(name) {
  switch (name) {
    case 'NotAllowedError':
      return '权限被拒。检查 Electron 的 setPermissionRequestHandler，以及 Windows 设置 → 隐私 → 麦克风 → 允许桌面应用访问。'
    case 'NotFoundError':
      return '系统里没有可用的录音设备。'
    case 'NotReadableError':
      return '设备被其它程序独占了（会议软件 / 录音软件）。'
    case 'OverconstrainedError':
      return '指定的 deviceId 不存在了（换过设备？在设置里改回"系统默认"）。'
    default:
      return ''
  }
}

function finish() {
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${failed.length ? '\x1b[31m' : '\x1b[32m'}${results.length - failed.length}/${results.length}\x1b[0m`)
  if (failed.length) console.log('断在这些环节：\n' + failed.map((f) => `  · ${f.label}`).join('\n'))
  return failed.length ? 1 : 0
}

module.exports = { run }
