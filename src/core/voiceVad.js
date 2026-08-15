// Shared microphone + voice-activity primitives.
//
// Extracted so the settings preview and the live dictation path run the SAME
// capture and the SAME threshold arithmetic. A sensitivity preview that
// re-implements the maths is worse than no preview: it would show the user a
// threshold the recogniser doesn't actually use, and they'd tune against a lie.

// ---- Frame geometry --------------------------------------------------------
// One frame = one worklet block. At 48 kHz that's ~21ms, close to the 25ms
// frames REAPER's VAD measured its thresholds against.
export const WORKLET_BLOCK = 1024

// ---- Noise floor -----------------------------------------------------------
// Measured on a real mic in a quiet room: ambient frames ran min -67, p50
// -44.6, p90 -33.8 dB. That ~30 dB frame-to-frame spread is the whole design
// problem — any floor estimate taken from a SINGLE frame lands wherever that
// frame happened to fall, and about half the time it lands far below the
// median. An early version seeded from frame 0, drew -58.2, set the threshold
// to -49.2, and two thirds of that silent room then read as speech.
//
// So: estimate from a distribution, and keep updating it even while the user is
// mid-sentence. A floor that drifts releases early (mildly annoying); a floor
// that freezes never releases at all (feature is dead).
export const FLOOR_WINDOW_FRAMES = 190   // ~4s at 21ms/frame
export const FLOOR_PERCENTILE    = 0.2
export const FLOOR_RECALC_EVERY  = 8     // frames; sorting 190 floats 6×/s is free
export const NOISE_FLOOR_MIN_DB  = -75   // below this is a digital-silence artifact, not a room

// ---- Sensitivity -----------------------------------------------------------
// How far above the noise floor a frame must sit before it counts as the start
// of speech. This is the one knob that decides "did the user speak or did a
// chair creak", and the right value depends on the room and the mic — which is
// why it's a user setting with a live preview rather than a constant someone
// guessed once.
export const SENSITIVITY_LEVELS = [
  { id: 'high',   attackDb: 11 },  // catches soft speech; fires on more room noise
  { id: 'medium', attackDb: 16 },  // default
  { id: 'low',    attackDb: 22 },  // only clear close-mic speech gets through
]
export const DEFAULT_SENSITIVITY = 'medium'

export function attackDbFor(sensitivity) {
  const hit = SENSITIVITY_LEVELS.find((s) => s.id === sensitivity)
  return (hit || SENSITIVITY_LEVELS.find((s) => s.id === DEFAULT_SENSITIVITY)).attackDb
}

// Leaving speech is deliberately NOT tied to sensitivity. Making it harder to
// enter should never make it harder to leave — that's the combination that
// strands a session in "still talking" forever.
export const RELEASE_MARGIN_DB = 8

// ---- Helpers ---------------------------------------------------------------

export function frameDb(data) {
  let sumSq = 0
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i]
  return 20 * Math.log10(Math.sqrt(sumSq / data.length) + 1e-10)
}

/** Rolling low-percentile noise floor. Feed it every frame, in every state. */
export function createFloorTracker() {
  const ring = new Float32Array(FLOOR_WINDOW_FRAMES)
  let count = 0
  let idx = 0
  let countdown = 0
  let floorDb = -60

  return {
    get floorDb() { return floorDb },
    reset() {
      ring.fill(0); count = 0; idx = 0; countdown = 0; floorDb = -60
    },
    push(db) {
      // Skip suppressor-gated frames. Chromium's noiseSuppression hard-gates
      // quiet moments to (near) digital silence, and those zeros are NOT room
      // tone — they're the absence of a signal. Measured in a real room they
      // dominated the bottom of the window and pinned the p20 estimate at the
      // -75 clamp while the audible ambient sat around -45, so the threshold
      // came out ~20 dB too low and the room kept tripping the detector.
      // Estimating from the frames that actually carry sound is the difference
      // between measuring the room and measuring the gate.
      if (db > NOISE_FLOOR_MIN_DB) {
        ring[idx] = db
        idx = (idx + 1) % ring.length
        if (count < ring.length) count++
      }
      if (countdown-- > 0) return floorDb
      countdown = FLOOR_RECALC_EVERY
      // Until a few real frames have landed, keep the conservative default
      // rather than deriving a floor from one or two samples.
      if (count < 8) return floorDb
      // Percentiles don't care about order, so the ring can be sorted as-is.
      const sorted = Array.from(ring.subarray(0, count)).sort((a, b) => a - b)
      const p = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * FLOOR_PERCENTILE))]
      floorDb = Math.max(NOISE_FLOOR_MIN_DB, p)
      return floorDb
    },
  }
}

