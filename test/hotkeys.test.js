// Accelerator → virtual-key translation.
//
// This drives push-to-talk, and it fails silently when it is wrong: the wrong
// code means Windows is asked about a key nobody is holding, so the recording
// either stops the instant it starts or never stops at all. Neither says
// "wrong key code" to anyone looking at it.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { acceleratorToVk, VK, MODIFIERS } = require('../electron/hotkeys.cjs')

describe('acceleratorToVk', () => {
  test('finds the key past any number of modifiers', () => {
    assert.equal(acceleratorToVk('Space'), 0x20)
    assert.equal(acceleratorToVk('Control+Space'), 0x20)
    assert.equal(acceleratorToVk('Control+Shift+Space'), 0x20)
    assert.equal(acceleratorToVk('Control+Alt+Shift+Super+Space'), 0x20)
  })

  test('the defaults this app ships map to the right keys', () => {
    assert.equal(acceleratorToVk('Control+Shift+Space'), 0x20)
    assert.equal(acceleratorToVk('Control+Shift+D'), 0x44)
    assert.equal(acceleratorToVk('Control+Shift+M'), 0x4D)
    assert.equal(acceleratorToVk('Control+Shift+X'), 0x58)
    assert.equal(acceleratorToVk('Control+Shift+H'), 0x48)
  })

  test('letters and digits are their ASCII codes', () => {
    assert.equal(acceleratorToVk('A'), 0x41)
    assert.equal(acceleratorToVk('Z'), 0x5A)
    assert.equal(acceleratorToVk('0'), 0x30)
    assert.equal(acceleratorToVk('9'), 0x39)
    // Case must not matter — Electron accepts either.
    assert.equal(acceleratorToVk('Control+a'), acceleratorToVk('Control+A'))
  })

  test('function keys', () => {
    assert.equal(acceleratorToVk('F1'), 0x70)
    assert.equal(acceleratorToVk('F12'), 0x7B)
    assert.equal(acceleratorToVk('F24'), 0x87)
    assert.equal(acceleratorToVk('F25'), null, 'there is no F25')
    assert.equal(acceleratorToVk('F0'), null)
  })

  test('named keys', () => {
    assert.equal(acceleratorToVk('Control+Enter'), VK.RETURN)
    assert.equal(acceleratorToVk('Alt+Tab'), VK.TAB)
    assert.equal(acceleratorToVk('Esc'), VK.ESCAPE)
    assert.equal(acceleratorToVk('Control+Up'), VK.UP)
    assert.equal(acceleratorToVk('Control+Delete'), VK.DELETE)
  })

  test('modifier-only accelerators have no key to watch', () => {
    // Not a valid shortcut anyway, but returning some arbitrary code here would
    // make push-to-talk watch a key at random.
    assert.equal(acceleratorToVk('Control'), null)
    assert.equal(acceleratorToVk('Control+Shift'), null)
    assert.equal(acceleratorToVk('CommandOrControl+Alt'), null)
  })

  test('every modifier spelling Electron accepts is treated as a modifier', () => {
    for (const m of ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl',
                     'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']) {
      assert.ok(MODIFIERS.has(m.toUpperCase()), m)
      // …and so combining it with a real key still finds the real key.
      assert.equal(acceleratorToVk(`${m}+K`), 0x4B, m)
    }
  })

  test('rubbish in, null out — never a wrong code', () => {
    for (const bad of ['', null, undefined, '   ', '+++', 42, {}]) {
      assert.equal(acceleratorToVk(bad), null, JSON.stringify(bad))
    }
  })

  test('unknown key names are null rather than a guess', () => {
    assert.equal(acceleratorToVk('Control+VolumeUp'), null)
    assert.equal(acceleratorToVk('Control+Nonsense'), null)
  })

  test('punctuation keys map to their OEM codes', () => {
    assert.equal(acceleratorToVk('Control+;'), 0xBA)
    assert.equal(acceleratorToVk('Control+/'), 0xBF)
    assert.equal(acceleratorToVk('Control+['), 0xDB)
  })
})
