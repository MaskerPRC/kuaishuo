// Download the weights into a userData-shaped directory, for machines that
// have never run the app.
//
//   node scripts/fetch-models.cjs [目标目录]
//
// stage-models.cjs copies from wherever this machine already downloaded the
// models — which is exactly right on a dev box and useless on a CI runner,
// where nothing has ever run. This fills that gap: same URLs the app itself
// uses, same layout on disk, so `stage-models` afterwards cannot tell the
// difference.
//
// Defaults to the app's real userData path, so running it by hand on a fresh
// machine also just works. CI points it at a cache directory with
// KUAISHUO_USER_DATA.
//
// Idempotent: a model already present and big enough is left alone, which is
// what makes the CI cache worth having.

const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

const MODEL_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
const SPK_NAME = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'

const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
const SPK_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPK_NAME}`

// Same floors asr-service.cjs uses. A truncated download that still "exists"
// is the failure worth catching — it gets shipped and then crashes on the
// user's first sentence.
const MIN_MODEL_BYTES = 100 * 1024 * 1024
const MIN_SPK_BYTES = 5 * 1024 * 1024

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`

function userDataRoot() {
  if (process.argv[2]) return path.resolve(process.argv[2])
  if (process.env.KUAISHUO_USER_DATA) return process.env.KUAISHUO_USER_DATA
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'kuaishuo')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'kuaishuo')
  return path.join(os.homedir(), '.config', 'kuaishuo')
}

function sizeOf(file) {
  try { return fs.statSync(file).size } catch { return 0 }
}

/** GET with redirects — the release assets are a 302 to a CDN. */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'kuaishuo-fetch-models' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (!redirectsLeft) return reject(new Error(`重定向过多: ${url}`))
        return resolve(download(res.headers.location, dest, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`))
      }
      const total = Number(res.headers['content-length'] || 0)
      // Written to .partial and renamed only on success, so an interrupted run
      // can never leave something that looks complete enough to ship.
      const tmp = `${dest}.partial`
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(tmp)
      let got = 0
      let lastPct = -1
      res.on('data', (c) => {
        got += c.length
        if (!total) return
        const pct = Math.floor((got / total) * 100)
        if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`    ${pct}%\n`) }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, dest) } catch (err) { return reject(err) }
        resolve()
      }))
      out.on('error', reject)
    }).on('error', reject)
  })
}

/**
 * Decompress with the same pure-JS path the app uses, not the system tar.
 *
 * Shelling out to `tar` was tried and fails: under Git Bash — which is what
 * `shell: bash` gets you on a Windows runner — `tar` resolves to MSYS GNU tar,
 * which reads `C:\...` as a *remote host* spec and dies with "Cannot connect to
 * C: resolve failed". asr-service.cjs already learned this and extracts in
 * JS; doing the same here means one fewer thing that behaves differently on
 * someone else's machine.
 */
async function extract(tarPath, intoDir) {
  const compressing = require('compressing')
  const unbzip2 = require('unbzip2-stream')
  fs.mkdirSync(intoDir, { recursive: true })
  await new Promise((resolve, reject) => {
    const sink = new compressing.tar.UncompressStream()
    sink.on('entry', (header, stream, next) => {
      const dest = path.join(intoDir, header.name)
      if (header.type === 'directory') {
        fs.mkdirSync(dest, { recursive: true })
        stream.resume()
        stream.on('end', next)
        return
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(dest)
      stream.pipe(out)
      // next() only after the file is flushed, so 'finish' really does mean
      // everything is on disk.
      out.on('finish', next)
      out.on('error', reject)
      stream.on('error', reject)
    })
    sink.on('finish', resolve)
    sink.on('error', reject)
    const src = fs.createReadStream(tarPath)
    src.on('error', reject)
    src.pipe(unbzip2()).pipe(sink)
  })
}

async function main() {
  const root = userDataRoot()
  const modelDir = path.join(root, 'asr-models', MODEL_NAME)
  const onnx = path.join(modelDir, 'model.int8.onnx')
  const spk = path.join(root, 'speaker-models', SPK_NAME)

  console.log(`目标目录: ${root}\n`)

  if (sizeOf(onnx) >= MIN_MODEL_BYTES) {
    console.log(`识别模型已就位 (${mb(sizeOf(onnx))})，跳过`)
  } else {
    console.log('下载识别模型…')
    const tar = path.join(root, 'asr-models', `${MODEL_NAME}.tar.bz2`)
    await download(MODEL_URL, tar)
    console.log('解压…')
    await extract(tar, path.join(root, 'asr-models'))
    fs.rmSync(tar, { force: true })
    const got = sizeOf(onnx)
    if (got < MIN_MODEL_BYTES) throw new Error(`解压后模型只有 ${mb(got)}，像是没下完`)
    console.log(`识别模型 ${mb(got)}`)
  }

  if (sizeOf(spk) >= MIN_SPK_BYTES) {
    console.log(`声纹模型已就位 (${mb(sizeOf(spk))})，跳过`)
  } else {
    console.log('下载声纹模型…')
    await download(SPK_URL, spk)
    const got = sizeOf(spk)
    if (got < MIN_SPK_BYTES) throw new Error(`声纹模型只有 ${mb(got)}，像是没下完`)
    console.log(`声纹模型 ${mb(got)}`)
  }

  console.log('\n模型齐了，可以 npm run dist 了')
}

main().catch((err) => {
  console.error(`\n拉取模型失败：${err.message}\n`)
  process.exit(1)
})
