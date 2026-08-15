// Verifies that everything shipped is actually signed, by the right cert.
//
//   npm run check:sign        (run at the end of `npm run dist`)
//
// The signing hook is deliberately non-fatal by default — a machine without
// SimplySign should still be able to produce a build — which means "the build
// succeeded" says nothing about whether anything got signed. This is the part
// that says it.
//
// Two failure modes it exists to catch, both silent:
//   • the SimplySign session expired mid-build, so the .exe is signed and the
//     installer is not (or vice versa)
//   • something got signed by the self-signed "ChinaClaw Test (DO NOT
//     DISTRIBUTE)" certificate that also lives in this machine's store — which
//     looks signed and is rejected by every machine that isn't this one

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { THUMBPRINT, findSigntool } = require('../electron/sign-win.cjs')

const root = path.join(__dirname, '..')
const release = path.join(root, 'release')
const unpacked = path.join(release, 'win-unpacked')

const results = []
function check(label, ok, detail = '') {
  results.push(ok)
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}
function info(label, value) { console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`) }

/**
 * `signtool verify /pa` — "does this validate under the Authenticode policy",
 * i.e. the question a user's machine will ask, not merely "is there a blob
 * attached".
 */
function verify(signtool, file) {
  try {
    const out = execFileSync(signtool, ['verify', '/pa', '/v', file], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message }
  }
}

/**
 * The signing certificate's leaf thumbprint.
 *
 * `signtool verify /v` prints TWO chains — the signing chain and then the
 * timestamp chain — so "the last SHA1 hash in the output" is the timestamp
 * authority's leaf, not ours. That reads as "signed by the wrong certificate"
 * on a perfectly good build, which is exactly the kind of false alarm that
 * teaches people to ignore a check. Cut the text at the timestamp section and
 * take the last hash before it.
 */
function leafThumbprint(out) {
  const cut = out.search(/The signature is timestamped|Timestamp Verified by/i)
  const signingSection = cut > 0 ? out.slice(0, cut) : out
  const hashes = [...signingSection.matchAll(/SHA1 hash:\s*([0-9A-Fa-f]{40})/g)].map((m) => m[1].toUpperCase())
  return hashes.length ? hashes[hashes.length - 1] : ''
}

function main() {
  console.log('\n=== 快说 · 签名自检 ===')
  const signtool = findSigntool()
  info('signtool', signtool)
  info('期望指纹', THUMBPRINT)

  if (!fs.existsSync(unpacked)) {
    console.error(`\n找不到 ${unpacked}，先跑 npm run dist\n`)
    process.exit(1)
  }

  // Everything a user can double-click. The uninstaller counts: it is what runs
  // when they change their mind, and an unsigned one gets its own SmartScreen
  // warning at exactly the wrong moment.
  const targets = []
  for (const f of fs.readdirSync(unpacked)) {
    if (f.endsWith('.exe')) targets.push(path.join(unpacked, f))
  }
  for (const f of fs.readdirSync(release)) {
    if (f.endsWith('.exe')) targets.push(path.join(release, f))
  }

  check('找到了要检查的可执行文件', targets.length > 0, unpacked)

  for (const file of targets) {
    const name = path.basename(file)
    const r = verify(signtool, file)
    if (!r.ok) {
      check(`${name} 已签名且可验证`, false, r.out.split('\n').filter(Boolean).slice(-3).join(' / '))
      continue
    }
    const leaf = leafThumbprint(r.out)
    const right = leaf === THUMBPRINT
    check(`${name} 已签名且可验证`, true)
    // The important one. A self-signed test cert also produces a valid-looking
    // signature on the machine that made it.
    check(`${name} 用的是正确的证书`, right, `叶证书指纹 ${leaf || '(未解析出)'}`)
    const stamped = /Timestamp|时间戳/i.test(r.out) || /The signature is timestamped/i.test(r.out)
    // Without a timestamp every copy already downloaded goes untrusted the day
    // the certificate expires, rather than staying valid for what it signed.
    check(`${name} 带 RFC3161 时间戳`, stamped, '缺时间戳 —— 证书到期后已发出去的包会全部失效')
  }

  const failed = results.filter((x) => !x).length
  console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${results.length - failed}/${results.length}\x1b[0m\n`)
  process.exit(failed ? 1 : 0)
}

if (require.main === module) main()
