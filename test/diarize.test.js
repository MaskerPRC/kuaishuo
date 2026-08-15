// Speaker labelling. The vectors here are synthetic but the geometry is the
// real thing: CAM++ embeddings are compared by cosine, so two utterances from
// one person are two nearby directions and two people are two far-apart ones.
// Building test vectors as "a base direction plus a small perturbation" models
// exactly that, and lets the thresholds be exercised on both sides.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDiarizer, cosine, l2norm } = require('../electron/diarize.cjs')

const DIM = 192

/** A deterministic unit vector for "speaker n". */
function base(n) {
  const v = new Array(DIM)
  for (let i = 0; i < DIM; i++) v[i] = Math.sin((i + 1) * (n + 1) * 0.7331)
  return l2norm(v)
}

/** A deterministic unit vector of "noise" for a given seed. */
function noise(seed) {
  const v = new Array(DIM)
  for (let i = 0; i < DIM; i++) v[i] = Math.cos((i + 1) * seed * 2.113 + seed)
  return l2norm(v)
}

/**
 * Same speaker, different sentence. Both operands are unit vectors, so the
 * blend weight maps predictably onto cosine: `mix` of 0.1 lands around 0.99,
 * 1.0 around 0.7, 1.6 around 0.5. Scaling raw noise onto a normalised vector
 * (the obvious first attempt) does not — one component of a 192-dim unit
 * vector is ~0.07, so a "0.1 jitter" is larger than the signal it perturbs.
 */
function take(n, mix = 0.12, seed = 1) {
  const b = base(n)
  const e = noise(seed)
  return l2norm(b.map((x, i) => x + mix * e[i]))
}

describe('cosine', () => {
  test('is 1 for identical, ~0 for orthogonal, -1 for opposite', () => {
    const a = base(0)
    assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6)
    assert.ok(Math.abs(cosine(a, a.map((x) => -x)) + 1) < 1e-6)
    assert.equal(cosine([1, 0], [0, 1]), 0)
  })

  test('returns 0 rather than NaN on mismatched or empty input', () => {
    assert.equal(cosine([], [1, 2]), 0)
    assert.equal(cosine(null, [1]), 0)
    assert.equal(cosine([1, 2, 3], [1, 2]), 0)
  })
})

describe('diarizer', () => {
  test('groups repeat utterances from one speaker together', () => {
    const d = createDiarizer()
    const first = d.assign(take(0, 0.1, 1))
    const second = d.assign(take(0, 0.1, 3))
    const third = d.assign(take(0, 0.1, 7))
    assert.equal(first.isNew, true)
    assert.equal(second.isNew, false)
    assert.equal(third.isNew, false)
    assert.equal(d.size, 1)
    assert.equal(second.label, first.label)
  })

  test('opens a new speaker for a genuinely different voice', () => {
    const d = createDiarizer()
    d.assign(base(0))
    const other = d.assign(base(5))
    assert.equal(other.isNew, true)
    assert.equal(d.size, 2)
  })

  test('labels the enrolled owner 我 and numbers the rest from 1', () => {
    const owner = base(0)
    const d = createDiarizer({ ownerVoiceprint: owner })
    const me = d.assign(take(0, 0.05, 2))
    const b = d.assign(base(5))
    const c = d.assign(base(9))
    assert.equal(me.label, '我')
    assert.equal(me.isOwner, true)
    assert.equal(b.label, '说话人1')
    assert.equal(c.label, '说话人2')
    const sum = d.summary()
    assert.equal(sum.length, 3)
    assert.equal(sum.filter((x) => x.isOwner).length, 1)
  })

  test('only one cluster can be the owner', () => {
    // ownerThreshold: -1 makes every new cluster "match" the enrolled voice.
    // Even then there must be exactly one 我 — one enrolled person, one label,
    // no matter how permissive the comparison is.
    const d = createDiarizer({ ownerVoiceprint: base(0), ownerThreshold: -1 })
    d.assign(take(0, 0.05, 2))
    d.assign(base(5))
    d.assign(base(9))
    const sum = d.summary()
    assert.equal(sum.filter((x) => x.isOwner).length, 1)
    assert.deepEqual(sum.map((x) => x.label), ['我', '说话人1', '说话人2'])
  })

  test('counts segments per speaker', () => {
    const d = createDiarizer()
    d.assign(take(0, 0.08, 1))
    d.assign(take(0, 0.08, 4))
    d.assign(base(5))
    const sum = d.summary()
    assert.equal(sum.find((x) => x.id === 'S1').segments, 2)
    assert.equal(sum.find((x) => x.id === 'S2').segments, 1)
  })

  test('with no embedding everything lands in one bucket', () => {
    const d = createDiarizer()
    const a = d.assign(null)
    const b = d.assign([])
    assert.equal(d.size, 1)
    assert.equal(a.label, b.label)
    assert.equal(a.isNew, false)
  })

  test('a lower threshold merges what a higher one splits', () => {
    const v1 = base(0)
    const v2 = take(0, 1.0, 13)      // same person, unusually different take
    const sim = cosine(v1, v2)
    assert.ok(sim > 0.5 && sim < 0.95, `similarity ${sim} should sit in the ambiguous band`)

    const strict = createDiarizer({ threshold: 0.98 })
    strict.assign(v1); strict.assign(v2)
    assert.equal(strict.size, 2)

    const loose = createDiarizer({ threshold: 0.4 })
    loose.assign(v1); loose.assign(v2)
    assert.equal(loose.size, 1)
  })

  test('the centroid stays a unit vector as it absorbs takes', () => {
    const d = createDiarizer()
    for (let i = 0; i < 12; i++) d.assign(take(0, 0.3, i + 1))
    // Not directly observable, so assert the consequence: a 13th take from the
    // same speaker still matches rather than drifting out of range.
    assert.equal(d.assign(take(0, 0.15, 99)).isNew, false)
    assert.equal(d.size, 1)
  })
})

