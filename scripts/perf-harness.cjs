// Frame-time measurement for the overlay, in the real window.
//
//   npm run probe:perf
//
// The strip animates a canvas ribbon at 60fps and sits on top of every other
// window, so it is the one part of this app whose cost is felt continuously
// rather than in bursts. "It feels slow" is not something to fix by guessing;
// this prints milliseconds.
//
// Reports separately for the states that cost different amounts: idle, the
// ribbon running, and the frosted backdrop on/off — because the interesting
// question is not "how fast is it" but "what is the glass costing".

const results = []
function row(label, ms, note = '') {
  results.push({ label, ms })
  const fps = ms > 0 ? (1000 / ms).toFixed(0) : '—'
  const bad = ms > 20
  const color = bad ? '\x1b[31m' : ms > 12 ? '\x1b[33m' : '\x1b[32m'
  console.log(`  ${color}${ms.toFixed(2)} ms/帧  ~${fps} fps\x1b[0m  ${label}${note ? `  \x1b[2m${note}\x1b[0m` : ''}`)
}
function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Measures presented frame intervals rather than the duration of our own work:
// the compositor is where a backdrop-filter is paid for, and that cost never
// appears inside a JS timer.
const MEASURE = (ms) => `(async () => {
  const frames = []
  let last = performance.now()
  await new Promise((resolve) => {
    const t0 = last
    function tick(now) {
      frames.push(now - last)
      last = now
      if (now - t0 >= ${ms}) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  frames.shift()
  const sorted = frames.slice().sort((a, b) => a - b)
  const sum = frames.reduce((a, b) => a + b, 0)
  return {
    n: frames.length,
    avg: sum / frames.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    worst: sorted[sorted.length - 1],
  }
})()`

async function run({ overlay, store }) {
  console.log('\n=== 快说 · 悬浮条渲染开销 ===')
  const w = overlay.get()
  if (!w) { console.log('悬浮窗不存在'); return 1 }
  const wc = w.webContents
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r))
  await sleep(1200)

  const setting = (patch) => wc.executeJavaScript(
    `window.kuaishuo.settings.set(${JSON.stringify(patch)})`,
  ).catch(() => null)

  const measure = async (label, note) => {
    await sleep(700)   // let the state settle before timing it
    const r = await wc.executeJavaScript(MEASURE(2200))
    row(label, r.avg, `p50 ${r.p50.toFixed(1)} / p95 ${r.p95.toFixed(1)} / 最差 ${r.worst.toFixed(1)}`)
    return r
  }

  // There is no screen capture any more — nothing in the strip's rendering
  // touches the main process. What is left to measure is the renderer itself.
  stage('各状态下的帧时间')
  const idle = await measure('静息')

  // Start dictation so the ribbon is actually animating. There is no start
  // button on the strip any more — beginning to talk is a hotkey — so this goes
  // in through the meeting control, which starts a session as a side effect.
  await wc.executeJavaScript(`document.querySelector('.acts .act.meeting').click()`)
  const live = await measure('听写中', '波形在跑')

  await wc.executeJavaScript(`document.querySelector('.acts .act.meeting').click()`)
  await measure('停止后')

  stage('结论')
  console.log(`  波形的代价：每帧 +${(live.avg - idle.avg).toFixed(2)} ms`)
  const verdict = live.avg <= 16.7
    ? '\x1b[32m能稳住 60fps\x1b[0m'
    : live.avg <= 33
      ? '\x1b[33m掉到 30fps 档\x1b[0m'
      : '\x1b[31m明显卡顿\x1b[0m'
  console.log(`  听写中：${verdict}`)

  await mainThreadBlocking({ overlay, store })
  return 0
}

// ---- Main-process blocking ---------------------------------------------------
// A dropped frame in the strip is the strip's problem. A blocked MAIN process
// is everyone's: it is the same thread that services every window's IPC and
// drives the tray, so while it is stuck the whole app — and anything waiting on
// it — stops. "开机时电脑卡一下" is this, not frame time, and the renderer
// harness above cannot see it by construction.

