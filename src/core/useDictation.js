// The dictation state machine. One session covers many sentences: the streams
// stay open, an energy VAD finds the gaps, and each utterance is cut,
// transcribed, and handed to main to be typed / stored / labelled.
//
// Why the VAD is here and not in main: the endpoint decision needs the live
// audio, and the renderer already has every frame for the waveform. Doing it
// here also means the audio that reaches SenseVoice is exactly one sentence —
// the encoder is quadratic in frame count, so feeding it a whole session
// instead of a sentence is the difference between 260ms and minutes.
//
// There are two capture channels, not one mixed signal:
//
//   microphone  → VAD channel ─┐
//                              ├→ one serialized queue → main
//   system audio → VAD channel ┘   (meetings only)
//
// Mixing them would have been fewer lines and wrong. The floor tracker is a
// rolling low percentile over four seconds; a video playing through the
// speakers would walk that estimate up until the microphone channel stopped
// releasing at all, and anything said over the top of the remote speaker would
// arrive at the recogniser as one glued utterance. Separate channels, separate
// floors, separate endpoints — sharing only the decode queue, so sentences
// still reach the target in the order they were spoken.
//
// Ported from chinaClaw's chat composer, with the tuning constants intact —
// they were measured, not guessed, and the microphone hasn't changed.

import { ref, computed, watch, onBeforeUnmount } from 'vue'
import {
  isAsrSupported, transcribeDetailed, resampleTo16k,
  ensureAsrModel, ensureSpeakerModel, getAsrStatus, onAsrProgress,
} from './asr.js'
import { currentSettings, useSettings } from './settings.js'
import {
  attackDbFor, createVadChannel, isSystemAudioSupported,
  openMicTap, openSystemAudioTap, isMeaningfulTranscript,
} from './voiceVad.js'

// ---- Tuning -----------------------------------------------------------------
// Everything about deciding "is this speech" lives in ./voiceVad.js, shared
// with the settings preview and covered by test/vad.test.js. What's left here
// is session lifecycle.

// No audio for this long while a session is live means the track died — the
// device was unplugged, or the OS handed it to another app. Without this the
// VAD never sees its release frames and dictation hangs mid-sentence with the
// waveform frozen and nothing ever sent.
const FRAME_STALL_MS = 1500
const MIC_DEAD_MS    = 5000

// A meeting that never materialises after the loopback tap was armed (the IPC
// failed, the user hit escape) must not leave a capture running.
const ARM_GRACE_MS = 8000

/**
 * @param {object} [opts]
 * @param {import('vue').Ref<boolean>} [opts.meetingActive]
 *        Meetings need a speaker embedding per utterance even when the
 *        voiceprint gate is off, because that's what labels the turns. They're
 *        also the only place system audio is captured.
 * @param {Function} [opts.onResult]  (result) => void, after main has committed
 */