// System audio is the machine's own output — the far end of a call. It cannot
// have come from the microphone in front of the user, so no cosine should be
// able to argue that it did.
describe('channel scoping', () => {
  test('the same voice on two channels opens two clusters', () => {
    const d = createDiarizer()
    const a = d.assign(take(0), { channel: 'mic' })
    const b = d.assign(take(0, 0.1, 2), { channel: 'system' })
    assert.equal(d.size, 2)
    assert.notEqual(a.id, b.id)
    assert.equal(b.isNew, true)
  })

  test('canBeOwner: false keeps the far end out of 我 — both routes', () => {
    // Route 1: the new-cluster branch, which consults the voiceprint directly.
    const owner = base(0)
    const d = createDiarizer({ ownerVoiceprint: owner, ownerThreshold: -1 })
    const r = d.assign(take(0), { channel: 'system', canBeOwner: false })
    assert.equal(r.isOwner, false)
    assert.notEqual(r.label, '我')

    // Route 2: the match branch. 我 is inherited from whichever cluster an
    // utterance matched, never recomputed — so an owner cluster that already
    // exists is the other way a remote voice could be labelled as the user.
    const d2 = createDiarizer({ ownerVoiceprint: owner, ownerThreshold: 0.5 })
    assert.equal(d2.assign(take(0), { channel: 'mic' }).label, '我')
    const sys = d2.assign(take(0, 0.1, 3), { channel: 'system', canBeOwner: false })
    assert.notEqual(sys.label, '我')
    assert.equal(sys.isOwner, false)
  })

  test('labels stay unique across channels', () => {
    // The label is the join key: segments store it, the webhook groups turns by
    // it, and renaming in the UI rewrites by it. Two people sharing 说话人1
    // would silently merge in all three.
    const d = createDiarizer()
    d.assign(base(0), { channel: 'mic' })
    d.assign(base(1), { channel: 'mic' })
    d.assign(base(2), { channel: 'system', canBeOwner: false })
    d.assign(base(3), { channel: 'system', canBeOwner: false })
    const labels = d.summary().map((sp) => sp.label)
    assert.equal(new Set(labels).size, labels.length, labels.join(','))
  })

  test('remote speakers still separate from each other', () => {
    const d = createDiarizer()
    d.assign(base(1), { channel: 'system', canBeOwner: false })
    d.assign(base(2), { channel: 'system', canBeOwner: false })
    d.assign(take(1, 0.12, 5), { channel: 'system', canBeOwner: false })
    assert.equal(d.size, 2, 'three utterances, two remote people')
  })

  test('summary reports the channel, and mic is the default', () => {
    const d = createDiarizer()
    d.assign(base(0))
    d.assign(base(1), { channel: 'system', canBeOwner: false })
    assert.deepEqual(d.summary().map((sp) => sp.channel), ['mic', 'system'])
  })

  test('with no embedding, each channel gets its own bucket', () => {
    const d = createDiarizer()
    const a = d.assign(null, { channel: 'mic' })
    const b = d.assign(null, { channel: 'system', canBeOwner: false })
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.label, b.label)
    assert.equal(d.size, 2)
    // And repeats land back in the right one rather than inventing more.
    assert.equal(d.assign(null, { channel: 'system', canBeOwner: false }).id, b.id)
    assert.equal(d.size, 2)
  })
})