// ---- Mic tap ---------------------------------------------------------------
// AudioWorklet module built at runtime into a Blob URL — no extra file to ship,
// no vite asset config, and the renderer has no CSP to fight (only
// electron/setup/data-location.html sets one).
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Float32Array(${WORKLET_BLOCK})
    this._n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i]
      if (this._n === this._buf.length) {
        this.port.postMessage(this._buf.slice(0))
        this._n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

let _workletUrl = null
function workletUrl() {
  if (!_workletUrl) _workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
  return _workletUrl
}

/**
 * Wrap a MediaStream in the capture graph: worklet frames out, optional
 * spectrum tap, everything torn down by one close().
 *
 * @param {MediaStream} stream
 * @param {object} o
 * @param {Function} o.onFrame          (Float32Array) => void, ~47×/s
 * @param {boolean} [o.analyser=false]  also expose an AnalyserNode for spectra
 * @param {boolean} [o.downmix=false]   force multi-channel input to mono
 * @returns {Promise<{sampleRate:number, analyser:AnalyserNode|null, stream:MediaStream, close:Function}>}
 */
async function buildTap(stream, { onFrame, analyser: wantAnalyser = false, downmix = false }) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  // The mic path has never needed this: Chromium's autoplay policy exempts a
  // document holding a granted getUserMedia, so its context starts running.
  // Display capture is a different grant and may not buy the same exemption,
  // and a suspended context fails silently — the graph builds, the tracks are
  // live, and not one frame ever arrives. Cheap to ask; no-op when running.
  try { await ctx.resume() } catch {}
  try {
    await ctx.audioWorklet.addModule(workletUrl())
  } catch (err) {
    for (const t of stream.getTracks()) { try { t.stop() } catch {} }
    try { await ctx.close() } catch {}
    throw err
  }

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-tap')
  node.port.onmessage = (e) => onFrame(e.data)

  // The worklet reads inputs[0][0] and nothing else, so a stereo source would
  // silently become its left channel — half the loopback signal, and the wrong
  // half whenever a meeting app pans the remote voice. An explicit mono gain
  // node in front does the standard equal-power downmix instead.
  let head = source
  let mono = null
  if (downmix) {
    mono = ctx.createGain()
    mono.channelCount = 1
    mono.channelCountMode = 'explicit'
    mono.channelInterpretation = 'speakers'
    source.connect(mono)
    head = mono
  }

  // A worklet whose output goes nowhere isn't guaranteed to be pulled by the
  // rendering graph. Route it to the destination through a muted gain so it
  // always runs and never reaches the speakers.
  const mute = ctx.createGain()
  mute.gain.value = 0
  head.connect(node)
  node.connect(mute)
  mute.connect(ctx.destination)

  let analyserNode = null
  if (wantAnalyser) {
    analyserNode = ctx.createAnalyser()
    analyserNode.fftSize = 512
    analyserNode.smoothingTimeConstant = 0.7
    head.connect(analyserNode)
  }

  return {
    sampleRate: ctx.sampleRate,
    analyser: analyserNode,
    stream,
    async close() {
      try { node.port.onmessage = null } catch {}
      for (const n of [source, mono, node, mute, analyserNode]) { try { n?.disconnect() } catch {} }
      for (const t of stream.getTracks()) { try { t.stop() } catch {} }
      try { await ctx.close() } catch {}
    },
  }
}

