// Thin bridge over window.kuaishuo.asr plus the audio maths callers need to get
// from "frames off an AudioWorklet" to "16 kHz mono Float32", which is what
// SenseVoice wants. The model and the inference live in the main process; this
// file never sees either.

const TARGET_RATE = 16000

export function isAsrSupported() {
  return typeof window !== 'undefined' && !!window.kuaishuo?.asr
}

function bridge() {
  if (!isAsrSupported()) throw new Error('语音识别只在桌面客户端可用')
  return window.kuaishuo.asr
}

// ---- Transcription ----------------------------------------------------------

/**
 * One utterance. `withEmbedding` additionally returns the 192-dim speaker
 * vector computed off the same buffer — one IPC and one audio transfer serves
 * both the text and the "is this the right person" question.
 */
export async function transcribeDetailed(samples, sampleRate = TARGET_RATE, { withEmbedding = false } = {}) {
  if (!samples?.length) return { text: '', embedding: null, ms: 0 }
  const r = await bridge().transcribe({ samples, sampleRate, withEmbedding })
  if (!r?.ok) throw new Error(r?.error || 'transcribe failed')
  return { text: r.text || '', embedding: r.embedding || null, ms: r.ms || 0 }
}

export async function transcribePcm(samples, sampleRate = TARGET_RATE) {
  return (await transcribeDetailed(samples, sampleRate)).text
}

// Cosine similarity between two speaker embeddings. Measured on labelled clips:
// same speaker 0.586-0.862, different speakers 0.047-0.422.
export function embeddingSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10)
}

// ---- Resampling -------------------------------------------------------------

/**
 * Resample a mono Float32Array (straight off the worklet, at the device rate)
 * down to 16 kHz. OfflineAudioContext does it in one render pass on the audio
 * thread, which beats anything hand-written here.
 */
export async function resampleTo16k(samples, sourceRate) {
  if (!samples?.length) return samples
  if (sourceRate === TARGET_RATE) return samples
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const frames = Math.max(1, Math.ceil((samples.length / sourceRate) * TARGET_RATE))
  const offline = new Ctx(1, frames, TARGET_RATE)
  // The source buffer must be created at the SOURCE rate; the graph resamples
  // on render.
  const buf = offline.createBuffer(1, samples.length, sourceRate)
  buf.copyToChannel(samples, 0)
  const src = offline.createBufferSource()
  src.buffer = buf
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

// ---- Model management -------------------------------------------------------

export async function getAsrStatus() {
  if (!isAsrSupported()) return null
  return bridge().status()
}

export async function ensureAsrModel({ preloadWorker = false } = {}) {
  return bridge().ensureModel({ preloadWorker })
}

export async function ensureSpeakerModel() {
  return bridge().ensureSpeakerModel()
}

export async function clearAsrModel() {
  return bridge().clearModel()
}

/** { stage, progress, message }; stage ∈ idle|downloading-model|extracting-model|downloading-speaker|ready|error */
export function onAsrProgress(callback) {
  if (!isAsrSupported()) return () => {}
  return bridge().onProgress(callback)
}
