// Launches Electron against the Vite dev server.
//
// Replaces the `wait-on … && cross-env … electron .` shell chain, which had
// three problems on Windows: it needed two extra dependencies, `&&` chaining
// through npm's cmd shim reports failures as an unreadable batch error, and it
// had no way to clear ELECTRON_RUN_AS_NODE — which some editors and agent
// harnesses export globally, turning the Electron binary into a plain Node
// process where `app` is undefined.
//
// Polling an HTTP endpoint until it answers is about ten lines, so none of that
// was buying anything.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

const URL_ = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5177'
const TIMEOUT_MS = 60_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForServer(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 404) return true
    } catch {
      // Not up yet. ECONNREFUSED is the expected answer for the first second or
      // two; anything else will surface as a timeout below.
    }
    await sleep(250)
  }
  return false
}

const deadline = Date.now() + TIMEOUT_MS
process.stdout.write(`[dev] 等待 ${URL_} …`)
const up = await waitForServer(URL_, deadline)
process.stdout.write(up ? ' 就绪\n' : '\n')

if (!up) {
  console.error(`[dev] ${TIMEOUT_MS / 1000}s 内 Vite 没有起来，不启动 Electron。`)
  process.exit(1)
}

const env = { ...process.env, VITE_DEV_SERVER_URL: URL_ }
// See the header: with this set, require('electron') hands back a path string
// instead of the API, and main.cjs cannot start.
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(require('electron'), ['.'], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