/**
 * Open the mic and stream raw Float32 frames.
 *
 * @param {object} o
 * @param {string} [o.deviceId]        '' / undefined = system default
 * @param {Function} o.onFrame         (Float32Array) => void, ~47×/s
 * @param {boolean} [o.analyser=false] also expose an AnalyserNode for spectra
 * @returns {Promise<{sampleRate:number, analyser:AnalyserNode|null, stream:MediaStream, close:Function}>}
 */
export async function openMicTap({ deviceId, onFrame, analyser: wantAnalyser = false }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // Echo cancellation matters: with TTS reading a reply aloud, an open mic
      // would otherwise transcribe the app's own voice and send it straight
      // back as 插话.
      echoCancellation: true,
      noiseSuppression: true,
      // AGC deliberately OFF. It raises gain during pauses, walking the room
      // tone up toward speech level and squeezing the very gap the endpointer
      // is looking for. SenseVoice normalizes internally, so the only thing AGC
      // bought here was a harder VAD problem.
      autoGainControl: false,
    },
  })
  return buildTap(stream, { onFrame, analyser: wantAnalyser })
}

// How long to give Chromium to tear the audio track down after the video track
// is stopped, before concluding it survived. The transition is synchronous in
// the browser process and arrives on the next few task-queue turns; this is
// slack, not a measurement.
const LOOPBACK_SETTLE_MS = 250

// null = not yet learned. See openSystemAudioTap.
let _loopbackNeedsVideo = null

/**
 * Whether this build can capture what the machine is playing at all.
 * Electron's `audio: 'loopback'` is Windows-only; everywhere else the feature
 * is inert rather than broken, and the UI says so instead of offering a switch
 * that cannot do anything.
 */
export function isSystemAudioSupported() {
  return typeof window !== 'undefined' && window.kuaishuo?.platform === 'win32'
}

/**
 * Open a tap on what the machine is *playing* — the remote half of a call,
 * rather than whatever of it leaks back into the microphone.
 *
 * Windows only: this rides Electron's `audio: 'loopback'`, which has no macOS
 * or Linux equivalent. Main decides that (see the display-media handler in
 * electron/main.cjs); here a rejection is just a rejection.
 *
 * Video is requested because Chromium will not open a display-capture session
 * without it, and then dropped — we want the sound card, not the screen.
 * Whether dropping it also drops the audio is a Chromium implementation
 * detail, so this probes rather than assumes: if no frame arrives, it reopens
 * and keeps the video track alive but disabled.
 *
 * @param {object} o
 * @param {Function} o.onFrame  (Float32Array) => void
 * @returns {Promise<{sampleRate:number, analyser:null, stream:MediaStream, keptVideo:boolean, close:Function}>}
 */
