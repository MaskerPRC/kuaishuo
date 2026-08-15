// The injection path can't be end-to-end tested without a foreground window to
// type into, so the two decisions that are actually easy to get wrong are
// pulled out as pure functions and tested here: what the text should look like,
// and what order the keys go down and up in.
//
// The key order in particular is the kind of bug that only shows up as "it
// sometimes types a stray v into people's documents", which is exactly the sort
// of thing you want a test for rather than a bug report.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { composeOutput, pastePlan, VK } = require('../electron/inject.cjs')

describe('composeOutput', () => {
  test('trims surrounding whitespace', () => {
    assert.equal(composeOutput('  你好  '), '你好')
  })

  test('empty and whitespace-only input produce nothing to send', () => {
    assert.equal(composeOutput(''), '')
    assert.equal(composeOutput('   '), '')
    assert.equal(composeOutput(null), '')
    assert.equal(composeOutput(undefined), '')
  })

  test('appendSpace adds a separator after Latin text', () => {
    assert.equal(composeOutput('hello', { appendSpace: true }), 'hello ')
  })

  test('appendSpace does not add one after Chinese punctuation', () => {
    // 。！？ already separate visually; a space after them is just wrong.
    for (const p of ['。', '！', '？', '，', '；', '）', '】']) {
      assert.equal(composeOutput(`一句话${p}`, { appendSpace: true }), `一句话${p}`)
    }
  })

  test('appendSpace never doubles an existing trailing space', () => {
    assert.equal(composeOutput('hello ', { appendSpace: true }), 'hello ')
  })

  test('interior newlines and spacing are preserved verbatim', () => {
    assert.equal(composeOutput('第一行\n第二行'), '第一行\n第二行')
  })
})

describe('pastePlan', () => {
  test('presses Ctrl+V and releases the modifier last', () => {
    const plan = pastePlan()
    assert.deepEqual(plan, [
      { vk: VK.CONTROL, up: false },
      { vk: VK.V, up: false },
      { vk: VK.V, up: true },
      { vk: VK.CONTROL, up: true },
    ])
    // The invariant, stated as an invariant: Ctrl must still be down when V is.
    const ctrlUp = plan.findIndex((k) => k.vk === VK.CONTROL && k.up)
    const vUp = plan.findIndex((k) => k.vk === VK.V && k.up)
    assert.ok(vUp < ctrlUp, 'releasing Ctrl before V is what types a literal "v"')
  })

  test('every key that goes down comes back up', () => {
    for (const plan of [pastePlan(), pastePlan({ enter: true })]) {
      const held = new Map()
      for (const { vk, up } of plan) held.set(vk, (held.get(vk) || 0) + (up ? -1 : 1))
      for (const [vk, n] of held) assert.equal(n, 0, `vk ${vk} left held down`)
    }
  })

  test('enter is appended after the paste has fully finished', () => {
    const plan = pastePlan({ enter: true })
    assert.equal(plan.length, 6)
    const lastPaste = plan.findIndex((k) => k.vk === VK.CONTROL && k.up)
    const firstEnter = plan.findIndex((k) => k.vk === VK.RETURN)
    assert.ok(firstEnter > lastPaste, 'Enter must not land inside the Ctrl chord')
  })
})
