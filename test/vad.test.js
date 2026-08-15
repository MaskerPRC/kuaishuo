// The voice-activity primitives. These decide when a sentence starts and ends,
// which is the difference between "say a sentence and it appears" and "nothing
// ever happens" — and they were originally tuned against measurements from a
// real room, so the tests here assert against those same measured facts.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  frameDb, createFloorTracker, attackDbFor, isMeaningfulTranscript, createVadChannel,
  SENSITIVITY_LEVELS, DEFAULT_SENSITIVITY, NOISE_FLOOR_MIN_DB, RELEASE_MARGIN_DB,
  FLOOR_WINDOW_FRAMES, FLOOR_PERCENTILE, WORKLET_BLOCK, VAD_TUNING,
} from '../src/core/voiceVad.js'

/** A constant-amplitude frame, so its RMS — and therefore its dB — is exact. */
function frameAt(amplitude, n = WORKLET_BLOCK) {
  return Float32Array.from({ length: n }, (_, i) => (i % 2 ? amplitude : -amplitude))
}

/** Amplitude that produces a given dBFS, so cases can be written in dB. */
const ampFor = (db) => 10 ** (db / 20)

/**
 * A channel plus the utterances it emitted. `feed(db, frames)` pushes constant
 * -level frames; at 48 kHz one frame is 1024/48000 ≈ 21.3 ms.
 */
function channel(over = {}) {
  const out = []
  const ch = createVadChannel({
    sampleRate: 48000,
    getAttackDb: () => 16,        // 'medium'
    getSilenceMs: () => 900,
    onUtterance: (u) => out.push(u),
    ...over,
  })
  return {
    ch, out,
    feed(db, n) { for (let i = 0; i < n; i++) ch.push(frameAt(ampFor(db))) },
  }
}

describe('frameDb', () => {
  test('full scale is 0 dB and half scale is -6 dB', () => {
    assert.ok(Math.abs(frameDb(frameAt(1))) < 1e-4)
    assert.ok(Math.abs(frameDb(frameAt(0.5)) + 6.0206) < 1e-3)
  })

  test('digital silence clamps instead of returning -Infinity', () => {
    const db = frameDb(new Float32Array(WORKLET_BLOCK))
    assert.ok(Number.isFinite(db))
    assert.ok(db < -190)
  })

  test('is monotonic in amplitude', () => {
    let prev = -Infinity
    for (const a of [0.001, 0.01, 0.05, 0.2, 0.8]) {
      const db = frameDb(frameAt(a))
      assert.ok(db > prev)
      prev = db
    }
  })
})

describe('sensitivity levels', () => {
  test('higher sensitivity means a lower bar to clear', () => {
    assert.ok(attackDbFor('high') < attackDbFor('medium'))
    assert.ok(attackDbFor('medium') < attackDbFor('low'))
  })

  test('an unknown value falls back to the default rather than NaN', () => {
    assert.equal(attackDbFor('bogus'), attackDbFor(DEFAULT_SENSITIVITY))
    assert.equal(attackDbFor(undefined), attackDbFor(DEFAULT_SENSITIVITY))
  })

  test('leaving speech is easier than entering it at every setting', () => {
    // Otherwise a setting that makes it harder to start talking also makes it
    // harder to stop — the combination that strands a session in "still
    // talking" forever.
    for (const level of SENSITIVITY_LEVELS) {
      assert.ok(RELEASE_MARGIN_DB < level.attackDb, `${level.id}: release must sit below attack`)
    }
  })
})

describe('floor tracker', () => {
  test('holds a conservative default until enough frames have landed', () => {
    const f = createFloorTracker()
    assert.equal(f.floorDb, -60)
    f.push(-30)
    assert.equal(f.floorDb, -60)   // one loud frame must not move the floor
  })

  test('converges on the low percentile of a noisy room, not on its median', () => {
    const f = createFloorTracker()
    // The measured shape of a real quiet room: mostly around -45, with a long
    // tail up to -34 and down to -60. A floor taken from any single frame lands
    // wherever that frame happened to fall.
    const room = [-60, -58, -52, -47, -45, -44, -43, -41, -38, -34]
    for (let i = 0; i < FLOOR_WINDOW_FRAMES; i++) f.push(room[i % room.length])
    const floor = f.floorDb
    assert.ok(floor < -50, `floor ${floor} should sit near the bottom of the distribution`)
    assert.ok(floor > -62, `floor ${floor} should not fall below what was observed`)
  })

  test('ignores gated digital silence', () => {
    // Chromium's noiseSuppression hard-gates quiet moments to near-silence.
    // Those zeros are the absence of a signal, not room tone; letting them into
    // the estimate pins it at the clamp and the threshold comes out ~20 dB too
    // low, so the room itself keeps tripping the detector.
    const f = createFloorTracker()
    for (let i = 0; i < FLOOR_WINDOW_FRAMES; i++) f.push(i % 2 ? -45 : -200)
    assert.ok(f.floorDb > NOISE_FLOOR_MIN_DB, `floor ${f.floorDb} was dragged down by gated frames`)
    assert.ok(f.floorDb <= -44)
  })

  test('tracks a room that gets louder', () => {
    const f = createFloorTracker()
    for (let i = 0; i < FLOOR_WINDOW_FRAMES * 2; i++) f.push(-60)
    const quiet = f.floorDb
    for (let i = 0; i < FLOOR_WINDOW_FRAMES * 2; i++) f.push(-35)
    assert.ok(f.floorDb > quiet + 15, 'a floor that freezes never releases the utterance')
  })

  test('reset returns it to the cold-start default', () => {
    const f = createFloorTracker()
    for (let i = 0; i < FLOOR_WINDOW_FRAMES; i++) f.push(-30)
    f.reset()
    assert.equal(f.floorDb, -60)
  })

  test('the configured percentile is a low one', () => {
    assert.ok(FLOOR_PERCENTILE > 0 && FLOOR_PERCENTILE <= 0.3)
  })
})

