// Windows code-signing hook for electron-builder
// (referenced by electron-builder.yml → win.signtoolOptions.sign).
//
// The certificate is a Certum / SimplySign **cloud** cert: after logging into
// SimplySign Desktop the private key stays in Certum's HSM and the certificate
// appears in the Windows store as a virtual smart card. There is no exportable
// .pfx, so signtool has to pick the cert FROM THE STORE by its SHA-1
// thumbprint — the usual file+password path does not exist here.
//
//   Subject : CN=陕西息壤引擎科技发展有限公司  (O=…, L=西安市, C=CN)
//   Issuer  : Certum Code Signing 2021 CA (Asseco Data Systems / SimplySign)
//
// Targeting one exact thumbprint also means it can never pick up something
// else that happens to be in the store — this machine has a self-signed
// "ChinaClaw Test (DO NOT DISTRIBUTE)" cert sitting right next to the real one,
// and a build silently signed with that would be worse than an unsigned build:
// it looks signed and every user's machine rejects it.
//
// ── Never hang the build ────────────────────────────────────────────────────
// A SimplySign session expires on its own, and when it does the certificate is
// still PRESENT in the store while being unusable. signtool then blocks waiting
// for cloud auth / a PIN that nobody is going to type. So:
//
//   1. every signtool call gets a hard timeout — a wedged one is killed, not
//      waited on;
//   2. one preflight test-sign runs before anything real, and its verdict is
//      cached for the rest of the build, so a dead session costs one timeout
//      total rather than one per file;
//   3. when signing isn't available the build finishes UNSIGNED and says so,
//      loudly, rather than failing.
//
// Set WIN_SIGN_REQUIRE=1 to invert (3) — for a release run, where shipping an
// unsigned installer is worse than not shipping one. `npm run dist:signed`
// does exactly that.
//
// Env overrides (all optional):
//   WIN_SIGN_SHA1       thumbprint to sign with       (no default — unset = don't sign)
//   WIN_SIGN_TIMESTAMP  RFC3161 timestamp server URL  (default: Certum's TSA)
//   WIN_SIGNTOOL        explicit path to signtool.exe (default: auto-detect)
//   WIN_SIGN_TIMEOUT    per-call timeout in ms        (default: 20000)
//   WIN_SIGN_REQUIRE    '1' → fail the build instead of shipping unsigned
'use strict'

const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, copyFileSync, unlinkSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// No default on purpose. A thumbprint is not a secret — it is readable out of
// any signed binary — but baking one into a public repository ties the source
// to a particular certificate holder for no benefit to anyone building it.
// Unset simply means "don't sign", which is the right outcome for a clone.
const THUMBPRINT = (process.env.WIN_SIGN_SHA1 || '')
  .replace(/[^0-9a-fA-F]/g, '')
  .toUpperCase()
// Certum's own timestamp authority. Timestamping is what keeps an installer
// that is already in someone's Downloads folder valid after the signing
// certificate itself expires — without it, everything shipped becomes untrusted
// on 2027-08-04.
const TIMESTAMP = process.env.WIN_SIGN_TIMESTAMP || 'http://time.certum.pl'
const REQUIRE = /^(1|true|yes)$/i.test(process.env.WIN_SIGN_REQUIRE || '')
const TIMEOUT_MS = Number(process.env.WIN_SIGN_TIMEOUT) > 0 ? Number(process.env.WIN_SIGN_TIMEOUT) : 20_000

const SKIP_MARKER = '[win-sign] 已跳过 —— 本次产物未签名'

