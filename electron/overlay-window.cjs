// The floating strip that sits just above the taskbar.
//
// Three properties make it behave like an input method rather than like an app
// window, and all three are load-bearing:
//
//   focusable: false   The app you were typing in stays foreground, so the
//                      synthetic Ctrl+V in inject.cjs lands there. Also means
//                      clicking the strip's own buttons doesn't yank focus out
//                      of the document you're dictating into — on Windows this
//                      is WS_EX_NOACTIVATE, which still delivers mouse input.
//   alwaysOnTop        Pinned at 'screen-saver' level so it survives a
//     ('screen-saver')  full-screen video call, which is exactly when someone
//                      needs to see whether the mic is muted.
//   skipTaskbar        It isn't a window you alt-tab to. It's furniture.
//
// The strip is not movable. It has one right place — centred, just above the
// taskbar — and it goes back there whenever the displays change.

const { BrowserWindow, screen } = require('electron')
const path = require('path')

// The window is mostly empty on purpose. Nothing here draws a frame — the
// content is a ribbon, two glyphs and a haze that fades to nothing — so the
// window has to be larger than the visible strip in every direction, or the
// haze would be clipped into exactly the hard rectangle it exists to avoid.
const WIDTH = 520
// 30px for the line above + 46px for the capsule + SHADOW_ROOM below it, and
// almost nothing spare. The window used to be 118 with ~20px of dead air at the
// top, which pushed the whole thing further from the taskbar than it looked
// like it should be.
const HEIGHT = 104
// The window's bottom edge is NOT what you see. The capsule stops
// SHADOW_ROOM short of it — that band is transparent, and it exists so the
// capsule's drop shadow has somewhere to fade out instead of being cut off by
// the window edge into the hard line the shadow is there to avoid.
//
// So position by the thing that is actually visible: CAPSULE_GAP is the space
// between the bottom of the capsule and the top of the taskbar, and the window
// is placed wherever it has to be for that to come out right. Since
// SHADOW_ROOM > CAPSULE_GAP the window bottom ends up slightly *over* the
// taskbar; harmless, because that band is transparent and clicks pass straight
// through everything outside the capsule.
const SHADOW_ROOM = 22    // must match .root's padding-bottom in Overlay.vue
const DEFAULT_GAP = 15    // ≈ 1/3 of the 46px capsule
const MIN_GAP = 0
const MAX_GAP = 400

let win = null
// Distance from the bottom of the visible capsule to the top of the taskbar.
// Kept here rather than read from the store on every call so this module stays
// free of a settings dependency; main pushes it in.
let capsuleGap = DEFAULT_GAP

function setGap(px) {
  const n = Number(px)
  capsuleGap = Number.isFinite(n) ? Math.max(MIN_GAP, Math.min(MAX_GAP, Math.round(n))) : DEFAULT_GAP
  return capsuleGap
}
function getGap() { return capsuleGap }

/**
 * Where the window has to sit for the *capsule* to end `capsuleGap` above the
 * taskbar. The window's own bottom edge is SHADOW_ROOM lower than the capsule's
 * and is transparent, so positioning by the window would put the visible strip
 * 22px higher than asked for.
 *
 * The primary display, not the one under the cursor: the taskbar is there, and
 * "wherever the mouse happened to be at launch" made the strip appear on a
 * different monitor from one start to the next.
 */
function defaultPosition(width = WIDTH, height = HEIGHT) {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - capsuleGap - height + SHADOW_ROOM),
  }
}

/**
 * Move the strip vertically so the capsule sits `capsuleGap` above the taskbar,
 * leaving its horizontal position alone.
 *
 * Horizontal placement is the user's (they dragged it there); the vertical one
 * is what this setting is *for*, so changing the setting has to win over a
 * remembered y — otherwise the slider moves nothing for anyone who has ever
 * dragged the strip, which is everyone who would go looking for the slider.
 */
function applyGap(px) {
  setGap(px)
  const w = get()
  if (!w) return capsuleGap
  const [x] = w.getPosition()
  const [, h] = w.getSize()
  const { workArea } = screen.getDisplayMatching(w.getBounds())
  w.setPosition(x, Math.round(workArea.y + workArea.height - capsuleGap - h + SHADOW_ROOM))
  return capsuleGap
}

/**
 * Keep a remembered position usable: a strip saved on a monitor that is no
 * longer attached, or one dragged mostly off-screen, would otherwise come back
 * invisible and look like the app failed to start.
 */
