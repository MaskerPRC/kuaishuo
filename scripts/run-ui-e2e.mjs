// Launcher for the in-app harnesses.
//
//   node scripts/run-ui-e2e.mjs         → scripts/ui-harness.cjs   (throwaway profile)
//   node scripts/run-ui-e2e.mjs mic     → scripts/mic-harness.cjs  (throwaway profile)
//   node scripts/run-ui-e2e.mjs model   → scripts/model-harness.cjs (REAL profile)
//
// Most harnesses get a temp userData so a run can click switches and start
// meetings without touching anyone's settings or history. The model harness is
// the exception: downloading 228MB into a directory that is deleted seconds
// later would be an expensive way to learn nothing, and leaving the weights in
// the real profile is the whole point — the next launch is then instant.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

const which = process.argv[2] || 'ui'
const useRealProfile = which === 'model'

const dataDir = useRealProfile ? null : fs.mkdtempSync(path.join(os.tmpdir(), `kuaishuo-${which}-`))

const env = { ...process.env, KUAISHUO_E2E: which }
if (dataDir) {
  env.KUAISHUO_USER_DATA = dataDir
  // Throwaway profile: don't pull 228MB that is about to be deleted, and don't
  // let a background download change the strip mid-assertion.
  env.KUAISHUO_NO_PREFETCH = '1'
  linkRealModel(dataDir)
}

/**
 * Point the throwaway profile at the real model, if this machine has one.
 *
 * Without it the harness runs in a state almost no real user is in — "model
 * absent" — where pressing the mic starts a download and the strip shows
 * progress in the slot the tests expect other things in. A junction costs
 * nothing and no bytes are copied.
 *
 * A fabricated placeholder is NOT an option, however tempting: starting
 * dictation preloads the recogniser, and sherpa-onnx handed a zero-filled file
 * takes the process down with it.
 */
function linkRealModel(profile) {
  const asr = require('../electron/asr-service.cjs')
  const realRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'kuaishuo')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'kuaishuo')
      : path.join(os.homedir(), '.config', 'kuaishuo')

  const realModel = path.join(realRoot, 'asr-models', asr.MODEL_NAME)
  if (asr.verifyModelDir(realModel).ok) {
    const dest = path.join(profile, 'asr-models')
    fs.mkdirSync(dest, { recursive: true })
    try {
      fs.symlinkSync(realModel, path.join(dest, asr.MODEL_NAME), 'junction')
    } catch (err) {
      console.error(`[harness] 无法链接模型（${err.code}），将以"模型未安装"状态运行`)
    }
  }

  // The speaker model is a single 28MB file; a file symlink needs Developer
  // Mode on Windows, so copy it instead. Cheap, and it keeps meeting
  // diarization from kicking off a download mid-test.
  const realSpk = path.join(realRoot, 'speaker-models', asr.SPK_NAME)
  try {
    if (fs.statSync(realSpk).size > 5 * 1024 * 1024) {
      const dir = path.join(profile, 'speaker-models')
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(realSpk, path.join(dir, asr.SPK_NAME))
    }
  } catch { /* not installed; the test just runs without it */ }
}
// Some editors and agent harnesses export this globally, which turns the
// Electron binary into a plain Node process and makes `app` undefined.
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(require('electron'), ['.'], { cwd: root, env, stdio: 'inherit' })

child.on('exit', (code) => {
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {} }
  process.exit(code ?? 1)
})