export async function openSystemAudioTap({ onFrame }) {
  // Whether dropping the video track is survivable is a property of the
  // Chromium build, not of this call, so it is learned once and remembered.
  // Retrying costs a second getDisplayMedia — which spends a second transient
  // user activation, and the case where activation is scarce is exactly the
  // case where the retry would be needed. Once per run, never per meeting.
  async function attempt(dropVideo) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // A video source is required, and not merely by convention: asking for
      // `{audio: true}` alone does not fail, it **never settles** — the promise
      // hangs forever and the meeting silently gets no far-end audio. Tried,
      // measured, reverted. Main pays a one-off ~390ms for the capturer to come
      // up; see warmCapturer in main.cjs for where that cost is moved to.
      //
      // Constrained to almost nothing: if the track has to stay alive it must
      // not be a full-resolution duplication of a 4K desktop nobody reads.
      video: { width: { max: 320 }, height: { max: 180 }, frameRate: { max: 1 } },
      audio: true,
    })
    const audio = stream.getAudioTracks()[0]
    if (!audio) {
      for (const t of stream.getTracks()) { try { t.stop() } catch {} }
      throw new Error('loopback-no-audio')
    }
    for (const t of stream.getVideoTracks()) {
      // Disabled either way: even when the track is kept alive to hold the
      // capture session open, nothing should be decoding screen pixels.
      t.enabled = false
      if (dropVideo) { try { t.stop() } catch {} }
    }
    await new Promise((r) => setTimeout(r, LOOPBACK_SETTLE_MS))
    // Liveness cannot be probed by waiting for frames: a MediaStreamAudioSource
    // whose track has ended still gets pulled by the graph and still posts
    // blocks of zeros, and a live capture of a quiet machine posts exactly the
    // same thing. `readyState` is the signal that distinguishes them.
    //
    // `muted` deliberately does NOT appear here. It means "the source is
    // producing no data right now", which is the honest and expected state of a
    // machine with nothing playing — treating it as death would make the
    // feature fail hardest on the quietest desktop, and fail in the one way
    // that is indistinguishable from a real fault.
    return { stream, audio, alive: audio.readyState === 'live' }
  }

  if (_loopbackNeedsVideo === true) {
    const a = await attempt(false)
    if (!a.alive) { for (const t of a.stream.getTracks()) { try { t.stop() } catch {} } ; throw new Error('loopback-died') }
    return { ...(await buildTap(a.stream, { onFrame, downmix: true })), keptVideo: true }
  }

  let a = await attempt(true)
  let keptVideo = false
  if (!a.alive) {
    // Stopping the video track took the whole session down with it. Pay for a
    // screen capture we never read rather than lose the audio — and remember,
    // so no later meeting spends a user gesture rediscovering this.
    for (const t of a.stream.getTracks()) { try { t.stop() } catch {} }
    _loopbackNeedsVideo = true
    a = await attempt(false)
    keptVideo = true
    if (!a.alive) {
      for (const t of a.stream.getTracks()) { try { t.stop() } catch {} }
      throw new Error('loopback-died')
    }
  } else {
    _loopbackNeedsVideo = false
  }

  const tap = await buildTap(a.stream, { onFrame, downmix: true })
  return { ...tap, keptVideo }
}

// ---- Transcript sanity -----------------------------------------------------
// SenseVoice fed a cough, a door, or someone else's voice across the room
// usually returns '', but not always — it emits a lone comma, or a single
// syllable like 嗯 / 哎 / 是. With auto-send on those land in the agent's lap as
// if the user had said them, and a stray 嗯 mid-task is worse than a dropped
// word: the agent acts on it.
//
// So one character is not accepted. It does cost the occasional real one-word
// command (停 / 好), which is a deliberate trade — the observed failure was a
// conversation peppered with 嗯 bubbles nobody said. Raising this back to 1 is a
// one-character edit if it ever proves wrong.
const MIN_TRANSCRIPT_CHARS = 2

// Cosine below this and the utterance didn't come from the enrolled speaker.
// Picked from the measured gap (same 0.586-0.862, different 0.047-0.422), not
// guessed — it sits in the empty middle, so both error directions need a large
// deviation from what was observed before they start happening.
export const VOICEPRINT_THRESHOLD = 0.5

export function isMeaningfulTranscript(text) {
  if (!text) return false
  // Strip punctuation and symbols; what's left is the actual content.
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length >= MIN_TRANSCRIPT_CHARS
}

// ---- VAD channel -----------------------------------------------------------
// One source of audio, endpointed independently: its own capture buffer, its
// own noise floor, its own notion of whether someone is mid-sentence.
//
// This used to be flat closure state inside useDictation, which was fine while
// there was exactly one microphone and nothing else. It isn't fine with a
// second source: mixing the machine's own output into the mic signal would feed
// a video's continuous audio into the same rolling floor estimate the mic
// endpointer depends on, and the floor would walk up until the mic never
// released. Two channels, two floors, one queue.
//
// Deliberately free of DOM and of the settings module — the thresholds arrive
// as getters, so this runs in plain Node and test/vad.test.js can drive it with
// synthetic frames instead of a microphone.

