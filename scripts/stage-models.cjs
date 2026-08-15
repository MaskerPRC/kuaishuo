// Copies the recogniser and the speaker model into build/models/ so
// electron-builder can ship them inside the installer.
//
//   node scripts/stage-models.cjs
//
// The weights are ~267MB and are not in the repository — nobody wants a git
// history with a quarter-gigabyte binary in it. They come from wherever this
// machine already downloaded them (the app's own userData), which is the same
// copy the dev build has been using, so what gets shipped is exactly what has
// been tested against.
//
// Run `npm run probe:model` first if this machine has never fetched them.

const fs = require('fs')
const path = require('path')

const MODEL_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const SPK_NAME = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'

const MIN_MODEL_BYTES = 100 * 1024 * 1024
const MIN_SPK_BYTES = 5 * 1024 * 1024

function userDataRoot() {
  if (process.env.KUAISHUO_USER_DATA) return process.env.KUAISHUO_USER_DATA
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'kuaishuo')
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', 'kuaishuo')
  return path.join(process.env.HOME || '', '.config', 'kuaishuo')
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function main() {
  const src = userDataRoot()
  const out = path.join(__dirname, '..', 'build', 'models')

  const modelFrom = path.join(src, 'asr-models', MODEL_NAME)
  const onnx = path.join(modelFrom, 'model.int8.onnx')

  let size = 0
  try { size = fs.statSync(onnx).size } catch { /* not there */ }
  if (size < MIN_MODEL_BYTES) {
    console.error(
      `\n找不到可用的识别模型：\n  ${onnx}\n` +
      (size ? `  （只有 ${mb(size)}，像是没下完）\n` : '  （文件不存在）\n') +
      '\n先跑 `npm run probe:model` 把模型下下来，再执行打包。\n',
    )
    process.exit(1)
  }

  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  // Only what the recogniser actually loads. The archive also contains test
  // wavs, a LICENSE and an export script — 1MB of things an installer has no
  // reason to carry.
  const modelTo = path.join(out, MODEL_NAME)
  fs.mkdirSync(modelTo, { recursive: true })
  let total = 0
  for (const f of ['model.int8.onnx', 'tokens.txt', 'LICENSE']) {
    const from = path.join(modelFrom, f)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(modelTo, f))
    const s = fs.statSync(from).size
    total += s
    console.log(`  ${f.padEnd(18)} ${mb(s)}`)
  }

  // The speaker model is what makes "only my voice" and meeting diarization
  // work. Shipping the recogniser without it would leave both features looking
  // available and silently needing a download the first time they're used.
  const spkFrom = path.join(src, 'speaker-models', SPK_NAME)
  try {
    const s = fs.statSync(spkFrom).size
    if (s >= MIN_SPK_BYTES) {
      fs.copyFileSync(spkFrom, path.join(out, SPK_NAME))
      total += s
      console.log(`  ${'声纹模型'.padEnd(16)} ${mb(s)}`)
    }
  } catch {
    console.warn('  ⚠ 声纹模型未安装，本次打包不含它（声纹校验和会议分人首次使用时会自行下载）')
  }

  console.log(`\n已放入 build/models —— 共 ${mb(total)}\n`)
}

if (require.main === module) main()
module.exports = { userDataRoot, MODEL_NAME, SPK_NAME }
