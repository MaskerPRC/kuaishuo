// Accelerator parsing, and the one thing Electron's globalShortcut cannot do:
// tell you when the key came back up.
//
// `globalShortcut.register` fires on key-down only. That is fine for a toggle
// and useless for push-to-talk, which is defined entirely by the release. The
// usual answer is a low-level keyboard hook, which means a native module and a
// permanent hook into every keystroke on the machine — a heavy and slightly
// alarming thing to install for one feature.
//
// GetAsyncKeyState is the cheap alternative: given the virtual-key code, ask
// Windows whether it is down right now. Poll it after the shortcut fires and
// stop when the answer is no. It reads one key's state on demand rather than
// observing all of them, which is both faster and a much smaller thing to be
// doing on someone's computer.

const VK = {
  BACKSPACE: 0x08, TAB: 0x09, RETURN: 0x0D, ENTER: 0x0D, SHIFT: 0x10,
  CONTROL: 0x11, ALT: 0x12, MENU: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14,
  ESC: 0x1B, ESCAPE: 0x1B, SPACE: 0x20,
  PAGEUP: 0x21, PAGEDOWN: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  INSERT: 0x2D, DELETE: 0x2E,
  NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF,
  '`': 0xC0, '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE,
}

const MODIFIERS = new Set([
  'CMD', 'COMMAND', 'CONTROL', 'CTRL', 'COMMANDORCONTROL', 'CMDORCTRL',
  'ALT', 'OPTION', 'ALTGR', 'SHIFT', 'SUPER', 'META',
])

/**
 * The virtual-key code for an accelerator's *non-modifier* key.
 *
 * Exported and tested on its own because the failure mode is silent: a wrong
 * code means GetAsyncKeyState watches a key nobody pressed, which reads as
 * "push-to-talk releases instantly" or "never releases" depending on which key
 * it landed on.
 *
 * @param {string} accelerator e.g. 'Control+Shift+Space'
 * @returns {number|null} null when there is no key, only modifiers
 */
function acceleratorToVk(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return null
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.reverse().find((p) => !MODIFIERS.has(p.toUpperCase()))
  if (!key) return null

  const upper = key.toUpperCase()
  if (Object.prototype.hasOwnProperty.call(VK, upper)) return VK[upper]
  if (Object.prototype.hasOwnProperty.call(VK, key)) return VK[key]

  // F1..F24
  const fn = upper.match(/^F(\d{1,2})$/)
  if (fn) {
    const n = Number(fn[1])
    if (n >= 1 && n <= 24) return 0x6F + n
  }

  // Single letters and digits map to their ASCII code, which is also their VK.
  if (upper.length === 1) {
    const c = upper.charCodeAt(0)
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A)) return c
  }
  return null
}

// ---- Key state --------------------------------------------------------------

let _user32 = null
let _failed = false

function user32() {
  if (_user32 || _failed) return _user32
  if (process.platform !== 'win32') { _failed = true; return null }
  try {
    const koffi = require('koffi')
    const lib = koffi.load('user32.dll')
    _user32 = {
      GetAsyncKeyState: lib.func('int16_t __stdcall GetAsyncKeyState(int vKey)'),
    }
  } catch (err) {
    console.warn('[hotkeys] user32 unavailable, push-to-talk will fall back to tap mode:', err.message)
    _failed = true
    _user32 = null
  }
  return _user32
}

function isKeyDown(vk) {
  const u = user32()
  if (!u || vk == null) return false
  try {
    // The high bit means "down right now". The low bit is "was pressed since
    // the last call", which is a different question and the one that makes this
    // API easy to misuse.
    return (u.GetAsyncKeyState(vk) & 0x8000) !== 0
  } catch {
    return false
  }
}

/** Can we actually observe a release on this platform? */
function canWatchRelease() {
  return !!user32()
}

/**
 * Call `onRelease` once the accelerator's key is no longer held.
 *
 * @param {string} accelerator
 * @param {(heldMs:number) => void} onRelease
 * @param {object} [o]
 * @param {number} [o.pollMs]  40ms is imperceptible on a key release and costs
 *        one syscall; polling faster buys nothing a human can feel.
 * @param {number} [o.maxMs]   Safety net. If the key state somehow never clears
 *        — a lost focus event, a stuck modifier — a push-to-talk session that
 *        runs forever is worse than one that ends early.
 * @returns {() => void} cancel
 */
function watchRelease(accelerator, onRelease, { pollMs = 40, maxMs = 5 * 60_000 } = {}) {
  const vk = acceleratorToVk(accelerator)
  const started = Date.now()
  if (vk == null || !canWatchRelease()) {
    // No way to observe the release. Report immediately with a zero hold so the
    // caller can fall back to tap semantics rather than waiting forever.
    onRelease(0)
    return () => {}
  }

  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearInterval(timer)
    onRelease(Date.now() - started)
  }

  const timer = setInterval(() => {
    if (!isKeyDown(vk)) return finish()
    if (Date.now() - started >= maxMs) return finish()
  }, pollMs)
  if (timer.unref) timer.unref()

  return () => { if (!done) { done = true; clearInterval(timer) } }
}

module.exports = { acceleratorToVk, isKeyDown, watchRelease, canWatchRelease, VK, MODIFIERS }
