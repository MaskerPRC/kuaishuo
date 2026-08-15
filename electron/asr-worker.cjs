// Off-main-thread sherpa-onnx SenseVoice ASR host. Spawned by asr-service.cjs
// via worker_threads: OfflineRecognizer.decode() is synchronous and CPU-bound,
// so running it in main would freeze IPC and renderer drawing for the duration
// of every utterance.
//
// Protocol (parentPort.postMessage):
//   in : { type: 'init',       modelPath, tokensPath, language, numThreads }
//   in : { type: 'init-speaker', modelPath }
//   in : { type: 'transcribe', id, samples: ArrayBuffer, sampleRate, withEmbedding? }
//   in : { type: 'dispose' }
//   out: { type: 'ready' }
//   out: { type: 'speaker-ready' }
//   out: { type: 'result', id, text, ms, embedding? }
//   out: { type: 'error',  id?, message }
//
// samples is Float32 PCM as a transferable ArrayBuffer.

const { parentPort } = require('worker_threads')

let sherpa = null
let recognizer = null
// Speaker-embedding extractor (3D-Speaker CAM++). Optional: only built when the
// user turns on "only my voice", so nobody who doesn't want it pays the 28MB or
// the ~90ms per utterance.
let speaker = null

// A single utterance sent to SenseVoice in one piece. The encoder is
// self-attention — cost is quadratic in frame count, so a long clip degrades
// badly (REAPER measured 18.3 ms/s at 15s vs 41.1 ms/s at 90s). Chat
// utterances are endpointed at 30s upstream, so we only ever split in the
// worst case; 18s is the measured sweet spot.
const MAX_CHUNK_SEC = 18

function log(...args) { console.log('[asr-worker]', ...args) }

function loadSherpa() {
  if (sherpa) return sherpa
  // sherpa-onnx-node ships per-platform native .node binaries; require resolves
  // the right one at load time. Errors are caught by the message handler and
  // reported back cleanly instead of killing the worker silently.
  sherpa = require('sherpa-onnx-node')
  return sherpa
}

function init(msg) {
  const so = loadSherpa()
  const t0 = Date.now()
  recognizer = new so.OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: msg.modelPath,
        // Chat input is overwhelmingly one language; 'auto' spends an extra
        // step on language ID and mis-detects on short utterances.
        language: msg.language && msg.language !== 'auto' ? msg.language : 'zh',
        useInverseTextNormalization: true,
      },
      tokens: msg.tokensPath,
      numThreads: msg.numThreads || 2,
      provider: 'cpu',
      debug: false,
    },
  })
  log('recognizer ready in', Date.now() - t0, 'ms')
  parentPort.postMessage({ type: 'ready' })
}

// ArrayBuffers arriving through a worker_threads transfer are marked
// "external" on this side, and sherpa-onnx-node's native layer rejects those
// ("External buffers are not allowed"). Copy into a fresh V8-owned array —
// same lesson as tts-worker.cjs's adoptSamples().
function adoptSamples(buf) {
  const view = new Float32Array(buf)
  const out = new Float32Array(view.length)
  out.set(view)
  return out
}

function initSpeaker(msg) {
  const so = loadSherpa()
  const t0 = Date.now()
  speaker = new so.SpeakerEmbeddingExtractor({
    model: msg.modelPath, numThreads: 1, debug: false, provider: 'cpu',
  })
  log('speaker extractor ready in', Date.now() - t0, 'ms')
  parentPort.postMessage({ type: 'speaker-ready' })
}

function embedSpeaker(pcm, sampleRate) {
  if (!speaker) return null
  const s = speaker.createStream()
  s.acceptWaveform({ sampleRate, samples: pcm })
  s.inputFinished()
  // `enableExternalBuffer` defaults to TRUE, which makes the addon hand back a
  // C++-backed ArrayBuffer. Electron refuses to wrap those — "External buffers
  // are not allowed" — even though plain Node accepts them, which is why this
  // passed a Node-side test and still broke in the app. Same trap the TTS
  // worker documents at tts-worker.cjs:136; force a V8-owned allocation.
  const v = speaker.compute(s, false)
  // Copy again into a plain array so the value crossing the port is ordinary
  // structured-cloneable data.
  return Array.from(v)
}

function decodeSlice(pcm, sampleRate, from, to) {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate, samples: pcm.subarray(from, to) })
  recognizer.decode(stream)
  const r = recognizer.getResult(stream)
  return (r.text || '').trim()
}

function transcribe({ id, samples, sampleRate, withEmbedding }) {
  if (!recognizer) throw new Error('recognizer not initialized')
  const pcm = adoptSamples(samples)
  const rate = sampleRate || 16000
  // Embedding first, on the same buffer: one audio transfer serves both, and
  // the caller can reject a non-matching speaker without waiting on the decode.
  const embedding = withEmbedding ? embedSpeaker(pcm, rate) : null
  const t0 = Date.now()

  const maxLen = MAX_CHUNK_SEC * rate
  let text
  if (pcm.length <= maxLen) {
    text = decodeSlice(pcm, rate, 0, pcm.length)
  } else {
    // Only reachable for a forced 30s endpoint. Split evenly rather than at
    // maxLen so the tail isn't a stub that decodes into a half-word.
    const parts = Math.ceil(pcm.length / maxLen)
    const step = Math.ceil(pcm.length / parts)
    const pieces = []
    for (let i = 0; i < parts; i++) {
      const got = decodeSlice(pcm, rate, i * step, Math.min(pcm.length, (i + 1) * step))
      if (got) pieces.push(got)
    }
    text = pieces.join('')
  }

  const ms = Date.now() - t0
  log('transcribed', 'id=' + id, 'samples=' + pcm.length, 'ms=' + ms, 'chars=' + text.length,
      'embedded=' + !!embedding)
  parentPort.postMessage({ type: 'result', id, text, ms, embedding })
}

function dispose() {
  try { recognizer && recognizer.free && recognizer.free() } catch { /* ignore */ }
  try { speaker && speaker.free && speaker.free() } catch { /* ignore */ }
  recognizer = null
  speaker = null
}

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'init':         return init(msg)
      case 'init-speaker': return initSpeaker(msg)
      case 'transcribe':   return transcribe(msg)
      case 'dispose':    return dispose()
      default:           throw new Error(`unknown message type: ${msg.type}`)
    }
  } catch (err) {
    log('message handler caught', 'type=' + (msg && msg.type), 'id=' + (msg && msg.id),
        'err=' + (err && err.message), '\n', err && err.stack)
    parentPort.postMessage({
      type: 'error',
      id: msg && msg.id,
      message: err && err.message ? err.message : String(err),
    })
  }
})
