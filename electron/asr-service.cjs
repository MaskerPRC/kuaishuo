// Main-process ASR orchestrator (SenseVoice-Small via sherpa-onnx-node). Owns:
//   • the model files on disk (userData/asr-models/...)
//   • a Node worker_thread holding the sherpa-onnx OfflineRecognizer
//   • IPC handlers the renderers talk to via window.kuaishuo.asr.*
//
// Everything runs locally. Nothing an input method hears should need a network
// round-trip to become text — not for latency, and not for the obvious reason
// that people dictate passwords, salaries and medical details into these things.
//
// Why SenseVoice rather than Whisper, measured on the same 15s Chinese clip:
//
//   whisper-small   3720ms (4.1x realtime)   model 465MB
//   SenseVoice       261ms (58.2x realtime)  model 239MB
//
// 14x faster on half the bytes is the difference between "speak a sentence and
// it appears" feeling like typing and feeling like waiting.

const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const https = require('https')
const http = require('http')
const os = require('os')
const { Worker } = require('worker_threads')

// ---- Constants -------------------------------------------------------------

// int8 build: ~228MB extracted (model.int8.onnx + tokens.txt). The 2024-07-17
// release emits punctuation; the newer 2025-09-09 one explicitly does not, and
// unpunctuated chat messages read badly, so we pin to 2024.
const MODEL_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const MODEL_URL  = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`

// Speaker verification (3D-Speaker CAM++, 28MB, 192-dim embeddings). Opt-in:
// only downloaded when the user turns on "only accept my voice". Measured on
// the SenseVoice archive's own multi-speaker test clips, same-speaker cosine
// ran 0.586-0.862 and different-speaker 0.047-0.422 — a clean gap, which is
// what makes a 0.5 threshold defensible rather than guessed.
// (The upstream release tag really is spelled "recongition".)
const SPK_NAME = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
const SPK_URL  = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPK_NAME}`

// The recognizer holds ~230MB resident. A chat app shouldn't carry that for a
// session where the user dictated once, and reloading costs only ~900ms.
const IDLE_UNLOAD_MS = 5 * 60_000

// Worker budget. Model construction is ~900ms and a 15s utterance decodes in
// ~260ms, so a timeout here means the worker genuinely hung (native crash,
// Electron/Node ABI mismatch producing SIGSEGV instead of a throw) — not a
// slow path. Without them the renderer's invoke would await forever.
const INIT_TIMEOUT_MS       = 30_000
const TRANSCRIBE_TIMEOUT_MS = 30_000

function dlog(...args) { console.log('[asr]', ...args) }

// ---- Module state ----------------------------------------------------------

let _ipc = null
let _getWindows = null
let _userDataDir = null

let _worker = null
let _workerReady = false
let _workerInitPromise = null
let _initTimeoutId = null
let _idleTimer = null

let _downloadPromise = null
let _downloadState = { stage: 'idle', progress: 0, message: '' }
let _spkPromise = null
let _spkLoaded = false

// One transcription in flight at a time (the worker decodes synchronously).
let _nextReqId = 1
const _pending = new Map() // id → { resolve, reject, timeoutId }

// ---- Helpers ---------------------------------------------------------------

// ---- Bundled models ---------------------------------------------------------
// A packaged build ships the weights inside it (resources/models/…), so a fresh
// install can dictate immediately instead of spending its first two minutes
// downloading 228MB from GitHub — which for users on the wrong side of a slow
// link was most of the first-run experience.
//
// The bundled copy is read-only and takes priority; the userData path stays as
// the fallback for a dev run, and for a build deliberately shipped without the
// weights. `process.resourcesPath` points at Electron's own resources in dev,
// where none of this exists, so the verify below is what keeps the two apart —
// no isPackaged check needed.

function bundledRoot() {
  try { return path.join(process.resourcesPath || '', 'models') } catch { return '' }
}
function bundledModelDir() { return path.join(bundledRoot(), MODEL_NAME) }
function bundledSpkPath()  { return path.join(bundledRoot(), SPK_NAME) }