function clampToDisplay(pos, width = WIDTH, height = HEIGHT) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return defaultPosition(width, height)
  const display = screen.getDisplayMatching({ x: pos.x, y: pos.y, width, height })
  const a = display.workArea
  // At least this much of the strip has to remain reachable by the cursor.
  const MIN_VISIBLE = 80
  return {
    x: Math.min(Math.max(pos.x, a.x - width + MIN_VISIBLE), a.x + a.width - MIN_VISIBLE),
    y: Math.min(Math.max(pos.y, a.y), a.y + a.height - MIN_VISIBLE),
  }
}

function create({ devServerUrl, savedPosition }) {
  // savedPosition is only still honoured so an upgrade doesn't visibly move the
  // strip out from under someone who had dragged it. Nothing writes it any more.
  const pos = clampToDisplay(savedPosition)

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    // Nothing behind the rounded card should be painted — the window is the
    // card plus transparent margin.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The mic tap and the waveform both run at frame rate. Throttling a
      // hidden-or-unfocused window (which this one always is, by design) would
      // stall the VAD and freeze the ribbon.
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Click-through by default. The window is 520×118 but the capsule inside it
  // is ~430×52 — the rest is transparent, and without this it would still eat
  // every click that lands in that empty air, which from the user's side looks
  // like a dead zone floating over their document.
  //
  // `forward: true` is what makes it workable: mouse *movement* is still
  // delivered to the renderer even while clicks pass through, so the page can
  // notice the cursor arriving over the capsule and ask for interactivity back.
  // Without forwarding there is no way to ever know the cursor came near.
  setInteractive(false)

  if (devServerUrl) win.loadURL(`${devServerUrl}/overlay.html`)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'))

  win.on('closed', () => { win = null })

  return win
}

function get() { return win && !win.isDestroyed() ? win : null }

// Tracked so repeated calls from the renderer's mousemove handler don't hit the
// OS on every frame.
let interactive = null

/** @param {boolean} on  true = the window takes clicks; false = they pass through */
function setInteractive(on) {
  const w = get()
  if (!w) return
  const next = !!on
  if (interactive === next) return
  interactive = next
  w.setIgnoreMouseEvents(!next, { forward: true })
}

function show() {
  const w = get()
  if (!w) return
  // showInactive, never show(): show() would activate the window and hand it
  // focus, which is the one thing this window must never take.
  w.showInactive()
  w.setAlwaysOnTop(true, 'screen-saver')
  // Hiding and re-showing resets the flag on some Windows builds; re-assert it
  // rather than coming back as an invisible click-blocker.
  interactive = null
  setInteractive(false)
}

function hide() { get()?.hide() }

function toggle() {
  const w = get()
  if (!w) return
  if (w.isVisible()) hide()
  else show()
}

function isVisible() { return !!get()?.isVisible() }

function resize({ width, height }) {
  const w = get()
  if (!w) return
  const [curW, curH] = w.getSize()
  const nw = Math.round(width || curW)
  const nh = Math.round(height || curH)
  if (nw === curW && nh === curH) return
  const [x, y] = w.getPosition()
  // Grow upward. The strip is anchored to the taskbar edge; growing downward
  // would push it under the taskbar the moment it needs a second line.
  w.setBounds({ x, y: y + (curH - nh), width: nw, height: nh })
}

function reposition() {
  const w = get()
  if (!w) return
  const [width, height] = w.getSize()
  const pos = defaultPosition(width, height)
  w.setPosition(pos.x, pos.y)
}

// The strip used to be draggable, via a 60Hz timer here that followed the
// cursor while the renderer held a pointer down (focusable:false means
// Chromium's own -webkit-app-region: drag cannot work). That is gone: the strip
// is furniture with one correct position — centred above the taskbar — and the
// drag was mostly a way to knock it somewhere unhelpful by accident. What
// remains is `reposition`, which puts it back there whenever the displays
// change, and `clampToDisplay`, which still guards a stale saved position from
// an older build.

module.exports = {
  create, get, show, hide, toggle, isVisible, resize, reposition,
  setGap, getGap, applyGap, DEFAULT_GAP, MIN_GAP, MAX_GAP, SHADOW_ROOM,
  defaultPosition, clampToDisplay, setInteractive,
  isInteractive: () => interactive,
  WIDTH, HEIGHT,
}