// One channel = one source of audio, endpointed on its own. Until system audio
// existed this logic lived inside useDictation and could only be exercised
// through a live microphone, which is why the endpointer — the part that
// decides whether anything gets said at all — had never been tested.
describe('VAD channel', () => {
  const { MIN_SPEECH_MS, MAX_UTTER_MS, PRE_ROLL_MS, POST_ROLL_MS } = VAD_TUNING

  /** Enough quiet frames for the p20 floor estimate to settle on `db`. */
  function settleFloor(c, db = -50) { c.feed(db, 200) }

  test('one sentence in, one utterance out', () => {
    const c = channel()
    settleFloor(c)
    c.feed(-20, 30)          // ~640ms of speech, well over MIN_SPEECH_MS
    c.feed(-50, 60)          // ~1.3s of silence, over the 900ms release
    assert.equal(c.out.length, 1)

    const u = c.out[0]
    assert.equal(u.sampleRate, 48000)
    assert.ok(u.speechMs >= MIN_SPEECH_MS)

    // Pre-roll: the clip starts before the attack was detected, so the first
    // syllable — which is what tripped the detector in the first place, and is
    // therefore always already over by the time it fires — survives.
    const voicedMs = (30 * WORKLET_BLOCK / 48000) * 1000
    assert.ok(Math.abs(u.speechMs - (voicedMs + PRE_ROLL_MS)) < 25,
      `speechMs ${u.speechMs.toFixed(0)}, expected ≈${(voicedMs + PRE_ROLL_MS).toFixed(0)}`)

    // Post-roll: and it ends after the last voiced frame, so a trailing
    // consonant isn't cut. speechMs already spans the pre-roll.
    const expected = ((u.speechMs + POST_ROLL_MS) / 1000) * 48000
    assert.ok(Math.abs(u.pcm.length - expected) < WORKLET_BLOCK * 2,
      `clip ${u.pcm.length} samples, expected ≈${Math.round(expected)}`)
  })

  test('a short blip is not a sentence', () => {
    const c = channel()
    settleFloor(c)
    c.feed(-20, 4)           // ~85ms — a cough, or a key click
    c.feed(-50, 60)
    assert.equal(c.out.length, 0)
  })

  test('a noise that only just cleared the threshold is discarded', () => {
    // Attack is floor+16; this clears it, but not by MIN_PEAK_OVER_ATTACK_DB.
    const c = channel()
    settleFloor(c)
    c.feed(-33, 30)
    c.feed(-50, 60)
    assert.equal(c.out.length, 0)
  })

  test('the peak gate ends a sentence the floor gate would not', () => {
    // Floor -50 puts the floor release at -42, so -40 frames read as voiced
    // forever. Measured against the utterance's own -5 peak, -40 is 35 dB down
    // and unambiguously over. Without this gate the session listens forever.
    const c = channel()
    settleFloor(c)
    c.feed(-5, 30)
    c.feed(-40, 60)
    assert.equal(c.out.length, 1)
  })

  test('a steady tone is absorbed into the floor, not held as a sentence', () => {
    // The floor keeps updating mid-utterance, so a fan or a hum that clears the
    // attack threshold gets learned as the room within a few seconds and
    // released. A floor that froze at the attack would leave the session stuck
    // in "still talking" for the full MAX_UTTER_MS on every steady noise.
    const c = channel()
    settleFloor(c)
    c.feed(-20, 400)         // ~8.5s of unchanging tone
    assert.equal(c.out.length, 1)
    assert.ok(c.out[0].speechMs < MAX_UTTER_MS, 'released long before the hard cap')
  })

  test('MAX_UTTER_MS is a hard endpoint when nothing else releases', () => {
    // Alternating levels: the loud frames stay above the release threshold and
    // the quiet ones keep resetting the silence count, so neither release gate
    // ever completes. Only the hard cap ends this.
    const c = channel()
    settleFloor(c)
    const frames = Math.ceil((MAX_UTTER_MS / 1000) * 48000 / WORKLET_BLOCK) + 10
    for (let i = 0; i < frames; i++) c.ch.push(frameAt(ampFor(i % 2 ? -6 : -20)))
    assert.equal(c.out.length, 1)
    assert.ok(c.out[0].speechMs >= MAX_UTTER_MS - 100,
      `speechMs ${c.out[0].speechMs.toFixed(0)}`)
  })

  test('the silence window is read live, not captured at construction', () => {
    let silenceMs = 1800
    const c = channel({ getSilenceMs: () => silenceMs })
    settleFloor(c)
    c.feed(-20, 30)
    c.feed(-50, 30)          // ~640ms: short of 1800ms, nothing yet
    assert.equal(c.out.length, 0)
    silenceMs = 400          // the user drags the slider mid-pause
    c.feed(-50, 5)
    assert.equal(c.out.length, 1)
  })

  test('two channels do not share a noise floor', () => {
    // The reason system audio is a second channel rather than a second input
    // mixed into the first. A video playing at -20 must not raise the bar the
    // microphone has to clear.
    const loud = channel()
    const quiet = channel()
    loud.feed(-20, 200)
    quiet.feed(-60, 200)
    assert.ok(loud.ch.floorDb - quiet.ch.floorDb > 25,
      `floors ${loud.ch.floorDb} vs ${quiet.ch.floorDb}`)

    // And the consequence: the same speech lands on one and not the other. A
    // -35 dB voice clears the quiet channel's bar (floor -60) and is nowhere
    // near the loud one's (floor -20) — which is exactly what mixing system
    // audio into the microphone signal would have done to the microphone.
    for (const c of [loud, quiet]) { c.feed(-35, 30); c.feed(-60, 60) }
    assert.equal(quiet.out.length, 1)
    assert.equal(loud.out.length, 0)
  })

  test('discard() abandons the sentence; reset() re-learns the floor', () => {
    const c = channel()
    settleFloor(c)
    c.feed(-20, 30)
    assert.equal(c.ch.inSpeech, true)
    c.ch.discard()           // what mute does
    assert.equal(c.ch.inSpeech, false)
    c.feed(-50, 60)
    assert.equal(c.out.length, 0, 'nothing said while muted may surface later')
    assert.ok(c.ch.floorDb > -60, 'discard keeps the floor estimate')
    c.ch.reset()
    assert.equal(c.ch.floorDb, -60)
  })

  test('flush() emits what was captured mid-sentence', () => {
    // The stop() path: hitting stop right after finishing a thought is common,
    // and throwing that sentence away is the wrong default.
    const c = channel()
    settleFloor(c)
    c.feed(-20, 30)
    c.ch.flush()
    assert.equal(c.out.length, 1)
    c.ch.flush()
    assert.equal(c.out.length, 1, 'flushing twice does not duplicate')
  })

  test('setSampleRate recomputes the frame geometry', () => {
    const c = channel()
    assert.ok(Math.abs(c.ch.frameMs - 21.33) < 0.01)
    c.ch.setSampleRate(16000)
    assert.equal(c.ch.sampleRate, 16000)
    assert.ok(Math.abs(c.ch.frameMs - 64) < 0.01)
  })

  test('idleMs tracks the injected clock, so the stall watchdog is testable', () => {
    let t = 1000
    const c = channel({ now: () => t })
    c.feed(-50, 1)
    assert.equal(c.ch.idleMs(), 0)
    t += 2000
    assert.equal(c.ch.idleMs(), 2000)
  })
})

describe('transcript sanity', () => {
  test('rejects empty, punctuation-only and single-character results', () => {
    // SenseVoice fed a cough or a door usually returns '', but not always — it
    // emits a lone comma, or a single syllable like 嗯 / 哎. With direct input
    // on, those land in someone's document as if they had said them.
    for (const bad of ['', '   ', '，', '。。。', '?!', '嗯', '哎', 'a']) {
      assert.equal(isMeaningfulTranscript(bad), false, `should reject ${JSON.stringify(bad)}`)
    }
  })

  test('accepts real utterances', () => {
    for (const good of ['你好', '好的。', 'ok then', '把这段改一下', '嗯，可以']) {
      assert.equal(isMeaningfulTranscript(good), true, `should accept ${JSON.stringify(good)}`)
    }
  })

  test('null and undefined are handled, not thrown on', () => {
    assert.equal(isMeaningfulTranscript(null), false)
    assert.equal(isMeaningfulTranscript(undefined), false)
  })
})
