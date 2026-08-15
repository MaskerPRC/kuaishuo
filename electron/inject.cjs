// Putting recognised text into whatever app currently has focus.
//
// This is the one thing that makes 快说 an input method rather than a recorder,
// and the whole design turns on a single constraint: the overlay window must
// never take focus. It's created with `focusable: false` (WS_EX_NOACTIVATE on
// Windows), so the app the user was typing in is still the foreground window
// when a sentence finishes — which means a synthetic Ctrl+V goes exactly where
// they were already looking, with no window juggling, no SetForegroundWindow,
// and no race with the OS focus-stealing prevention.
//
// Paste rather than per-character synthesis, for the same reason chinaClaw's
// webview injector does it: rich editors (Draft.js / Lexical / TipTap / Quill,
// and every Electron chat app built on one) keep their own document model, and
// only the real paste path keeps that model in sync. Character events leave
// half of them showing text the app doesn't believe is there.
//
// Two implementations, tried in order:
//   1. koffi → user32.keybd_event. In-process, ~0ms, no window flicker.
//   2. PowerShell SendKeys. ~400ms and spawns a process, but it's there when
//      the FFI can't load (older Windows, a locked-down machine, an arch the
//      prebuilt koffi binary doesn't cover).
// macOS and Linux get osascript / xdotool so the app is at least not broken
// there; Windows is the target.

const { spawn } = require('child_process')

// ---- Key plan (pure, testable) ----------------------------------------------

// Virtual-key codes. Only the handful we actually press.
const VK = { CONTROL: 0x11, SHIFT: 0x10, MENU: 0x12, V: 0x56, RETURN: 0x0D }
const KEYEVENTF_KEYUP = 0x0002

/**
 * The key events a paste is made of, as data. Down in order, up in reverse:
 * releasing the modifier before the key it modified is how you get a stray "v"
 * typed into the document instead of a paste.
 *
 * @param {object} [o]
 * @param {boolean} [o.enter] press Return afterwards (send the message)
 * @returns {Array<{vk:number, up:boolean}>}
 */
function pastePlan({ enter = false } = {}) {
  const plan = [
    { vk: VK.CONTROL, up: false },
    { vk: VK.V, up: false },
    { vk: VK.V, up: true },
    { vk: VK.CONTROL, up: true },
  ]
  if (enter) plan.push({ vk: VK.RETURN, up: false }, { vk: VK.RETURN, up: true })
  return plan
}

/**
 * How the text should look once it lands. Kept separate from the transport so
 * "what gets typed" is decided by one testable function rather than by whoever
 * happened to call the injector.
 */
function composeOutput(text, { appendSpace = false, previousEndedSentence = false } = {}) {
  let out = String(text ?? '').trim()
  if (!out) return ''
  // A dictated sentence following another one needs a separator or the two run
  // together. Only for scripts that use spaces — inserting one between two
  // Chinese sentences would be wrong, and 。？！ already separate visually.
  if (appendSpace && !/[\s]$/.test(out) && !/[。！？；，、）】」』]$/.test(out)) out += ' '
  return out
}

// ---- Windows: koffi ---------------------------------------------------------

let _win = null       // { keybd_event, MapVirtualKeyW, GetForegroundWindow, GetWindowTextW }
let _winFailed = false

function win32() {
  if (_win || _winFailed) return _win
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    _win = {
      keybd_event: user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, size_t dwExtraInfo)'),
      MapVirtualKeyW: user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)'),
      GetForegroundWindow: user32.func('void *__stdcall GetForegroundWindow()'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)'),
    }
  } catch (err) {
    console.warn('[inject] koffi/user32 unavailable, falling back to PowerShell:', err.message)
    _winFailed = true
    _win = null
  }
  return _win
}

function winSendPlan(plan) {
  const w = win32()
  if (!w) return false
  for (const { vk, up } of plan) {
    // Real keyboards report a scan code alongside the virtual key, and a few
    // apps (notably older Win32 controls and some games) look at it. Deriving
    // it costs one call and removes a class of "works everywhere except there".
    let scan = 0
    try { scan = w.MapVirtualKeyW(vk, 0) & 0xff } catch { scan = 0 }
    w.keybd_event(vk, scan, up ? KEYEVENTF_KEYUP : 0, 0)
  }
  return true
}

