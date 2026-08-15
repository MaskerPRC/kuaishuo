// The guard between a half-written model file and a native crash.
//
// This is a regression test for a real one: extraction creates
// model.int8.onnx as an empty file and then spends ~20s filling it, and the
// original readiness check was existsSync(). Anything that asked "is the model
// ready?" during that window got `true`, handed a few kilobytes of a 239MB ONNX
// to sherpa-onnx, and the process died — no exception, no stack, just gone.
//
// Pressing the mic ten seconds after launch was enough to hit it.

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { verifyModelDir, MIN_MODEL_BYTES, MIN_TOKENS_BYTES } = require('../electron/asr-service.cjs')

let dir

/** Write a file of exactly `bytes` length without allocating it in memory. */
function sparse(file, bytes) {
  const fd = fs.openSync(file, 'w')
  try {
    if (bytes > 0) {
      fs.ftruncateSync(fd, bytes)   // sparse where the FS supports it
    }
  } finally {
    fs.closeSync(fd)
  }
}

function install({ model, tokens }) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  if (model !== null) sparse(path.join(dir, 'model.int8.onnx'), model)
  if (tokens !== null) sparse(path.join(dir, 'tokens.txt'), tokens)
}

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuaishuo-model-')) })
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

describe('verifyModelDir', () => {
  test('accepts a complete install', () => {
    install({ model: 239_233_841, tokens: 315_894 })
    const v = verifyModelDir(dir)
    assert.equal(v.ok, true, JSON.stringify(v))
  })

  test('rejects the empty file extraction creates at t=0', () => {
    // The exact state that crashed the app: the file exists, and that used to
    // be the entire readiness check.
    install({ model: 0, tokens: 315_894 })
    const v = verifyModelDir(dir)
    assert.equal(v.ok, false)
    assert.equal(v.reason, 'model-truncated')
    assert.equal(v.size, 0)
  })

  test('rejects a partially-written model', () => {
    // 3.2MB is what was actually on disk when the crash was caught.
    install({ model: 3_249_717, tokens: 315_894 })
    const v = verifyModelDir(dir)
    assert.equal(v.ok, false)
    assert.equal(v.reason, 'model-truncated')
  })

  test('rejects a truncated token table', () => {
    install({ model: 239_233_841, tokens: 12 })
    const v = verifyModelDir(dir)
    assert.equal(v.ok, false)
    assert.equal(v.reason, 'tokens-truncated')
  })

  test('rejects a missing model or missing tokens', () => {
    install({ model: null, tokens: 315_894 })
    assert.equal(verifyModelDir(dir).reason, 'missing')
    install({ model: 239_233_841, tokens: null })
    assert.equal(verifyModelDir(dir).reason, 'missing')
  })

  test('rejects a directory that does not exist at all', () => {
    const v = verifyModelDir(path.join(dir, 'nope'))
    assert.equal(v.ok, false)
    assert.equal(v.reason, 'missing')
  })

  test('rejects a directory where the model is a directory', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, 'model.int8.onnx'), { recursive: true })
    sparse(path.join(dir, 'tokens.txt'), 315_894)
    const v = verifyModelDir(dir)
    assert.equal(v.ok, false)
  })

  test('the thresholds sit far below the real artefacts', () => {
    // Floors exist to separate "a usable model" from "the first few megabytes
    // of one", not to pin an exact release. They must not start failing if
    // upstream re-exports the model a little smaller.
    assert.ok(MIN_MODEL_BYTES < 239_233_841 / 2, 'model floor should be well under the real size')
    assert.ok(MIN_TOKENS_BYTES < 315_894 / 2, 'tokens floor should be well under the real size')
    // …but high enough that a few megabytes of a partial write is still caught.
    assert.ok(MIN_MODEL_BYTES > 20 * 1024 * 1024)
  })

  test('accepts exactly the floor and rejects one byte under it', () => {
    install({ model: MIN_MODEL_BYTES, tokens: MIN_TOKENS_BYTES })
    assert.equal(verifyModelDir(dir).ok, true)
    install({ model: MIN_MODEL_BYTES - 1, tokens: MIN_TOKENS_BYTES })
    assert.equal(verifyModelDir(dir).ok, false)
  })
})
