// Checks a built installer for the things that are only wrong after you ship.
//
//   npm run check:dist        (run automatically at the end of `npm run dist`)
//
// Everything here has the same shape of failure: the build succeeds, the
// installer looks fine, and the app is broken on someone else's machine in a
// way no test on this one would catch — a native module packed into the asar
// where it cannot be dlopen'd, a model directory that got filtered out, weights
// truncated by a copy that ran out of disk.

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const unpacked = path.join(root, 'release', 'win-unpacked')
const { verifyModelDir, MODEL_NAME, SPK_NAME } = require('../electron/asr-service.cjs')

const results = []
function check(label, ok, detail = '') {
  results.push(ok)
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}
function info(label, value) { console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`) }
function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`

function sizeOf(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

function main() {
  console.log('\n=== 快说 · 打包产物自检 ===')

  if (!fs.existsSync(unpacked)) {
    console.error(`\n找不到 ${unpacked}\n先跑 npm run dist。\n`)
    process.exit(1)
  }

  stage('1. 内置模型')
  const models = path.join(unpacked, 'resources', 'models')
  const modelDir = path.join(models, MODEL_NAME)
  const verdict = verifyModelDir(modelDir)
  info('模型目录', modelDir)
  // The same guard the app uses at runtime. If this rejects it, so will the
  // app — and there the symptom is a native crash on the first sentence.
  check('识别模型通过 app 自己的完整性校验', verdict.ok,
    `${verdict.reason}${verdict.size ? ` (${mb(verdict.size)})` : ''}`)
  if (verdict.ok) info('权重大小', mb(verdict.size))

  const spk = sizeOf(path.join(models, SPK_NAME))
  check('声纹模型已内置', spk >= 5 * 1024 * 1024, spk ? mb(spk) : '不存在')
  if (spk) info('声纹模型大小', mb(spk))

  stage('2. 原生模块必须在 asar 之外')
  // A .node inside an asar cannot be dlopen'd — the loader needs a real file on
  // disk. This is the classic Electron packaging failure: it works unpacked and
  // dies in the installer.
  const unpackedRoot = path.join(unpacked, 'resources', 'app.asar.unpacked', 'node_modules')
  for (const mod of ['sherpa-onnx-node', 'koffi']) {
    check(`${mod} 已解包`, fs.existsSync(path.join(unpackedRoot, mod)),
      `${path.join(unpackedRoot, mod)} 不存在 —— 检查 electron-builder.yml 的 asarUnpack`)
  }
  // The binaries do not live inside sherpa-onnx-node or koffi themselves —
  // both are thin loaders that require a per-platform sibling package
  // (sherpa-onnx-win-x64, @koromix/koffi-win32-x64). So the question is not
  // "is this package unpacked" but "is there a loadable binary anywhere out
  // here at all", which is what actually breaks on a user's machine.
  const binaries = fs.existsSync(unpackedRoot)
    ? fs.readdirSync(unpackedRoot, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.node') || f.endsWith('.dll'))
    : []
  for (const f of binaries) info('原生二进制', f)
  check('sherpa 的 .node 已解包', binaries.some((f) => f.includes('sherpa') && f.endsWith('.node')),
    '找不到 sherpa-onnx.node —— asar 里的 .node 无法 dlopen，第一句话就会原生崩溃')
  check('onnxruntime 的 DLL 已解包', binaries.some((f) => f.includes('onnxruntime')),
    'sherpa 的 .node 依赖它们，缺了就加载失败')
  check('koffi 的 .node 已解包', binaries.some((f) => f.includes('koffi') && f.endsWith('.node')),
    '缺了就退回 PowerShell 注入，慢一个数量级')

  stage('3. 应用本体')
  const asar = sizeOf(path.join(unpacked, 'resources', 'app.asar'))
  check('app.asar 存在', asar > 0)
  info('app.asar', mb(asar))
  // The renderer bundle has to be in there, or the windows come up blank.
  check('渲染层已构建', fs.existsSync(path.join(root, 'dist', 'index.html')) &&
    fs.existsSync(path.join(root, 'dist', 'overlay.html')))

  const exe = fs.readdirSync(unpacked).find((f) => f.endsWith('.exe'))
  check('有可执行文件', !!exe, unpacked)
  if (exe) info('可执行文件', exe)

  stage('4. 安装包')
  const rel = path.join(root, 'release')
  const setup = fs.readdirSync(rel).filter((f) => f.endsWith('.exe') && f.includes('Setup'))
  check('生成了安装包', setup.length > 0, rel)
  for (const f of setup) {
    const s = sizeOf(path.join(rel, f))
    info(f, mb(s))
    // Weights alone are ~255MB; anything much under that means they were left
    // out and the installer would silently fall back to downloading them.
    check('安装包体积包含了模型（>200MB）', s > 200 * 1024 * 1024, mb(s))
  }

  const failed = results.filter((x) => !x).length
  console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length}\x1b[0m\n`)
  process.exit(failed ? 1 : 0)
}

if (require.main === module) main()