const ATTACK_FRAMES = 3           // consecutive hot frames to enter speech (de-glitch)
const MIN_SPEECH_MS = 350         // shorter than this = cough / key click, discarded
const MAX_UTTER_MS  = 30_000      // hard endpoint; nobody dictates one 30s sentence
const PRE_ROLL_MS   = 250         // audio kept before the attack so first syllables survive
const POST_ROLL_MS  = 150         // audio kept after the release so trailing sounds survive
// An utterance whose loudest moment only just cleared the attack threshold was
// a noise that squeaked over the line, not someone talking.
const MIN_PEAK_OVER_ATTACK_DB = 4
// Second, independent release gate, measured against the utterance's OWN peak.
// Even if the floor estimate is off, dropping this far below what the speaker
// was just producing, for the full silence window, is unambiguously "done".
const PEAK_DROP_DB = 28

export const VAD_TUNING = {
  ATTACK_FRAMES, MIN_SPEECH_MS, MAX_UTTER_MS, PRE_ROLL_MS, POST_ROLL_MS,
  MIN_PEAK_OVER_ATTACK_DB, PEAK_DROP_DB,
}

/**
 * @param {object} o
 * @param {number} o.sampleRate
 * @param {() => number} o.getAttackDb    how far over the floor counts as speech
 * @param {() => number} o.getSilenceMs   silence that ends a sentence
 * @param {(u: {pcm: Float32Array, sampleRate: number, speechMs: number}) => void} o.onUtterance
 * @param {() => number} [o.now]          injectable clock, for tests
 */