/** Sample how late a fixed-interval timer actually fires. That lateness IS the block. */
function lagSampler(intervalMs = 20) {
  let worst = 0
  let last = process.hrtime.bigint()
  const t = setInterval(() => {
    const now = process.hrtime.bigint()
    const late = Number(now - last) / 1e6 - intervalMs
    if (late > worst) worst = late
    last = now
  }, intervalMs)
  if (t.unref) t.unref()
  return { stop() { clearInterval(t); return worst } }
}

/**
 * Wall time and blocking are NOT the same number, and only one of them is the
 * bug. Something that takes 1.4s on a worker thread while the main thread stays
 * responsive costs the user nothing; something that takes 200ms with the event
 * loop pinned is a visible hitch. Reporting max() of the two — which is what
 * this printed at first — hides exactly the distinction being measured.
 */
async function timed(label, fn, detail = '') {
  const s = lagSampler()
  const t0 = process.hrtime.bigint()
  const extra = await fn()
  const wall = Number(process.hrtime.bigint() - t0) / 1e6
  const blocked = s.stop()
  // 50ms is roughly where a stall stops being invisible; past 200ms the pointer
  // visibly stops.
  const color = blocked > 200 ? '\x1b[31m' : blocked > 50 ? '\x1b[33m' : '\x1b[32m'
  console.log(
    `  ${color}卡 ${blocked.toFixed(0).padStart(4)} ms\x1b[0m` +
    `  \x1b[2m总耗时 ${wall.toFixed(0).padStart(4)} ms\x1b[0m  ${label}` +
    `${extra || detail ? `  \x1b[2m${extra || detail}\x1b[0m` : ''}`)
  return { wall, blocked }
}

async function mainThreadBlocking({ overlay, store }) {
  stage('主进程卡顿（界面卡一下的真正来源）')

  const { desktopCapturer } = require('electron')

  await timed('打开一次库（读设置 + 对账未结束的会议）', async () => {
    const { createStore } = require('../electron/store.cjs')
    const s2 = createStore({ dir: store.dir })
    const n = s2.listMeetings({}).length
    try { s2.close() } catch {}
    return `${n} 场会议`
  })

  await timed('listMeetings（每场会都要读一个文件）', async () => {
    const n = store.listMeetings({}).length
    return `${n} 场`
  })

  await timed('stats（整份历史全量扫描）', async () => {
    const st = store.stats({ days: 30 })
    return `${st.total.count} 条`
  })

  // The one screen-grab left in the app. It runs when a meeting starts, to
  // satisfy Chromium's demand for a video source before it will hand over
  // loopback audio — the picture is never looked at, which is why the size is
  // pinned to zero. Historically this call cost 600ms at full resolution and
  // was the single worst thing in the app.
  await timed('desktopCapturer.getSources（缩略图 0×0）', async () => {
    const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    return `${src.length} 个源`
  })
  await timed('desktopCapturer.getSources（默认缩略图，对照组）', async () => {
    const src = await desktopCapturer.getSources({ types: ['screen'] })
    return `${src.length} 个源`
  })

  // Building the recogniser reads a 228MB ONNX file and spins up ONNX Runtime.
  // It happens on a worker_thread — but a worker_thread lives inside THIS
  // process, so if it saturates cores or thrashes the page cache the main
  // thread feels it.
  const w = overlay.get()
  if (w) {
    await timed('构建识别器（228MB 模型 + ONNX 初始化）', async () => {
      const r = await w.webContents.executeJavaScript(
        'window.kuaishuo.asr.ensureModel({ preloadWorker: true })')
      return r?.ok ? '就绪' : `失败 ${r?.error || ''}`
    })
  }

  console.log('\n  \x1b[2m50ms 以上开始能感觉到，200ms 以上鼠标会明显停一下。\x1b[0m')
}

module.exports = { run }