/** Title of the window that will receive the paste. Best-effort, for history. */
function foregroundWindowTitle() {
  if (process.platform !== 'win32') return ''
  const w = win32()
  if (!w) return ''
  try {
    const hwnd = w.GetForegroundWindow()
    if (!hwnd) return ''
    const buf = Buffer.alloc(512)
    const n = w.GetWindowTextW(hwnd, buf, 255)
    if (n <= 0) return ''
    return buf.toString('utf16le', 0, n * 2)
  } catch {
    return ''
  }
}

// ---- Fallback transports ----------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

function psSendKeys({ enter }) {
  // -STA is required: SendKeys lives in WinForms and throws on an MTA thread.
  const keys = enter ? '^v{ENTER}' : '^v'
  return run('powershell', [
    '-NoProfile', '-NonInteractive', '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`,
  ])
}

function macPaste({ enter }) {
  const script = enter
    ? 'tell application "System Events" to keystroke "v" using command down\ndelay 0.05\ntell application "System Events" to key code 36'
    : 'tell application "System Events" to keystroke "v" using command down'
  return run('osascript', ['-e', script])
}

function linuxPaste({ enter }) {
  return run('xdotool', enter ? ['key', 'ctrl+v', 'Return'] : ['key', 'ctrl+v'])
}

// ---- Public -----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Send `text` to the focused application.
 *
 * @param {string} text
 * @param {object} [o]
 * @param {'type'|'clipboard'|'none'} [o.mode]
 * @param {boolean} [o.enter]             press Return after pasting
 * @param {boolean} [o.restoreClipboard]  put the user's clipboard back
 * @param {boolean} [o.appendSpace]
 * @returns {Promise<{ok:boolean, mode:string, via?:string, chars:number, target?:string, error?:string}>}
 */
async function sendText(text, {
  mode = 'type', enter = false, restoreClipboard = true, appendSpace = false,
} = {}) {
  const out = composeOutput(text, { appendSpace })
  if (!out) return { ok: false, mode, chars: 0, error: 'empty' }
  if (mode === 'none') return { ok: true, mode, chars: out.length }

  const { clipboard } = require('electron')

  // Only text clipboards are restorable through this API — an image or a file
  // list would come back as an empty string, which is worse than leaving the
  // dictated text there. So: snapshot only when text is what's on the board.
  const canRestore = restoreClipboard && clipboard.availableFormats().some((f) => f.startsWith('text/'))
  const previous = canRestore ? clipboard.readText() : null

  clipboard.writeText(out)

  if (mode === 'clipboard') {
    // Deliberately no restore here: the whole point of this mode is that the
    // text stays on the clipboard until the user pastes it themselves.
    return { ok: true, mode, chars: out.length, via: 'clipboard' }
  }

  const target = foregroundWindowTitle()
  let via = null
  let ok = false

  if (process.platform === 'win32') {
    if (winSendPlan(pastePlan({ enter }))) { ok = true; via = 'user32' }
    else { ok = await psSendKeys({ enter }); via = 'powershell' }
  } else if (process.platform === 'darwin') {
    ok = await macPaste({ enter }); via = 'osascript'
  } else {
    ok = await linuxPaste({ enter }); via = 'xdotool'
  }

  if (previous !== null) {
    // Long enough for the target app to have read the board — a paste is
    // synchronous from the app's side but the keystroke itself is queued, and
    // restoring too early hands it the old content instead.
    sleep(700).then(() => {
      try { if (clipboard.readText() === out) clipboard.writeText(previous) } catch {}
    })
  }

  return { ok, mode, via, chars: out.length, target, ...(ok ? {} : { error: `${via} injection failed` }) }
}

module.exports = {
  sendText, composeOutput, pastePlan, foregroundWindowTitle,
  VK, KEYEVENTF_KEYUP,
}