/** True when this build carries the recogniser inside it. */
function hasBundledModel() {
  const root = bundledRoot()
  return !!root && verifyModelDir(bundledModelDir()).ok
}

function modelsRoot()  { return path.join(_userDataDir, 'asr-models') }
function modelDir()    {
  return hasBundledModel() ? bundledModelDir() : path.join(modelsRoot(), MODEL_NAME)
}
function stagingDir()  { return path.join(modelsRoot(), '.incoming') }
function modelTar()    { return path.join(modelsRoot(), `${MODEL_NAME}.tar.bz2`) }
function modelPath()   { return path.join(modelDir(), 'model.int8.onnx') }
function tokensPath()  { return path.join(modelDir(), 'tokens.txt') }

function spkPath() {
  // Same priority as the recogniser: a bundled copy wins, downloaded copy is
  // the fallback.
  try {
    if (fs.statSync(bundledSpkPath()).size >= MIN_SPK_BYTES) return bundledSpkPath()
  } catch { /* not bundled */ }
  return path.join(_userDataDir, 'speaker-models', SPK_NAME)
}

// The int8 SenseVoice weights are ~239MB and the token table ~316KB. These
// floors exist to answer one question — "is this a usable model or the first
// few megabytes of one" — and they are deliberately far below the real sizes so
// they can't start failing if upstream re-exports the model slightly smaller.
const MIN_MODEL_BYTES  = 100 * 1024 * 1024
const MIN_TOKENS_BYTES = 100 * 1024
const MIN_SPK_BYTES    = 5 * 1024 * 1024

/**
 * Is there a *complete* model installed at `dir`?
 *
 * Existence is not readiness, and the difference is a crash. Extraction creates
 * model.int8.onnx as an empty file and then spends ~20s filling it; during that
 * window a plain existsSync() check says the model is ready, the recogniser
 * gets constructed on a few kilobytes of a 239MB ONNX, and sherpa-onnx takes
 * the whole process down with it — no exception to catch, just a dead app.
 * Checking the size is what makes "ready" mean ready.
 *
 * Exported for the tests: this guard is the only thing standing between a
 * half-written file and a native crash, so it gets covered directly.
 */
function verifyModelDir(dir) {
  try {
    const m = fs.statSync(path.join(dir, 'model.int8.onnx'))
    const t = fs.statSync(path.join(dir, 'tokens.txt'))
    if (!m.isFile() || !t.isFile()) return { ok: false, reason: 'not-a-file' }
    if (m.size < MIN_MODEL_BYTES) return { ok: false, reason: 'model-truncated', size: m.size }
    if (t.size < MIN_TOKENS_BYTES) return { ok: false, reason: 'tokens-truncated', size: t.size }
    return { ok: true, size: m.size }
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'missing' : String(err.code || err.message) }
  }
}

function modelOnDisk() {
  return verifyModelDir(modelDir()).ok
}

function spkOnDisk() {
  // Same reasoning as verifyModelDir: the speaker model is downloaded to a
  // .partial and renamed, so a bare existsSync is safe here — but a size floor
  // also catches a file left behind by an older, buggier build.
  try { return fs.statSync(spkPath()).size >= MIN_SPK_BYTES } catch { return false }
}

function threadCount() {
  return Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)))
}

// Both the overlay and the console care about model progress (the overlay to
// show "下载模型 42%" in place of the ribbon, the console to drive its settings
// panel), so this fans out to every live window rather than to one designated
// main window.
function broadcast(channel, payload) {
  if (!_getWindows) return
  for (const win of _getWindows() || []) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload) } catch { /* ignore */ }
    }
  }
}

function setStage(stage, progress, message) {
  _downloadState.stage = stage
  if (typeof progress === 'number') _downloadState.progress = progress
  if (typeof message === 'string')  _downloadState.message = message
  broadcast('asr:progress', { ..._downloadState })
}