export function useDictation({ meetingActive, onResult } = {}) {
  const active   = ref(false)
  const phase    = ref('idle')   // idle | downloading | listening | speaking | transcribing | error
  const progress = ref(0)        // model download 0..1
  const error    = ref('')
  const lastText = ref('')
  // '' | 'voiceprint'. Nothing surfaces this on the strip any more — the gate
  // firing is the normal state of a room with a television in it, and a toast
  // every time it worked turned the protection into a nag. The rejection is
  // still recorded to history, which is where a quiet session gets explained.
  const lastRejection = ref('')
  const pending  = ref(0)

  // System audio is a bonus channel, never a precondition. It gets its own
  // status pair precisely so that it can fail without touching `error`/`phase`
  // — those put the strip into a terminal state and evict the waveform, which
  // would turn "the remote side isn't being captured" into "dictation is
  // broken".
  const systemAudioActive = ref(false)
  const systemAudioWarn   = ref('')   // '' | 'denied' | 'unavailable' | 'lost'

  // Model state, tracked for the whole life of the strip rather than only while
  // a session is starting. Main prefetches the recogniser a few seconds after
  // launch, and the strip has to be able to say so — the first version could
  // only report a download it had started itself, so a background fetch looked
  // like nothing happening at all.
  const model = ref({ onDisk: false, stage: 'idle', progress: 0 })
  const modelBusy = computed(() =>
    model.value.stage === 'downloading-model' ||
    model.value.stage === 'extracting-model' ||
    model.value.stage === 'downloading-speaker')

  let unsubModel = null
  if (isAsrSupported()) {
    getAsrStatus().then((st) => {
      if (!st) return
      model.value = { onDisk: !!st.modelOnDisk, stage: st.state?.stage || 'idle', progress: st.state?.progress || 0 }
    }).catch(() => {})
    unsubModel = onAsrProgress((p) => {
      if (!p) return
      model.value = {
        onDisk: p.stage === 'ready' ? true : model.value.onDisk,
        stage: p.stage,
        progress: p.progress || 0,
      }
    })
  }

  // Per-band energy (0..1) for the waveform: [low, mid, high]. Deliberately NOT
  // reactive — it changes ~60×/s and the only consumer is a canvas already
  // redrawing on rAF, so routing it through Vue would buy nothing and cost a
  // re-render per frame. Mutated in place; readers just read.
  //
  // Fed from the microphone only. The ribbon answers "is it hearing me", and
  // mixing the machine's own output into it would make the strip dance to a
  // video the user is only half watching.
  const bands = new Float32Array(3)

  // Temporary hold. For the very common case of turning to say something to a
  // person in the room: the session, the mic permission and the loaded model all
  // stay exactly as they are, but nothing you say is captured or transcribed.
  // Deliberately NOT persisted — it's a moment, not a preference, and a mute
  // that survives a restart is a mute you forget you set.
  const muted = ref(false)

  function setMuted(on) {
    const next = !!on
    if (next === muted.value) return
    muted.value = next
    if (next) {
      // Abandon whatever was mid-sentence and drop the retained audio, on both
      // channels. Nothing captured while muted should be able to surface later
      // — not as a late transcription, and not sitting in a buffer. Pause means
      // pause, whichever side of the call it came from.
      for (const ch of channels()) ch.discard()
      if (phase.value === 'speaking') phase.value = 'listening'
    } else {
      // Coming back: the floor was measured on a room that may have changed
      // (someone else was just talking into it), so re-learn rather than trust
      // a stale estimate.
      for (const ch of channels()) ch.reset()
    }
  }
  function toggleMuted() { setMuted(!muted.value) }

  // ---- Capture state --------------------------------------------------------
  let mic = null
  let micChannel = null
  let freqBins = null
  let bandRaf = 0
  let unsubProgress = null

  let sysTap = null
  let sysChannel = null
  let sysOpening = null
  let armed = false          // a meeting is starting; hold the loopback open
  let armTimer = null
  let stallTimer = null

  function channels() {
    return [micChannel, sysChannel].filter(Boolean)
  }

  // Read live so a change in the console takes effect on the next utterance
  // instead of on the next session. Anything cheap enough to evaluate per frame
  // is read this way; the microphone device is the one setting that genuinely
  // cannot be, and it gets the reopen path below.
  const getAttackDb = () => attackDbFor(currentSettings().asrSensitivity)
  const getSilenceMs = () => currentSettings().asrSilenceMs || 900

  function makeChannel(source) {
    return createVadChannel({
      sampleRate: 48000,          // replaced by setSampleRate once the tap is up
      getAttackDb,
      getSilenceMs,
      onUtterance: ({ pcm, sampleRate, speechMs }) => enqueue(pcm, sampleRate, speechMs, source),
    })
  }

  // Transcriptions run off a promise chain so sentences reach the target app in
  // the order they were spoken even when one takes longer than the next. Shared
  // by both channels: one decode at a time, whichever side spoke.
  let queue = Promise.resolve()

  // Split the spectrum into three speech-relevant bands and smooth each one.
  // Ranges are picked for voice: fundamentals sit under ~300 Hz, the vowel
  // formants that carry most of the energy are 300-2k, sibilance above that.
  function sampleBands() {
    bandRaf = requestAnimationFrame(sampleBands)
    if (!mic?.analyser || !freqBins) return
    mic.analyser.getByteFrequencyData(freqBins)
    const nyquist = mic.sampleRate / 2
    const binHz = nyquist / freqBins.length
    const edges = [0, 300, 2000, 6000]
    for (let b = 0; b < 3; b++) {
      const from = Math.floor(edges[b] / binHz)
      const to = Math.min(freqBins.length, Math.ceil(edges[b + 1] / binHz))
      let sum = 0
      for (let i = from; i < to; i++) sum += freqBins[i]
      const avg = to > from ? sum / (to - from) / 255 : 0
      bands[b] += (avg - bands[b]) * 0.18
    }
  }

  // ---- Frame handlers -------------------------------------------------------

  function feed(channel, data, { speaks }) {
    if (!channel) return
    // Muted, or not started yet: keep the stall watchdog fed — the source
    // really is still delivering — but retain nothing and run no VAD. The
    // ribbon keeps moving off the analyser, which is the honest signal: the mic
    // IS open, it's just not listening for anything to send.
    //
    // "Not started yet" is not hypothetical for the loopback channel: it is
    // armed from the click that starts a meeting, and dictation may take
    // seconds to come up behind it. Without this the watchdog would see a
    // channel that had been silent since before the session existed and close
    // it as dead on its first tick.
    if (!active.value || muted.value) { channel.touch(); return }
    const wasSpeaking = channel.inSpeech
    channel.push(data)
    if (!speaks) return
    if (channel.inSpeech && phase.value === 'listening') phase.value = 'speaking'
    else if (wasSpeaking && !channel.inSpeech && phase.value === 'speaking') phase.value = 'listening'
  }

  // The VAD's release only fires on frames it actually receives. If a track dies
  // mid-sentence no frames arrive at all, so `silentFrames` never counts up and
  // the utterance would sit unflushed forever. Watch wall-clock instead.
  function watchStall() {
    if (!active.value) return

    if (micChannel) {
      const idle = micChannel.idleMs()
      if (idle >= MIC_DEAD_MS) {
        error.value = 'mic-stalled'
        phase.value = 'error'
        stop()
        return
      }
      if (idle >= FRAME_STALL_MS && micChannel.inSpeech) micChannel.flush()
    }

    // A silent loopback is the normal state of a quiet machine, so this is only
    // reached once frames genuinely stop arriving — and even then it costs the
    // channel, never the session. Losing system audio is not losing dictation.
    if (sysChannel) {
      const idle = sysChannel.idleMs()
      if (idle >= MIC_DEAD_MS) { closeSystemTap('lost'); return }
      if (idle >= FRAME_STALL_MS && sysChannel.inSpeech) sysChannel.flush()
    }
  }

  // Speaker embeddings cost ~90ms per utterance and a 28MB model, so they're
  // only computed when something is actually going to read them: the voiceprint
  // gate, or meeting diarization.
  function wantsEmbedding() {
    const s = currentSettings()
    if (s.voiceprintEnabled && s.voiceprint?.length) return true
    if (meetingActive?.value && s.meetingDiarize) return true
    return false
  }

  function enqueue(pcm, rate, speechMs, source) {
    pending.value++
    phase.value = 'transcribing'
    // Stamped when the sentence ENDED, not when its decode came up. With two
    // channels feeding one serialized queue, a remote sentence that queues
    // behind a long microphone decode would otherwise be timestamped seconds
    // late — and store.addSegment derives a meeting's offsetMs from this, so
    // the transcript's clock would stop being monotonic.
    const at = Date.now()
    queue = queue.then(async () => {
      try {
        // A new attempt supersedes whatever the last one complained about, so
        // the strip stops showing a stale error the moment things work again.
        error.value = ''
        const pcm16k = await resampleTo16k(pcm, rate)
        const withEmbedding = wantsEmbedding()
        const { text: rawText, embedding, ms } = await transcribeDetailed(pcm16k, 16000, { withEmbedding })
        const raw = rawText.trim()
        // SenseVoice usually returns '' for a cough or a door, but not always —
        // it can emit a lone comma or a single filler syllable.
        if (!isMeaningfulTranscript(raw)) return

        // Main owns the verdict: the voiceprint gate, the speaker label, where
        // the text goes, and what gets written down. It has the settings and
        // the meeting state; this side has the audio, and which channel it
        // arrived on — which main cannot work out for itself and which decides
        // whether the sentence can ever be labelled 我.
        const verdict = await window.kuaishuo.dictation.commit({
          text: raw, at, durationMs: Math.round(speechMs), decodeMs: ms, embedding, source,
        })
        if (verdict?.accepted) {
          lastText.value = raw
          lastRejection.value = ''
        } else if (verdict?.reason === 'voiceprint') {
          // Not silence — the user should see that something was heard and
          // deliberately dropped, or they'll think the mic is broken.
          lastRejection.value = 'voiceprint'
        }
        onResult?.({ text: raw, source, verdict })
      } catch (err) {
        console.warn('[dictation] failed', err)
        error.value = err?.message || String(err)
      } finally {
        pending.value--
        if (pending.value === 0 && active.value) {
          phase.value = micChannel?.inSpeech ? 'speaking' : 'listening'
        }
      }
    })
  }

  // ---- Microphone ------------------------------------------------------------

  /**
   * Open (or re-open) the capture graph for whatever device is selected now.
   * Everything derived from the device — sample rate, frame duration, retained
   * buffer length, FFT bin count — is recomputed here, because a different
   * microphone can have a different sample rate and every one of those is
   * wrong if it isn't.
   *
   * @returns {Promise<boolean>} false if the mic could not be opened (state is
   *          already set to 'error' by then).
   */
  async function openTap() {
    const channel = makeChannel('mic')
    try {
      mic = await openMicTap({
        deviceId: currentSettings().micDeviceId,
        onFrame: (data) => feed(channel, data, { speaks: true }),
        analyser: true,   // spectrum tap for the waveform; the VAD stays on time-domain frames
      })
    } catch (err) {
      console.warn('[dictation] mic open failed', err)
      // OverconstrainedError means the exact deviceId we asked for no longer
      // exists — a USB mic unplugged, headphones disconnected, or a saved
      // device that belonged to a different machine. Falling back to the system
      // default would be worse than failing: recording someone through a
      // microphone they didn't choose, without telling them, is exactly the
      // kind of thing this app must never do.
      error.value = err?.name === 'OverconstrainedError' ? 'mic-gone' : (err?.message || String(err))
      phase.value = 'error'
      active.value = false
      return false
    }

    micChannel = channel
    micChannel.setSampleRate(mic.sampleRate)
    micChannel.reset()

    freqBins = new Uint8Array(mic.analyser.frequencyBinCount)
    bands.fill(0)

    // A track that ends (device unplugged, OS reassigned it) stops delivering
    // frames silently; surface it instead of leaving a frozen waveform.
    for (const t of mic.stream.getAudioTracks()) {
      t.addEventListener('ended', () => {
        if (!active.value) return
        error.value = 'mic-ended'
        phase.value = 'error'
        stop()
      })
    }
    return true
  }

  /**
   * Swap to a different input device without ending the session.
   *
   * Picking a microphone in the console used to do nothing until dictation was
   * stopped and started again — you changed the setting, kept talking, and the
   * old device was still the one being recorded. Since the usual reason to
   * change it is that the current one sounds wrong, "takes effect next session"
   * is the wrong moment by definition.
   *
   * Whatever was mid-sentence is dropped: half of it came from a different
   * microphone, and stitching the two halves together would produce an
   * utterance that never happened.
   */
  async function switchDevice() {
    if (!active.value || !mic) return
    const previous = mic
    mic = null
    micChannel = null
    try { await previous.close() } catch {}
    if (!(await openTap())) {
      // openTap has already set the error state, but the frame loop and the
      // stall watchdog are still running against a microphone that no longer
      // exists. Tear the session down properly rather than leaving two timers
      // ticking over nothing.
      await stop()
      return
    }
    if (phase.value === 'speaking') phase.value = 'listening'
  }

  // ---- System audio ----------------------------------------------------------

  /** Windows-only, meetings-only, and only if the user hasn't turned it off. */
  function systemAudioWanted() {
    if (!isSystemAudioSupported()) return false
    if (!currentSettings().systemAudioInMeetings) return false
    return !!(meetingActive?.value || armed)
  }

  /**
   * Open the loopback tap, if it should be open and isn't already.
   *
   * Every failure here is soft. The microphone is the feature; system audio is
   * the half of the conversation that used to be missing, and not getting it is
   * a worse transcript, not a broken app.
   */
  async function openSystemTap() {
    if (sysTap || sysOpening || !systemAudioWanted()) return
    const channel = makeChannel('system')
    sysOpening = (async () => {
      try {
        const tap = await openSystemAudioTap({
          onFrame: (data) => feed(channel, data, { speaks: false }),
        })
        // The meeting may have ended, or the setting been turned off, while the
        // permission round-trip was in flight.
        if (!systemAudioWanted()) { try { await tap.close() } catch {} ; return }

        channel.setSampleRate(tap.sampleRate)
        channel.reset()
        sysTap = tap
        sysChannel = channel
        systemAudioActive.value = true
        systemAudioWarn.value = ''
        for (const t of tap.stream.getAudioTracks()) {
          t.addEventListener('ended', () => { if (sysTap === tap) closeSystemTap('lost') })
        }
      } catch (err) {
        console.warn('[dictation] system audio unavailable', err)
        systemAudioActive.value = false
        // NotAllowedError is also what a missing transient user activation
        // looks like, not only a refusal — either way the honest report is
        // "couldn't get it", and the meeting carries on with the microphone.
        systemAudioWarn.value = err?.name === 'NotAllowedError' ? 'denied' : 'unavailable'
      } finally {
        sysOpening = null
      }
    })()
    return sysOpening
  }

  /**
   * Tear the loopback channel down.
   *
   * Deliberately discards the sentence in progress instead of flushing it. The
   * usual reason this runs is that the meeting just ended — and main routes by
   * what is true when the text arrives, so a flushed straggler would land after
   * the meeting closed. Losing the tail of the remote speaker's last sentence
   * is cheap; the alternative is not.
   */
  async function closeSystemTap(reason = '') {
    if (armTimer) { clearTimeout(armTimer); armTimer = null }
    systemAudioActive.value = false
    if (reason === 'lost') systemAudioWarn.value = 'lost'
    if (sysChannel) { sysChannel.discard(); sysChannel = null }
    if (sysTap) { const t = sysTap; sysTap = null; try { await t.close() } catch {} }
  }

  /**
   * "A meeting is about to start" — call this synchronously from the click that
   * starts it, before any await.
   *
   * Chromium only grants getDisplayMedia inside the transient activation window
   * that a real user gesture opens, and awaiting the meeting:start IPC first can
   * spend it. Arming here opens the tap while the gesture is still valid; the
   * meetingActive watcher below covers meetings started from the console, where
   * this renderer never saw a gesture at all.
   */
  function armSystemAudio() {
    if (armed || sysTap) return
    if (!isSystemAudioSupported() || !currentSettings().systemAudioInMeetings) return
    armed = true
    if (armTimer) clearTimeout(armTimer)
    armTimer = setTimeout(() => {
      armTimer = null
      if (meetingActive?.value) return
      armed = false
      closeSystemTap()
    }, ARM_GRACE_MS)
    openSystemTap()
  }

  // ---- Setting watchers ------------------------------------------------------

  // Only the device needs this. Sensitivity and the silence window are read
  // live on every frame, so they are already current.
  const { settings } = useSettings()
  watch(() => settings.value.micDeviceId, (next, prev) => {
    if (next === prev) return
    switchDevice()
  })

  // Both directions have to work mid-meeting: turning it on should not mean
  // "next meeting", and turning it off has to actually stop the capture rather
  // than merely stop using it.
  watch(() => settings.value.systemAudioInMeetings, (on) => {
    if (on) openSystemTap()
    else closeSystemTap()
  })

  if (meetingActive) {
    watch(meetingActive, (on) => {
      if (on) {
        if (armTimer) { clearTimeout(armTimer); armTimer = null }
        openSystemTap()
      } else {
        armed = false
        closeSystemTap()
      }
    })
  }

  // ---- Session lifecycle ----------------------------------------------------

  async function start() {
    if (active.value) return
    error.value = ''
    lastRejection.value = ''
    if (!isAsrSupported()) {
      error.value = 'unsupported'
      phase.value = 'error'
      return
    }

    // Model first: 228MB is a minutes-long wait on a slow link, and holding the
    // mic open (and its OS indicator lit) through that would be rude.
    try {
      const st = await getAsrStatus()
      if (!st?.modelOnDisk) {
        active.value = true
        phase.value = 'downloading'
        progress.value = st?.state?.progress || 0
        unsubProgress = onAsrProgress((p) => {
          if (p?.stage === 'downloading-model' || p?.stage === 'extracting-model') {
            progress.value = p.progress || 0
          }
        })
        const r = await ensureAsrModel({ preloadWorker: false })
        if (unsubProgress) { unsubProgress(); unsubProgress = null }
        if (!r?.ok) throw new Error(r?.error || '模型下载失败')
        if (!active.value) return   // user bailed out mid-download
      }
    } catch (err) {
      error.value = err?.message || String(err)
      phase.value = 'error'
      active.value = false
      return
    }

    if (!(await openTap())) return

    bandRaf = requestAnimationFrame(sampleBands)
    stallTimer = setInterval(watchStall, 500)

    active.value = true
    phase.value = 'listening'
    // A session started while a meeting is already recording (the hotkey, or a
    // meeting opened from the console) still wants the other half of the call.
    openSystemTap()
    // Build the recognizer in the background so the first sentence doesn't pay
    // the ~900ms construction on top of its own decode.
    ensureAsrModel({ preloadWorker: true }).catch(() => {})
    if (wantsEmbedding()) ensureSpeakerModel().catch(() => {})
  }

  async function stop() {
    // Flush whatever is mid-sentence rather than throwing it away — hitting
    // stop right after finishing a thought is the common case. The microphone
    // only: see closeSystemTap for why the loopback channel doesn't get this.
    if (active.value && micChannel && mic) {
      try { micChannel.flush() } catch {}
    }
    active.value = false
    // Only the fatal paths (mic died, start failed) pre-set 'error' and want the
    // strip to stay up. A leftover transcription error from mid-session must NOT
    // make an ordinary stop sticky.
    phase.value = phase.value === 'error' ? 'error' : 'idle'
    progress.value = 0
    muted.value = false
    armed = false
    if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
    if (unsubProgress) { try { unsubProgress() } catch {}; unsubProgress = null }
    if (bandRaf) { cancelAnimationFrame(bandRaf); bandRaf = 0 }
    freqBins = null
    bands.fill(0)
    await closeSystemTap()
    if (mic) { const m = mic; mic = null; try { await m.close() } catch {} }
    micChannel = null
  }

  function toggle() {
    if (active.value) stop()
    else start()
  }

  // 'error' is terminal and keeps the strip on screen so the reason is readable;
  // this is the acknowledgement that clears it.
  function dismiss() {
    error.value = ''
    phase.value = 'idle'
    systemAudioWarn.value = ''
  }

  const busy = computed(() => phase.value === 'transcribing')

  onBeforeUnmount(() => {
    stop()
    if (unsubModel) { try { unsubModel() } catch {} ; unsubModel = null }
  })

  return {
    active, phase, progress, error, bands, busy, pending,
    lastText, lastRejection,
    model, modelBusy,
    muted, setMuted, toggleMuted,
    systemAudioActive, systemAudioWarn, armSystemAudio,
    start, stop, toggle, dismiss,
  }
}