export function createVadChannel({ sampleRate, getAttackDb, getSilenceMs, onUtterance, now = Date.now }) {
  // ---- Capture buffer -------------------------------------------------------
  // Chunks tagged with their absolute sample offset. Extracting an utterance is
  // then a plain [from, to) copy with no ring-buffer wraparound to get wrong.
  let chunks = []
  let absWritten = 0
  let rate = sampleRate
  let frameMs = (WORKLET_BLOCK / rate) * 1000
  let keepSamples = Math.ceil(((MAX_UTTER_MS + PRE_ROLL_MS + POST_ROLL_MS) / 1000) * rate)

  // ---- VAD state ------------------------------------------------------------
  const floor = createFloorTracker()
  let inSpeech = false
  let hot = 0
  let silentFrames = 0
  let speechStartAbs = 0
  let lastVoicedAbs = 0
  let speechPeakDb = -200
  let attackFloorDb = -60
  let lastFrameAt = now()

  function releaseFrames() {
    return Math.max(2, Math.round((getSilenceMs() || 900) / frameMs))
  }

  function appendChunk(data) {
    chunks.push({ start: absWritten, data })
    absWritten += data.length
    while (chunks.length > 1) {
      const head = chunks[0]
      if (head.start + head.data.length >= absWritten - keepSamples) break
      chunks.shift()
    }
  }

  function extract(fromAbs, toAbs) {
    const from = Math.max(fromAbs, chunks.length ? chunks[0].start : 0)
    const to = Math.min(toAbs, absWritten)
    if (to <= from) return null
    const out = new Float32Array(to - from)
    for (const c of chunks) {
      const cEnd = c.start + c.data.length
      if (cEnd <= from || c.start >= to) continue
      const srcFrom = Math.max(0, from - c.start)
      const srcTo = Math.min(c.data.length, to - c.start)
      out.set(c.data.subarray(srcFrom, srcTo), c.start + srcFrom - from)
    }
    return out
  }

  function endUtterance() {
    const endAbs = lastVoicedAbs + Math.round((POST_ROLL_MS / 1000) * rate)
    const startAbs = Math.max(0, speechStartAbs)
    const peakDb = speechPeakDb
    const startFloorDb = attackFloorDb
    inSpeech = false
    hot = 0
    silentFrames = 0
    speechPeakDb = -200

    // Two cheap sanity gates before spending a decode. Typing into someone's
    // document makes a false positive expensive — it puts words in their mouth
    // in a place they may not be looking — so the bar for "that was speech" is
    // deliberately higher than the bar for "that was sound".
    const speechMs = ((lastVoicedAbs - startAbs) / rate) * 1000
    if (speechMs < MIN_SPEECH_MS) return
    if (peakDb < startFloorDb + getAttackDb() + MIN_PEAK_OVER_ATTACK_DB) return

    const pcm = extract(startAbs, endAbs)
    if (!pcm?.length) return
    onUtterance({ pcm, sampleRate: rate, speechMs })
  }

  return {
    get inSpeech() { return inSpeech },
    get sampleRate() { return rate },
    get frameMs() { return frameMs },
    /** This channel's own noise floor. Independent per channel by design. */
    get floorDb() { return floor.floorDb },
    /** Wall-clock ms since the last frame arrived. Feeds the stall watchdog. */
    idleMs() { return now() - lastFrameAt },

    /** One worklet block. Returns true if this frame ended an utterance. */
    push(data) {
      lastFrameAt = now()
      appendChunk(data)

      const db = frameDb(data)
      const floorDb = floor.push(db)

      if (!inSpeech) {
        hot = db > floorDb + getAttackDb() ? hot + 1 : 0
        if (hot >= ATTACK_FRAMES) {
          inSpeech = true
          silentFrames = 0
          speechPeakDb = db
          attackFloorDb = floorDb
          // Rewind to where the attack actually began, then pad.
          speechStartAbs = absWritten - data.length * ATTACK_FRAMES - Math.round((PRE_ROLL_MS / 1000) * rate)
          lastVoicedAbs = absWritten
        }
        return false
      }

      if (db > speechPeakDb) speechPeakDb = db
      // Two gates, whichever is higher wins. The floor gate handles the normal
      // case; the peak gate is what still ends the sentence when the floor
      // estimate is off, so "I stopped talking" can never mean "listens forever".
      const releaseDb = Math.max(floorDb + RELEASE_MARGIN_DB, speechPeakDb - PEAK_DROP_DB)
      if (db > releaseDb) {
        silentFrames = 0
        lastVoicedAbs = absWritten
      } else {
        silentFrames++
      }

      const utterMs = ((absWritten - speechStartAbs) / rate) * 1000
      if (silentFrames >= releaseFrames() || utterMs >= MAX_UTTER_MS) {
        endUtterance()
        return true
      }
      return false
    },

    /** Force the endpoint. Used when the source dies mid-sentence, or on stop. */
    flush() { if (inSpeech) endUtterance() },

    /** Keep the watchdog fed without retaining or evaluating anything (mute). */
    touch() { lastFrameAt = now() },

    /** Drop what's retained and abandon the sentence in progress. */
    discard() {
      inSpeech = false
      hot = 0
      silentFrames = 0
      speechPeakDb = -200
      chunks = []
      absWritten = 0
    },

    /** Re-learn the floor. The room may have changed while we weren't listening. */
    reset() {
      floor.reset()
      inSpeech = false
      hot = 0
      silentFrames = 0
      speechStartAbs = 0
      lastVoicedAbs = 0
      speechPeakDb = -200
      lastFrameAt = now()
    },

    /**
     * A different device can have a different sample rate, and frame duration,
     * retained buffer length and release count are all wrong if it isn't
     * recomputed. Drops the buffer: audio at two rates cannot be concatenated.
     */
    setSampleRate(next) {
      rate = next
      frameMs = (WORKLET_BLOCK / rate) * 1000
      keepSamples = Math.ceil(((MAX_UTTER_MS + PRE_ROLL_MS + POST_ROLL_MS) / 1000) * rate)
      chunks = []
      absWritten = 0
    },
  }
}