// Stream-download a URL to disk, following GitHub release redirects. Same
// implementation as tts-service.cjs's downloadTo (partial file + rename, so an
// interrupted download can never look complete).
function downloadTo(url, dest, stageName) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = dest + '.partial'
    let received = 0
    let total = 0

    function get(u, redirects = 0) {
      const client = u.startsWith('https') ? https : http
      const req = client.get(u, { headers: { 'user-agent': 'kuaishuo-asr/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects > 5) return reject(new Error('too many redirects'))
          return get(new URL(res.headers.location, u).toString(), redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`))
        }
        total = parseInt(res.headers['content-length'] || '0', 10) || 0
        const out = fs.createWriteStream(tmp)
        res.on('data', (chunk) => {
          received += chunk.length
          if (total) setStage(stageName, received / total)
        })
        res.pipe(out)
        out.on('finish', () => {
          out.close(() => fs.rename(tmp, dest, (err) => err ? reject(err) : resolve()))
        })
        out.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60_000, () => req.destroy(new Error('download timeout')))
    }
    get(url)
  })
}

async function extractTarBz2(tarBz2Path, intoDir, onProgress) {
  // Decompress the outer .bz2 with unbzip2-stream (pure JS), then pipe the tar
  // bytes into compressing's writable stream. Avoids spawning system tar
  // (Windows only gained it recently) and avoids any native deps.
  //
  // bzip2 is slow — ~21s for this archive on a warm machine — so progress is
  // reported off bytes consumed from the source. A 20-second step that shows
  // 0% throughout is the same "is it broken?" problem as a silent download.
  const compressing = require('compressing')
  const unbzip2     = require('unbzip2-stream')
  fs.mkdirSync(intoDir, { recursive: true })
  const total = fs.statSync(tarBz2Path).size
  let read = 0
  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(tarBz2Path)
    src.on('data', (c) => {
      read += c.length
      if (total) onProgress?.(read / total)
    })
    const sink = new compressing.tar.UncompressStream()
    sink.on('entry', (header, stream, next) => {
      const dest = path.join(intoDir, header.name)
      if (header.type === 'directory') {
        fs.mkdirSync(dest, { recursive: true })
        stream.resume()
        stream.on('end', next)
        return
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(dest)
      stream.pipe(out)
      // next() only once the file is fully flushed, which serialises entries
      // and means 'finish' below really is "everything is written".
      out.on('finish', next)
      out.on('error', reject)
      stream.on('error', reject)
    })
    sink.on('finish', resolve)
    sink.on('error', reject)
    src.on('error', reject)
    src.pipe(unbzip2()).pipe(sink)
  })
}

// ---- Model download --------------------------------------------------------

async function ensureModel() {
  // An install in flight beats a glance at the filesystem. Checking the disk
  // first would let a caller mid-extraction conclude "it's there" from a
  // directory that is still being populated — the exact race that fed a
  // half-written ONNX to the native recogniser and crashed the process.
  if (_downloadPromise) return _downloadPromise
  if (modelOnDisk()) { setStage('ready', 1); return }

  _downloadPromise = (async () => {
    try {
      if (!fs.existsSync(modelTar())) {
        setStage('downloading-model', 0, '下载语音识别模型')
        await downloadTo(MODEL_URL, modelTar(), 'downloading-model')
      }

      // Extract into a staging directory, verify, then move into place in one
      // atomic rename. modelDir() therefore only ever exists in two states —
      // absent, or complete — and no reader can catch it halfway. Same
      // discipline as the .partial file the download uses, for the same reason.
      setStage('extracting-model', 0, '解压模型')
      const staging = stagingDir()
      await fsp.rm(staging, { recursive: true, force: true })
      await extractTarBz2(modelTar(), staging, (p) => setStage('extracting-model', p))

      const extracted = path.join(staging, MODEL_NAME)
      const verdict = verifyModelDir(extracted)
      if (!verdict.ok) {
        // A truncated archive, a disk that filled up, an interrupted write. In
        // every case the download is the suspect, so drop it and let the next
        // attempt start clean rather than re-extracting the same bad bytes.
        await fsp.rm(staging, { recursive: true, force: true })
        try { await fsp.unlink(modelTar()) } catch {}
        throw new Error(`模型解压后校验失败（${verdict.reason}${verdict.size ? `, ${verdict.size}B` : ''}），已删除损坏的下载，请重试`)
      }

      await fsp.rm(modelDir(), { recursive: true, force: true })
      await fsp.rename(extracted, modelDir())
      await fsp.rm(staging, { recursive: true, force: true })
      try { await fsp.unlink(modelTar()) } catch {}

      setStage('ready', 1, '模型就绪')
    } catch (err) {
      setStage('error', _downloadState.progress, err.message || String(err))
      throw err
    } finally {
      _downloadPromise = null
    }
  })()
  return _downloadPromise
}

async function ensureSpeakerModel() {
  if (spkOnDisk()) { return }
  if (_spkPromise) return _spkPromise
  _spkPromise = (async () => {
    try {
      setStage('downloading-speaker', 0, '下载声纹模型')
      await downloadTo(SPK_URL, spkPath(), 'downloading-speaker')
      if (!spkOnDisk()) throw new Error('speaker model missing after download')
      setStage('ready', 1, '模型就绪')
    } catch (err) {
      setStage('error', _downloadState.progress, err.message || String(err))
      throw err
    } finally {
      _spkPromise = null
    }
  })()
  return _spkPromise
}

// ---- Worker lifecycle ------------------------------------------------------

function rejectInitPromise(message) {
  if (_workerInitPromise && _workerInitPromise._reject) {
    try { _workerInitPromise._reject(new Error(message)) } catch {}
  }
  _workerInitPromise = null
  if (_initTimeoutId) { clearTimeout(_initTimeoutId); _initTimeoutId = null }
}

function resolveInitPromise() {
  if (_workerInitPromise && _workerInitPromise._resolve) {
    try { _workerInitPromise._resolve() } catch {}
  }
  _workerInitPromise = null
  if (_initTimeoutId) { clearTimeout(_initTimeoutId); _initTimeoutId = null }
}

function failAllPending(message) {
  for (const [, h] of _pending) {
    if (h.timeoutId) clearTimeout(h.timeoutId)
    try { h.reject(new Error(message)) } catch {}
  }
  _pending.clear()
}

function ensureWorker() {
  if (_worker) return _worker
  // Closure-capture `worker` so each handler can tell whether it belongs to the
  // CURRENT worker or to one we already replaced — otherwise a torn-down
  // worker's late 'exit' event nulls out state the new worker now owns.
  const worker = new Worker(path.join(__dirname, 'asr-worker.cjs'))
  _worker = worker
  worker.on('message', (msg) => {
    if (_worker !== worker) return
    onWorkerMessage(msg)
  })
  worker.on('error', (err) => {
    const message = err && err.message ? err.message : String(err)
    if (_worker !== worker) { dlog('stale worker error (ignored):', message); return }
    console.warn('[asr] worker error', err)
    rejectInitPromise(message)
    failAllPending(message)
    teardownWorker()
  })
  worker.on('exit', (code) => {
    if (_worker !== worker) {
      if (code !== 0) console.warn('[asr] stale worker exited with code', code, '(ignored)')
      return
    }
    if (code !== 0) console.warn('[asr] worker exited with code', code)
    if (_workerInitPromise) rejectInitPromise(`worker exited (code ${code})`)
    failAllPending(`worker exited (code ${code})`)
    _worker = null
    _workerReady = false
  })
  return _worker
}

function teardownWorker() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
  _spkLoaded = false   // the extractor lived in that worker; it goes with it
  if (!_worker) return
  try { _worker.postMessage({ type: 'dispose' }) } catch {}
  try { _worker.terminate() } catch {}
  _worker = null
  _workerReady = false
  if (_workerInitPromise) rejectInitPromise('worker torn down')
}

function onWorkerMessage(msg) {
  if (msg.type === 'ready') {
    _workerReady = true
    resolveInitPromise()
    return
  }
  if (msg.type === 'speaker-ready') {
    _spkLoaded = true
    return
  }
  if (msg.type === 'result') {
    const h = _pending.get(msg.id)
    if (!h) return
    _pending.delete(msg.id)
    if (h.timeoutId) clearTimeout(h.timeoutId)
    h.resolve({ text: msg.text || '', ms: msg.ms || 0, embedding: msg.embedding || null })
    return
  }
  if (msg.type === 'error') {
    const h = msg.id != null ? _pending.get(msg.id) : null
    if (h) {
      _pending.delete(msg.id)
      if (h.timeoutId) clearTimeout(h.timeoutId)
      h.reject(new Error(msg.message || 'asr worker error'))
    }
    // Init errors arrive without an id (the init message carried none).
    if (_workerInitPromise) rejectInitPromise(msg.message)
    return
  }
}

async function ensureWorkerInitialized() {
  ensureWorker()
  if (_workerReady) return
  if (_workerInitPromise) return _workerInitPromise

  const p = new Promise((resolve, reject) => {
    _workerInitPromise = { _resolve: resolve, _reject: reject }
  })
  _workerInitPromise = Object.assign(p, _workerInitPromise || {})

  _initTimeoutId = setTimeout(() => {
    _initTimeoutId = null
    rejectInitPromise(`ASR worker init timed out after ${INIT_TIMEOUT_MS / 1000}s`)
    teardownWorker()
  }, INIT_TIMEOUT_MS)

  dlog('init→worker', 'model=' + modelPath())
  try {
    _worker.postMessage({
      type: 'init',
      modelPath: modelPath(),
      tokensPath: tokensPath(),
      language: 'zh',
      numThreads: threadCount(),
    })
  } catch (err) {
    rejectInitPromise(err && err.message || String(err))
    throw err
  }
  return p
}

// Drop the recognizer after a stretch with no transcriptions. Re-arms on every
// call, so an active dictation session never trips it.
function armIdleUnload() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    _idleTimer = null
    if (_pending.size) return   // still busy — the next call re-arms
    dlog('idle for', IDLE_UNLOAD_MS / 1000, 's — unloading recognizer')
    teardownWorker()
  }, IDLE_UNLOAD_MS)
}

// ---- IPC handlers ----------------------------------------------------------

function handleStatus() {
  return {
    modelOnDisk: modelOnDisk(),
    speakerModelOnDisk: spkOnDisk(),
    workerReady: _workerReady,
    state: { ..._downloadState },
    modelDir: modelDir(),
    modelName: MODEL_NAME,
    bundled: hasBundledModel(),
  }
}

async function handleEnsureSpeakerModel() {
  try {
    await ensureSpeakerModel()
    return { ok: true, state: { ..._downloadState } }
  } catch (err) {
    return { ok: false, error: err.message || String(err), state: { ..._downloadState } }
  }
}

async function handleEnsureModel(_event, opts) {
  try {
    await ensureModel()
    if (opts && opts.preloadWorker) await ensureWorkerInitialized()
    return { ok: true, state: { ..._downloadState } }
  } catch (err) {
    return { ok: false, error: err.message || String(err), state: { ..._downloadState } }
  }
}

async function handleClearModel() {
  teardownWorker()
  // Never delete what the installer put there: it is read-only, it is not the
  // user's to reclaim, and removing it would leave the app permanently unable
  // to find a model it is still shipping.
  if (hasBundledModel()) {
    return { ok: false, error: '这个版本自带识别模型，无法删除' }
  }
  try {
    await fsp.rm(modelDir(), { recursive: true, force: true })
    await fsp.rm(stagingDir(), { recursive: true, force: true })
    try { await fsp.unlink(modelTar()) } catch {}
    _downloadState = { stage: 'idle', progress: 0, message: '' }
    broadcast('asr:progress', { ..._downloadState })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

async function handleTranscribe(_event, payload) {
  // payload = { samples: Float32Array | ArrayBuffer, sampleRate }
  try {
    const raw = payload && payload.samples
    if (!raw) return { ok: false, error: 'missing samples' }
    // Electron's structured clone hands us a Float32Array (or its buffer,
    // depending on how the renderer packed it). Normalize to an ArrayBuffer we
    // can transfer into the worker without a copy.
    const view = ArrayBuffer.isView(raw) ? new Float32Array(raw.buffer, raw.byteOffset, raw.length)
                                         : new Float32Array(raw)
    if (!view.length) return { ok: true, text: '' }
    const buf = view.buffer.byteLength === view.byteLength && view.byteOffset === 0
      ? view.buffer
      : view.slice().buffer

    await ensureModel()
    await ensureWorkerInitialized()

    // Speaker verification is opt-in and lazy: the model is only fetched and
    // the extractor only built the first time an utterance actually asks for
    // an embedding.
    const withEmbedding = !!(payload && payload.withEmbedding)
    if (withEmbedding && !_spkLoaded) {
      await ensureSpeakerModel()
      _worker.postMessage({ type: 'init-speaker', modelPath: spkPath() })
      // The extractor ctor is ~350ms and the worker handles messages in order,
      // so the transcribe queued next already sees it. Mark it optimistically;
      // a failure comes back as a normal worker error.
      _spkLoaded = true
    }

    const id = _nextReqId++
    const result = await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        _pending.delete(id)
        // A hang here means the native decode deadlocked; the worker can't be
        // preempted, so replace it wholesale rather than leaving it wedged.
        teardownWorker()
        reject(new Error(`transcribe timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s`))
      }, TRANSCRIBE_TIMEOUT_MS)
      _pending.set(id, { resolve, reject, timeoutId })
      try {
        _worker.postMessage(
          { type: 'transcribe', id, samples: buf, sampleRate: payload.sampleRate || 16000, withEmbedding },
          [buf],
        )
      } catch (err) {
        _pending.delete(id)
        clearTimeout(timeoutId)
        reject(err)
      }
    })
    armIdleUnload()
    return { ok: true, text: result.text, ms: result.ms, embedding: result.embedding }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

// ---- Public registration ---------------------------------------------------

function init({ ipcMain, getWindows, userDataDir }) {
  _ipc         = ipcMain
  _getWindows  = getWindows
  _userDataDir = userDataDir
  fs.mkdirSync(path.join(_userDataDir, 'asr-models'), { recursive: true })

  _ipc.handle('asr:status',       handleStatus)
  _ipc.handle('asr:ensure-model', handleEnsureModel)
  _ipc.handle('asr:ensure-speaker-model', handleEnsureSpeakerModel)
  _ipc.handle('asr:clear-model',  handleClearModel)
  _ipc.handle('asr:transcribe',   handleTranscribe)
}

// Fetch the model in the background, before anyone asks for it.
//
// Without this, the first thing a new user does — press the mic — is answered
// by a two-minute progress number and nothing else, which is indistinguishable
// from a broken app. (It was reported as exactly that.) The recogniser is this
// product's only reason to exist, so treating its weights as an optional extra
// that gets fetched on first use is a fiction; better to have them on disk
// before the first press. No microphone is opened, so nothing lights up.
function prefetch() {
  // Nothing to fetch when the build carries the weights.
  if (modelOnDisk()) { setStage('ready', 1); return Promise.resolve() }
  return ensureModel().catch((err) => {
    // Nothing to surface here: the state is already broadcast, the settings
    // panel shows it, and a failed prefetch just means the download happens on
    // first use instead.
    dlog('prefetch failed:', err.message || err)
  })
}

function dispose() {
  failAllPending('app shutting down')
  teardownWorker()
}

module.exports = {
  init, dispose, prefetch,
  verifyModelDir, MIN_MODEL_BYTES, MIN_TOKENS_BYTES,
  MODEL_NAME, SPK_NAME,
}
