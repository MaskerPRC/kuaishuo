// Downloads the recogniser (if needed) and then puts a real buffer through the
// real worker, in the real app.
//
//   npm run probe:model
//
// This is the last link nothing else covers: the unit tests never load
// sherpa-onnx, the functional e2e stubs the decoder, and the UI harness never
// gets as far as needing weights. A native module that loads but crashes on
// first decode — an ABI mismatch, a missing VC runtime, an unpacked-asar
// mistake — would pass every one of them and fail on a user's first sentence.
//
// Runs against whatever userData it is given, so it can be pointed at the real
// profile to leave the model in place for actual use.

const fs = require('fs')
const path = require('path')

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}
function info(label, value) { console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`) }
function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mb(n) { return `${(n / 1024 / 1024).toFixed(1)}MB` }

async function run({ overlay }) {
  const { app, ipcMain } = require('electron')
  console.log('\n=== 快说 · 模型与解码链路 ===')
  const userData = app.getPath('userData')
  info('userData', userData)

  const owc = overlay.get()?.webContents
  if (!owc) { console.log('悬浮窗不存在'); return 1 }
  if (owc.isLoading()) await new Promise((r) => owc.once('did-finish-load', r))

  // ── 1. Download ───────────────────────────────────────────────────────────
  stage('1. 下载 / 解压（走 app 自己的后台预取）')

  const dir = path.join(userData, 'asr-models')
  const t0 = Date.now()
  let lastPct = -1
  let done = false

  const status = () => owc.executeJavaScript(
    `window.kuaishuo.asr.status()`,
  ).catch(() => null)

  const before = await status()
  info('开始时', before?.modelOnDisk ? '模型已在磁盘上' : '模型不存在，等待预取')

  // main.cjs kicks prefetch off 4s after ready; just watch it land.
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const st = await status()
    if (st?.modelOnDisk) { done = true; break }
    const pct = Math.round((st?.state?.progress || 0) * 100)
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct
      let partial = 0
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.partial')) partial = fs.statSync(path.join(dir, f)).size
        }
      } catch { /* not there yet */ }
      console.log(`  \x1b[2m·\x1b[0m ${st?.state?.stage || '…'} ${pct}%  ${partial ? mb(partial) : ''}`)
    }
    if (st?.state?.stage === 'error') {
      check('下载成功', false, st.state.message)
      return finish()
    }
    await sleep(1200)
  }

  check('模型已就绪', done, `${Math.round((Date.now() - t0) / 1000)}s 后仍未就绪`)
  if (!done) return finish()
  info('耗时', `${Math.round((Date.now() - t0) / 1000)}s`)

  const st = await status()
  info('模型目录', st.modelDir)
  let total = 0
  try {
    for (const f of fs.readdirSync(st.modelDir)) {
      const p = path.join(st.modelDir, f)
      const s = fs.statSync(p)
      if (s.isFile()) { total += s.size; info(f, mb(s.size)) }
    }
  } catch (e) { /* ignore */ }
  check('解压出的文件大小合理（>150MB）', total > 150 * 1024 * 1024, mb(total))
  check('压缩包已清理', !fs.readdirSync(dir).some((f) => f.endsWith('.tar.bz2') || f.endsWith('.partial')),
    fs.readdirSync(dir).join(', '))

  // ── 2. Build the recogniser ───────────────────────────────────────────────
  stage('2. 构建识别器（sherpa-onnx 原生模块）')

  const t1 = Date.now()
  const ensured = await owc.executeJavaScript(`window.kuaishuo.asr.ensureModel({ preloadWorker: true })`)
  check('worker 初始化成功', ensured?.ok === true, ensured?.error || JSON.stringify(ensured))
  info('构建耗时', `${Date.now() - t1}ms`)
  const st2 = await status()
  check('worker 处于就绪状态', st2?.workerReady === true, JSON.stringify(st2?.state))

  // ── 3. Decode ─────────────────────────────────────────────────────────────
  stage('3. 真的解码一段音频')

  // 1.5s of a 220Hz tone with an amplitude envelope. It is not speech, so the
  // interesting result is not the text — it is that the native decode returns
  // at all, in reasonable time, without taking the process down.
  const t2 = Date.now()
  const decoded = await owc.executeJavaScript(`(async () => {
    const rate = 16000, secs = 1.5
    const n = Math.floor(rate * secs)
    const pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / rate
      pcm[i] = Math.sin(2 * Math.PI * 220 * t) * 0.25 * Math.sin(Math.PI * t / secs)
    }
    const r = await window.kuaishuo.asr.transcribe({ samples: pcm, sampleRate: rate, withEmbedding: false })
    return r
  })()`)
  check('解码返回且未崩溃', decoded?.ok === true, decoded?.error || JSON.stringify(decoded))
  info('解码耗时', `${decoded?.ms ?? '?'}ms（往返 ${Date.now() - t2}ms）`)
  info('识别文本', JSON.stringify(decoded?.text ?? null) + '（正弦波，本来就不该有内容）')
  check('1.5s 音频解码快于实时', typeof decoded?.ms === 'number' && decoded.ms < 1500, `${decoded?.ms}ms`)

  // ── 4. Speaker embedding ──────────────────────────────────────────────────
  stage('4. 声纹向量（会议分人和"只认我的声音"都靠它）')

  const emb = await owc.executeJavaScript(`(async () => {
    await window.kuaishuo.asr.ensureSpeakerModel()
    const rate = 16000, n = rate * 2
    const pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / rate
      pcm[i] = (Math.sin(2 * Math.PI * 140 * t) + 0.4 * Math.sin(2 * Math.PI * 430 * t)) * 0.2
    }
    const r = await window.kuaishuo.asr.transcribe({ samples: pcm, sampleRate: rate, withEmbedding: true })
    return { ok: r.ok, error: r.error, dim: r.embedding ? r.embedding.length : 0, finite: r.embedding ? r.embedding.every(Number.isFinite) : false }
  })()`)
  check('声纹模型可用且返回向量', emb?.ok === true && emb.dim > 0, emb?.error || JSON.stringify(emb))
  info('向量维度', emb?.dim)
  check('向量是有限数（不是 NaN）', emb?.finite === true)

  return finish()
}

function finish() {
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${failed.length ? '\x1b[31m' : '\x1b[32m'}${results.length - failed.length}/${results.length}\x1b[0m`)
  if (failed.length) console.log('失败：\n' + failed.map((f) => `  · ${f.label}`).join('\n'))
  return failed.length ? 1 : 0
}

module.exports = { run }