function findSigntool() {
  if (process.env.WIN_SIGNTOOL && existsSync(process.env.WIN_SIGNTOOL)) {
    return process.env.WIN_SIGNTOOL
  }
  const binRoots = [
    'C:/Program Files (x86)/Windows Kits/10/bin',
    'C:/Program Files/Windows Kits/10/bin',
  ]
  const candidates = []
  for (const root of binRoots) {
    if (!existsSync(root)) continue
    const flat = path.join(root, 'x64', 'signtool.exe')
    if (existsSync(flat)) candidates.push({ ver: '0', p: flat })
    for (const name of readdirSync(root)) {
      const p = path.join(root, name, 'x64', 'signtool.exe')
      if (existsSync(p)) candidates.push({ ver: name, p })
    }
  }
  if (candidates.length) {
    // Newest SDK wins: older signtool.exe builds predate /tr (RFC3161) support.
    candidates.sort((a, b) => b.ver.localeCompare(a.ver, undefined, { numeric: true }))
    return candidates[0].p
  }
  return 'signtool'
}

function runSigntool(signtool, file, stdio) {
  execFileSync(
    signtool,
    [
      'sign',
      '/sha1', THUMBPRINT,   // pick the cert out of the store by thumbprint
      '/fd', 'sha256',       // file digest
      '/tr', TIMESTAMP,      // RFC3161 timestamp server
      '/td', 'sha256',       // timestamp digest
      '/v',
      file,
    ],
    { stdio, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' },
  )
}

// Cached verdict for this build: null = not probed, true/false = answer.
let signingAvailable = null

/**
 * Can we actually sign right now?
 *
 * "Is the certificate in the store" is not the same question and gives the
 * wrong answer: an expired SimplySign session leaves the cert behind while its
 * key is unusable. Worse, `certutil -store` itself blocks on that unusable key
 * — the exact hang this file exists to avoid. The only trustworthy probe is a
 * real signature, so sign a throwaway copy of a small system exe under the
 * timeout and see what happens.
 */
function probeSigning(signtool) {
  const probeFile = path.join(os.tmpdir(), `kuaishuo-sign-probe-${process.pid}.exe`)
  const donor = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'timeout.exe')
  try {
    if (!existsSync(donor)) return false
    copyFileSync(donor, probeFile)
    runSigntool(signtool, probeFile, 'ignore')
    return true
  } catch (e) {
    const why = e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT'
      ? `超时 ${TIMEOUT_MS}ms —— SimplySign 会话多半已过期，signtool 卡在等云端认证`
      : (e.message || 'signtool 失败').split('\n')[0]
    console.warn(`[win-sign] 预检：现在不能签名 —— ${why}`)
    return false
  } finally {
    try { unlinkSync(probeFile) } catch {}
  }
}

exports.default = async function sign(configuration) {
  const file = configuration.path
  if (!THUMBPRINT) throw new Error('[win-sign] WIN_SIGN_SHA1 为空')

  const signtool = findSigntool()

  if (signingAvailable === null) {
    console.log(`[win-sign] 预检签名 ${THUMBPRINT}（超时 ${TIMEOUT_MS}ms）…`)
    console.log(`[win-sign] signtool: ${signtool}`)
    signingAvailable = probeSigning(signtool)
    if (signingAvailable) console.log('[win-sign] 预检通过 —— 本次构建将进行签名')
  }

  if (!signingAvailable) {
    const msg = `证书 ${THUMBPRINT} 不可用（SimplySign Desktop 登录了吗？）`
    if (REQUIRE) throw new Error(`[win-sign] ${msg}，且设置了 WIN_SIGN_REQUIRE`)
    console.warn(`${SKIP_MARKER} —— ${msg}`)
    return
  }

  console.log(`[win-sign] 签名 ${path.basename(file)}`)
  try {
    runSigntool(signtool, file, 'inherit')
  } catch (e) {
    // The session can die mid-build. Don't wedge the rest of the run and don't
    // half-sign: downgrade to skipped from here on, unless strict mode.
    signingAvailable = false
    if (REQUIRE) throw e
    console.warn(`${SKIP_MARKER} —— ${path.basename(file)} 签名失败：${(e.message || '').split('\n')[0]}`)
  }
}

module.exports.THUMBPRINT = THUMBPRINT
module.exports.findSigntool = findSigntool
