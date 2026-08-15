// 快说 — main process.
//
// Two windows with very different jobs:
//   overlay  — the strip above the taskbar. Owns the microphone for the whole
//              session, runs the VAD, and is never focusable. This is the app,
//              as far as day-to-day use is concerned.
//   console  — history, statistics, meetings, settings. An ordinary window that
//              you open when you want to look something up, and close again.
//
// Main owns every decision that isn't "is this frame loud": the voiceprint
// gate, speaker labelling, where recognised text goes, what gets written to
// disk, and when a meeting is pushed to a webhook. The renderer sends audio
// results and receives verdicts. Keeping the policy on this side means there is
// exactly one copy of it, and it is the copy that can see the settings file.

const electron = require('electron')
const path = require('path')
const fs = require('fs')

// `require('electron')` hands back the path to the binary instead of the API
// surface when the process isn't actually an Electron main process — which is
// what happens if ELECTRON_RUN_AS_NODE is set in the environment (some editors
// and agent harnesses export it globally). Without this the first symptom is
// "Cannot read properties of undefined (reading 'requestSingleInstanceLock')",
// which points nowhere near the cause.
if (typeof electron === 'string' || !electron.app) {
  console.error(
    '[kuaishuo] 这个进程不是 Electron 主进程。\n' +
    '  最常见的原因：环境里设置了 ELECTRON_RUN_AS_NODE=1。\n' +
    '  在启动前 unset 掉它（PowerShell: Remove-Item Env:ELECTRON_RUN_AS_NODE）。',
  )
  process.exit(1)
}

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, clipboard, shell, dialog, nativeImage, desktopCapturer } = electron

const asrService = require('./asr-service.cjs')
const { createStore } = require('./store.cjs')
const { createPipeline } = require('./pipeline.cjs')
const inject = require('./inject.cjs')
const webhook = require('./webhook.cjs')
const projects = require('./projects.cjs')
const livepush = require('./livepush.cjs')
const overlay = require('./overlay-window.cjs')
const hotkeys = require('./hotkeys.cjs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const isDev = !!DEV_URL

let store = null
let pipeline = null
let outbox = null
// Serial, bounded-retry sender for the live per-sentence feed. Created once and
// kept for the life of the app: its chain is what guarantees sentences reach
// the backend in the order they were spoken.
let liveSender = null
let consoleWin = null
let tray = null

// Last state the overlay reported. Drives the tray icon and tooltip.
let engineState = { active: false, phase: 'idle', muted: false, meeting: false }

// ---- Windows ----------------------------------------------------------------

function allWindows() {
  return BrowserWindow.getAllWindows()
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => { t = null; fn(...args) }, ms)
  }
}

function broadcast(channel, payload) {
  for (const w of allWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, payload) } catch { /* ignore */ }
    }
  }
}

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show()
    consoleWin.focus()
    return consoleWin
  }
  consoleWin = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: '快说',
    // No native chrome. The app draws its own title bar so the window reads as
    // one surface instead of a dark page sitting under a light-grey Windows
    // strip that belongs to a different design language entirely.
    frame: false,
    backgroundColor: '#0f1115',
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  if (isDev) consoleWin.loadURL(`${DEV_URL}/index.html`)
  else consoleWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  consoleWin.once('ready-to-show', () => consoleWin.show())

  // The custom title bar draws its own maximize/restore glyph, so it has to be
  // told when the state changes — including changes it didn't cause, like a
  // Win+Up or a drag to the top edge.
  const sendMax = () => {
    if (consoleWin && !consoleWin.isDestroyed()) {
      try { consoleWin.webContents.send('window:maximized', consoleWin.isMaximized()) } catch {}
    }
  }
  consoleWin.on('maximize', sendMax)
  consoleWin.on('unmaximize', sendMax)
  consoleWin.on('enter-full-screen', sendMax)
  consoleWin.on('leave-full-screen', sendMax)
  // Closing the console is not quitting: the strip is still up and still
  // listening. Quitting is the tray's job, deliberately — an input method that
  // dies because you tidied a window away is an input method you stop trusting.
  consoleWin.on('closed', () => { consoleWin = null })
  return consoleWin
}

function iconPath(name) {
  const p = path.join(__dirname, 'assets', name)
  return fs.existsSync(p) ? p : undefined
}

function trayImage() {
  const name = !engineState.active ? 'tray-idle.png'
    : engineState.muted ? 'tray-muted.png'
    : 'tray-active.png'
  const p = iconPath(name)
  if (!p) return nativeImage.createEmpty()
  const img = nativeImage.createFromPath(p)
  return img.resize({ width: 16, height: 16 })
}

function refreshTray() {
  if (!tray) return
  try { tray.setImage(trayImage()) } catch {}
  const parts = ['快说']
  if (engineState.meeting) parts.push('会议记录中')
  else if (engineState.muted) parts.push('已暂停')
  else if (engineState.active) parts.push('监听中')
  else parts.push('未启动')
  tray.setToolTip(parts.join(' · '))
  tray.setContextMenu(trayMenu())
}

function trayMenu() {
  const s = store.getSettings()
  return Menu.buildFromTemplate([
    {
      label: engineState.active ? '停止听写' : '开始听写',
      click: () => command('toggle'),
    },
    {
      label: engineState.muted ? '恢复（取消暂停）' : '暂停（临时静音）',
      enabled: engineState.active,
      click: () => command('mute'),
    },
    { type: 'separator' },
    {
      // Opens the console rather than starting a meeting: a recording has to be
      // filed under a project first, and that choice needs a real window.
      label: pipeline?.currentMeetingId() ? '会议记录中 · 打开控制台' : '开始会议（在控制台）',
      click: () => openMeetings(),
    },
    { type: 'separator' },
    {
      label: '输出方式',
      submenu: ['type', 'clipboard', 'none'].map((mode) => ({
        label: { type: '直接输入到光标处', clipboard: '仅复制到剪贴板', none: '只记录不输出' }[mode],
        type: 'radio',
        checked: s.outputMode === mode,
        click: () => applySettings({ outputMode: mode }),
      })),
    },
    {
      label: overlay.isVisible() ? '隐藏悬浮条' : '显示悬浮条',
      click: () => { overlay.toggle(); refreshTray() },
    },
    { label: '悬浮条回到默认位置', click: () => { overlay.reposition(); overlay.show() } },
    { type: 'separator' },
    { label: '打开控制台…', click: () => createConsole() },
    { type: 'separator' },
    { label: '退出快说', click: () => { app.isQuitting = true; app.quit() } },
  ])
}

/**
 * Bring up the console on the meetings page.
 *
 * This is now the only way a meeting starts. It used to be startable from the
 * strip, the tray and a hotkey, all of which called straight into
 * `startMeeting` — but a recording has to be filed under a project before the
 * first sentence, and picking one needs a list, a search box and a window that
 * can take focus. The strip is `focusable: false` by design, so the choice was
 * between a picker that cannot be typed into and moving the entry point. The
 * three old entries all land here instead, so the muscle memory still works.
 */
// Bringing Chromium's screen capturer up costs the MAIN process ~390ms of hard
// block the first time — measured with probe:perf, and confirmed not to be the
// thumbnail (size 0 changes nothing; the second call costs 12ms). The main
// process is the thread every window's IPC runs through, so that is a visible
// freeze of the whole app.
//
// It cannot be avoided: loopback audio requires a video source, and requesting
// audio alone doesn't fail, it hangs forever. So it is paid deliberately, once,
// at a moment already full of motion — opening the meetings page — instead of
// landing on the click that starts a recording.
//
// Only when it will actually be used: a machine with system audio switched off,
// or not on Windows, should never start a screen capturer at all.
let capturerWarmed = false
function warmCapturer() {
  if (capturerWarmed || process.platform !== 'win32') return
  if (!store?.getSettings().systemAudioInMeetings) return
  capturerWarmed = true
  // Deferred so the block lands after the window this was called from has
  // painted, rather than delaying it.
  setTimeout(() => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .catch(() => { capturerWarmed = false })
  }, 400)
}

function openMeetings() {
  const w = createConsole()
  const send = () => { try { w.webContents.send('app:navigate', { tab: 'meetings' }) } catch {} }
  // A console that is being created for the first time has not loaded yet, and
  // a message sent into a blank renderer goes nowhere.
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
  w.show()
  w.focus()
  // The meetings page is where a recording starts, so this is the last quiet
  // moment before the capturer is needed.
  warmCapturer()
  return w
}

/**
 * Ask the strip to open the system-audio (loopback) tap.
 *
 * This exists as a one-line executeJavaScript rather than an IPC message for a
 * single reason: Chromium only grants `getDisplayMedia` inside the transient
 * activation window a real user gesture opens, and **IPC does not carry
 * activation**. `executeJavaScript(code, true)` does — the second argument is
 * literally "pretend this came from a gesture".
 *
 * It matters here because the click that starts a meeting now happens in the
 * console, while the capture happens in the strip's renderer. Without this the
 * far end of every meeting would go uncaptured on Windows, with no error
 * anywhere — the loopback request would just be refused.
 */
function armSystemAudio() {
  const w = overlay.get()
  if (!w) return
  w.webContents
    .executeJavaScript('window.__kuaishuoArmSystemAudio && window.__kuaishuoArmSystemAudio()', true)
    .catch(() => { /* the strip may not have finished loading; the meetingActive watcher still covers it */ })
}

/** Send a command to the engine (the overlay renderer owns the mic). */
function command(cmd, payload) {
  const w = overlay.get()
  if (!w) return
  // Anything that starts listening also brings the strip back: a mic that is
  // live with nothing on screen to say so is the state this app must never be
  // in, whether it was started from a hotkey, the tray, or a meeting.
  if (cmd === 'toggle' || cmd === 'start' || cmd === 'start-for-meeting') overlay.show()
  try { w.webContents.send('engine:command', { cmd, ...(payload || {}) }) } catch {}
}

// ---- Settings ---------------------------------------------------------------

function applySettings(patch) {
  const before = store.getSettings()
  const after = store.setSettings(patch)
  broadcast('settings:changed', after)
  const hotkeyChanged = ['hotkeyPushToTalk', 'hotkeyToggle', 'hotkeyMeeting', 'hotkeyMute', 'hotkeyPanel']
    .some((k) => before[k] !== after[k])
  if (hotkeyChanged) registerHotkeys()
  // The slider is only useful if the strip moves while you drag it.
  if (before.overlayBottomGap !== after.overlayBottomGap) {
    overlay.applyGap(after.overlayBottomGap)
  }
  if (before.launchAtLogin !== after.launchAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: after.launchAtLogin, args: ['--hidden'] }) } catch {}
  }
  refreshTray()
  return after
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const s = store.getSettings()
  // A shortcut that fails to register is a feature that is simply absent, with
  // nothing on screen to say so — which is how "continuous dictation doesn't
  // work" went unnoticed. Duplicates inside our own settings can no longer get
  // here (the store de-duplicates), so anything reaching this is another
  // application holding the combination. Collect them and tell the user.
  const failed = []
  const bind = (accel, label, fn) => {
    if (!accel) return
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(`${label}（${accel}）`)
    } catch (err) {
      failed.push(`${label}（${accel}：${err.message}）`)
    }
  }
  bind(s.hotkeyPushToTalk, '临时录音', () => startPushToTalk(s.hotkeyPushToTalk))
  bind(s.hotkeyToggle, '一直录音', () => command('toggle'))
  bind(s.hotkeyMeeting, '打开会议页', () => openMeetings())
  bind(s.hotkeyMute, '暂停 / 恢复', () => command('mute'))
  bind(s.hotkeyPanel, '打开控制台', () => createConsole())

  if (failed.length) {
    console.warn('[hotkey] 被其它程序占用，未能注册：', failed.join('、'))
  }
  // The console shows these on the settings page; broadcast rather than let it
  // poll, since re-registration happens whenever a hotkey setting changes.
  broadcast('hotkeys:failed', failed)
  return failed
}

// ---- Push to talk -----------------------------------------------------------
// Hold the key, say the thing, let go. globalShortcut only reports the press,
// so the release is observed by polling the key's state (see hotkeys.cjs).
//
// A quick tap is not a zero-length recording — that would be a trap, since the
// natural way to try a new hotkey is to tap it. Under HOLD_MIN_MS the press is
// read as "dictate one sentence, then stop by yourself", which is the same
// intention expressed impatiently.
const HOLD_MIN_MS = 350

let pttCancel = null
// Set when a tap is waiting for its one utterance. Cleared as soon as one
// commits — see the dictation:commit handler.
let stopAfterUtterance = false

function startPushToTalk(accel) {
  if (pttCancel) return          // already held; the OS repeats key-down events
  stopAfterUtterance = false
  command('start')

  pttCancel = hotkeys.watchRelease(accel, (heldMs) => {
    pttCancel = null
    if (heldMs >= HOLD_MIN_MS) {
      // A real hold. Stop now — whatever is mid-sentence is flushed by the
      // engine on the way out, so the last word is not lost.
      command('stop')
    } else {
      // A tap. Keep listening until one sentence has actually landed.
      stopAfterUtterance = true
      // …but not forever, if the user taps and then says nothing at all.
      setTimeout(() => {
        if (!stopAfterUtterance) return
        stopAfterUtterance = false
        command('stop')
      }, 12_000).unref?.()
    }
  })
}

// ---- Meetings ---------------------------------------------------------------
// The commit path itself lives in pipeline.cjs (no Electron, so it can be
// tested end to end); everything here is the shell around it — tray state,
// telling the engine to start, and the webhook push on the way out.

function startMeeting(opts = {}) {
  const existing = pipeline.currentMeeting()
  if (existing) return existing
  const doc = pipeline.startMeeting(opts)
  engineState.meeting = true
  refreshTray()
  armSystemAudio()
  // A meeting that never starts listening records silence, so make sure the
  // engine is up — pressing "会议模式" means "capture this", not "capture this
  // once I also remember to press the mic".
  command('start-for-meeting')
  return doc
}

async function stopMeeting() {
  const doc = pipeline.stopMeeting()
  if (!doc) return null
  engineState.meeting = false
  refreshTray()

  const s = store.getSettings()
  if (s.webhookEnabled && s.webhookUrl && s.webhookAutoOnEnd) {
    pushMeeting(doc.id).catch((err) => console.warn('[webhook] push failed', err))
  }
  // Let the live feed drain before summarising, so the two views a backend has
  // of the same meeting can't disagree: the completed record must not arrive
  // claiming segments the receiver has not been sent yet.
  if (s.projectPushEnabled && s.projectPushUrl && s.projectPushOnEnd) {
    liveSender.flush()
      .then(() => pushMeetingToProject(doc.id))
      .catch((err) => console.warn('[project] push failed', err))
  }
  liveSender.forget(doc.id)
  return doc
}

/**
 * The end-of-meeting record for the project endpoint. Same payload as the
 * legacy webhook plus a project block, so a backend can share the parser.
 */
async function pushMeetingToProject(id) {
  const s = store.getSettings()
  const doc = store.getMeeting(id)
  if (!doc) return { ok: false, error: 'meeting not found' }
  if (!s.projectPushUrl) return { ok: false, error: '推送接口未配置' }

  const payload = livepush.withProject(
    webhook.buildPayload(doc, { includeSegments: true, appVersion: app.getVersion() }),
    doc,
  )
  const res = await webhook.deliver(payload, {
    url: s.projectPushUrl, secret: s.projectPushSecret, headers: s.projectPushHeaders, appVersion: app.getVersion(),
  })

  doc.projectDelivery = res
  store.saveMeeting(doc)

  if (!res.ok && !res.permanent) {
    outbox.enqueue({
      deliveryId: res.deliveryId, meetingId: id, kind: 'project', url: s.projectPushUrl,
      secret: s.projectPushSecret, headers: s.projectPushHeaders, payload,
    })
  }
  broadcast('meeting:changed', { id, projectDelivery: res })
  return res
}

/**
 * One recognised sentence, out to the project endpoint as it happens.
 *
 * Called from the pipeline's onMeeting hook. Deliberately not awaited anywhere:
 * the transcript is already on disk by this point, and the network must never
 * be in front of the next sentence.
 */
function pushSegmentLive(meetingId, seg) {
  const s = store.getSettings()
  if (!s.projectPushEnabled || !s.projectPushUrl || !s.projectPushSegments) return
  const doc = store.getMeeting(meetingId)
  if (!doc) return
  liveSender.push(doc, seg, {
    url: s.projectPushUrl, secret: s.projectPushSecret, headers: s.projectPushHeaders,
  })
}

/** Deliver one meeting now; queue it for retry if the endpoint is unreachable. */
async function pushMeeting(id) {
  const s = store.getSettings()
  const doc = store.getMeeting(id)
  if (!doc) return { ok: false, error: 'meeting not found' }
  if (!s.webhookUrl) return { ok: false, error: 'webhook 未配置' }

  const payload = webhook.buildPayload(doc, {
    includeSegments: s.webhookIncludeSegments,
    appVersion: app.getVersion(),
  })
  const res = await webhook.deliver(payload, {
    url: s.webhookUrl, secret: s.webhookSecret, headers: s.webhookHeaders, appVersion: app.getVersion(),
  })

  doc.delivery = res
  store.saveMeeting(doc)

  if (!res.ok && !res.permanent) {
    outbox.enqueue({
      deliveryId: res.deliveryId, meetingId: id, url: s.webhookUrl,
      secret: s.webhookSecret, headers: s.webhookHeaders, payload,
    })
  }
  broadcast('meeting:changed', { id, delivery: res })
  return res
}

// ---- IPC --------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => applySettings(patch || {}))
  ipcMain.handle('settings:reset', () => {
    const s = store.resetSettings()
    broadcast('settings:changed', s)
    registerHotkeys()
    refreshTray()
    return s
  })

  ipcMain.handle('dictation:commit', async (_e, payload) => {
    const verdict = await pipeline.commit(payload || {})
    // A tapped push-to-talk waits for exactly one sentence and then gets out of
    // the way. Rejected audio (voiceprint, silence) does not count — otherwise
    // a cough would end the session the user just started.
    if (stopAfterUtterance && verdict?.accepted) {
      stopAfterUtterance = false
      command('stop')
    }
    return verdict
  })
  ipcMain.on('dictation:state', (_e, state) => {
    engineState = { ...engineState, ...(state || {}) }
    const meetingId = pipeline.currentMeetingId()
    broadcast('app:state', { ...engineState, meeting: !!meetingId, meetingId })
    refreshTray()
  })

  ipcMain.handle('history:list', (_e, opts) => store.listHistory(opts))
  ipcMain.handle('history:delete', (_e, id) => store.deleteHistory(id))
  ipcMain.handle('history:clear', () => store.clearHistory())
  ipcMain.handle('history:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true })
  ipcMain.handle('history:resend', async (_e, text) => {
    const s = store.getSettings()
    return inject.sendText(String(text || ''), {
      mode: s.outputMode === 'none' ? 'clipboard' : s.outputMode,
      enter: false, restoreClipboard: s.restoreClipboard, appendSpace: false,
    })
  })

  ipcMain.handle('stats:get', (_e, opts) => store.stats(opts))

  ipcMain.handle('meeting:start', (_e, opts) => startMeeting(opts || {}))
  ipcMain.handle('meeting:stop', () => stopMeeting())
  ipcMain.handle('meeting:current', () => pipeline.currentMeeting())
  ipcMain.handle('meeting:get', (_e, id) => store.getMeeting(id))
  ipcMain.handle('meeting:list', (_e, opts) => store.listMeetings(opts))
  ipcMain.handle('meeting:delete', (_e, id) => {
    // Deleting the transcript that is currently being written to would leave
    // the pipeline appending segments to a file that no longer exists.
    if (pipeline.currentMeetingId() === id) return false
    return store.deleteMeeting(id)
  })
  ipcMain.handle('meeting:update', (_e, { id, patch }) => {
    const doc = store.getMeeting(id)
    if (!doc) return null
    // Only fields a person edits. Segments and timestamps are the record.
    if (typeof patch?.title === 'string') doc.title = patch.title
    if (typeof patch?.notes === 'string') doc.notes = patch.notes
    // Re-filing a meeting after the fact: the picker was cancelled, or the
    // wrong one was chosen. Only affects where the end-of-meeting record goes —
    // sentences already pushed carry whatever was true when they were spoken.
    if (typeof patch?.projectId === 'string') doc.projectId = patch.projectId
    if (typeof patch?.projectName === 'string') doc.projectName = patch.projectName
    if (typeof patch?.projectMeetingId === 'string') doc.projectMeetingId = patch.projectMeetingId
    if (Array.isArray(patch?.speakers)) {
      // Renaming 说话人1 → 张三 rewrites the label everywhere it appears, so the
      // transcript and the payload agree.
      const map = new Map()
      for (const sp of patch.speakers) {
        const old = doc.speakers.find((x) => x.id === sp.id)
        if (old && sp.label && old.label !== sp.label) map.set(old.label, sp.label)
        if (old) old.label = sp.label
      }
      if (map.size) for (const seg of doc.segments) if (map.has(seg.speaker)) seg.speaker = map.get(seg.speaker)
    }
    store.saveMeeting(doc)
    broadcast('meeting:changed', { id })
    return doc
  })
  ipcMain.handle('meeting:push', (_e, id) => pushMeeting(id))
  ipcMain.handle('meeting:preview-payload', (_e, id) => {
    const doc = store.getMeeting(id)
    if (!doc) return null
    const s = store.getSettings()
    return webhook.buildPayload(doc, { includeSegments: s.webhookIncludeSegments, appVersion: app.getVersion() })
  })
  ipcMain.handle('meeting:export', async (_e, { id, format = 'md' }) => {
    const doc = store.getMeeting(id)
    if (!doc) return { ok: false, error: 'not found' }
    const content = format === 'json'
      ? JSON.stringify(webhook.buildPayload(doc, { appVersion: app.getVersion() }), null, 2)
      : format === 'txt'
        ? webhook.transcriptText(doc.segments)
        : webhook.transcriptMarkdown(doc, doc.segments)
    const safe = doc.title.replace(/[\\/:*?"<>|]/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safe}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    fs.writeFileSync(filePath, content, 'utf8')
    return { ok: true, path: filePath }
  })

  ipcMain.handle('webhook:test', async (_e, config) => {
    const s = store.getSettings()
    const url = config?.url || s.webhookUrl
    if (!url) return { ok: false, error: 'webhook 未配置' }
    // A real payload with one segment, flagged as a test, so the endpoint's
    // parser is exercised rather than a ping it would have accepted anyway.
    const now = Date.now()
    const doc = {
      id: 'mt_test', title: '快说 · 连通性测试', startedAt: now - 6000, endedAt: now, notes: '',
      speakers: [{ id: 'S1', label: '我', segments: 1, isOwner: true }],
      segments: [{ i: 0, at: now - 6000, offsetMs: 0, durationMs: 2400, speaker: '我', text: '这是一条来自快说的测试消息。' }],
    }
    const payload = { ...webhook.buildPayload(doc, { appVersion: app.getVersion() }), event: 'meeting.test' }
    return webhook.deliver(payload, {
      url,
      secret: config?.secret ?? s.webhookSecret,
      headers: config?.headers ?? s.webhookHeaders,
      appVersion: app.getVersion(),
    })
  })
  ipcMain.handle('webhook:outbox', () => outbox.list().map(({ payload, secret, ...rest }) => ({
    ...rest, title: payload?.title, segments: payload?.stats?.segments,
  })))
  ipcMain.handle('webhook:flush', () => outbox.flush({ force: true }))

  // ---- Project binding ------------------------------------------------------

  /** Merge a partial config from the settings "test" button over what's saved. */
  function projectsConfig(over = {}) {
    const s = store.getSettings()
    return {
      url: over.url ?? s.projectsUrl,
      headers: over.headers ?? s.projectsHeaders,
      itemsPath: over.itemsPath ?? s.projectsItemsPath,
      idField: over.idField ?? s.projectsIdField,
      nameField: over.nameField ?? s.projectsNameField,
      projectIdField: over.projectIdField ?? s.projectsProjectIdField,
      groupField: over.groupField ?? s.projectsGroupField,
    }
  }

  // The picker calls this every time it opens rather than caching: the list is
  // small, and a stale list is how you file a recording under last week's
  // meeting. `fetchProjects` never throws, so the picker always gets an answer.
  ipcMain.handle('projects:list', async (_e, over) => {
    // The picker is open and the user is about to choose; whatever this costs
    // is hidden behind the fetch and behind them reading the list.
    warmCapturer()
    const s = store.getSettings()
    if (!s.projectsEnabled || !s.projectsUrl) {
      return { ok: false, configured: false, items: [], skipped: 0, error: '', reason: '' }
    }
    const res = await projects.fetchProjects(projectsConfig(over || {}))
    return { ...res, configured: true }
  })

  // withShape: the test button doubles as discovery, so the settings page can
  // offer the paths found in the real response instead of asking for them.
  ipcMain.handle('projects:test', async (_e, over) =>
    projects.fetchProjects({ ...projectsConfig(over || {}), withShape: true }))

  ipcMain.handle('projects:push-test', async (_e, config) => {
    const s = store.getSettings()
    const url = config?.url || s.projectPushUrl
    if (!url) return { ok: false, error: '推送接口未配置' }
    // A real segment event, not a ping: this is the payload the endpoint will
    // actually receive hundreds of times, so it is the one worth exercising.
    const now = Date.now()
    const doc = {
      id: 'mt_test', title: '快说 · 连通性测试', startedAt: now - 6000,
      projectId: config?.projectId || 'test-project', projectName: '测试项目',
    }
    const seg = { i: 0, at: now, offsetMs: 0, durationMs: 2400, speaker: '我', text: '这是一条来自快说的实时推送测试。' }
    return webhook.deliver(livepush.buildSegmentPayload(doc, seg, { appVersion: app.getVersion() }), {
      url,
      secret: config?.secret ?? s.projectPushSecret,
      headers: config?.headers ?? s.projectPushHeaders,
      appVersion: app.getVersion(),
    })
  })

  ipcMain.handle('meeting:push-project', (_e, id) => pushMeetingToProject(id))

  ipcMain.handle('overlay:show', () => { overlay.show(); refreshTray(); return true })
  ipcMain.handle('overlay:hide', () => { overlay.hide(); refreshTray(); return true })
  ipcMain.handle('overlay:resize', (_e, size) => { overlay.resize(size || {}); return true })
  ipcMain.handle('overlay:reposition', () => { overlay.reposition(); return true })
  // Sent on every mousemove-driven change from the renderer, so it is a `send`
  // rather than an `invoke`: the answer is never awaited and a round trip per
  // pointer movement would be silly.
  ipcMain.on('overlay:interactive', (_e, on) => overlay.setInteractive(!!on))

  // ---- Custom title bar ----------------------------------------------------
  // `frame: false` means these have no OS affordance behind them; the console's
  // own header is the only way to move, maximize or close the window.
  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.on('window:minimize', (e) => senderWindow(e)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const w = senderWindow(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('window:close', (e) => senderWindow(e)?.close())
  ipcMain.handle('window:is-maximized', (e) => !!senderWindow(e)?.isMaximized())
  ipcMain.handle('app:open-console', () => { createConsole(); return true })
  ipcMain.handle('app:open-meetings', () => { openMeetings(); return true })
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); return true })
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    dataDir: store.dir,
    injector: process.platform === 'win32' ? 'user32/keybd_event' : process.platform === 'darwin' ? 'osascript' : 'xdotool',
  }))
  ipcMain.handle('app:open-path', (_e, which) => {
    const target = which === 'data' ? store.dir : app.getPath('userData')
    shell.openPath(target)
    return true
  })
}

// ---- Boot -------------------------------------------------------------------

// Escape hatch for a portable install and for the UI harness: point every bit
// of state somewhere else. Has to happen before anything reads a path, so it
// sits above whenReady rather than inside it.
if (process.env.KUAISHUO_USER_DATA) {
  app.setPath('userData', process.env.KUAISHUO_USER_DATA)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Launching it again means "show me the thing", not "start a second copy".
    overlay.show()
    createConsole()
  })

  app.whenReady().then(async () => {
    const dataDir = path.join(app.getPath('userData'), 'data')
    store = createStore({ dir: dataDir })
    // Before anything reads the meeting list. A meeting is only "recording"
    // while this process holds it in memory, so anything disk still calls
    // recording was interrupted by a crash, a force-quit or a dev restart —
    // and left behind a red dot and an 结束 button that could not work.
    const reopened = store.closeAbandonedMeetings()
    if (reopened.length) console.warn(`[meeting] 关闭了 ${reopened.length} 场未正常结束的会议`)
    process.env.KUAISHUO_VERSION = app.getVersion()

    liveSender = livepush.createLiveSender({
      appVersion: app.getVersion(),
      onResult: (meetingId, res, stats) => {
        // Counted on the doc so a silently failing live feed is visible in the
        // console rather than discovered by the backend's absence of data.
        const doc = store.getMeeting(meetingId)
        if (doc) { doc.livePush = stats; store.saveMeeting(doc) }
        broadcast('meeting:changed', { id: meetingId, livePush: stats, liveError: res.ok ? '' : res.error })
      },
    })

    pipeline = createPipeline({
      store,
      sendText: inject.sendText,
      onHistory: (entry) => broadcast('history:added', entry),
      onMeeting: (event) => {
        // The only injection point the live feed needs: this already carries
        // the stored segment, so nothing in pipeline.cjs has to know that an
        // HTTP endpoint exists.
        if (event?.segment && event.id) pushSegmentLive(event.id, event.segment)
        broadcast('meeting:changed', event)
      },
    })

    outbox = webhook.createOutbox({
      dir: dataDir,
      appVersion: app.getVersion(),
      onResult: (meetingId, res, kind) => {
        const doc = meetingId ? store.getMeeting(meetingId) : null
        const field = kind === 'project' ? 'projectDelivery' : 'delivery'
        if (doc) { doc[field] = res; store.saveMeeting(doc) }
        broadcast('meeting:changed', { id: meetingId, [field]: res })
      },
    })
    outbox.start()
    // Anything owed from a previous run goes out as soon as there's a network.
    outbox.flush().catch(() => {})

    // getUserMedia is a permission request even for our own file:// renderer.
    // Approve media for our windows only — nothing else is ever loaded here,
    // and a blanket `true` would also hand it to anything that ever is.
    const { session } = require('electron')
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const ours = allWindows().some((w) => !w.isDestroyed() && w.webContents === wc)
      // 'display-capture' is the gate in front of getDisplayMedia, which is how
      // meeting mode reaches the loopback device. It is checked before the
      // handler below ever runs, so leaving it out denies system audio with no
      // error that points at this line.
      callback(ours && (permission === 'media' || permission === 'clipboard-read' || permission === 'display-capture'))
    })

    // System audio for meetings. Electron routes getDisplayMedia through this
    // handler instead of a picker, which is the entire reason the feature can
    // exist quietly: the user is never asked to choose a screen, because we do
    // not want one. Video is requested only because Chromium will not open a
    // display-capture session without it, and the renderer drops that track
    // immediately (see openSystemAudioTap in src/core/voiceVad.js).
    //
    // `audio: 'loopback'` is Windows-only. Everywhere else this denies, and the
    // renderer treats the rejection as "no system audio", not as a failure.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const ours = allWindows().some((w) => !w.isDestroyed() && w.webContents.mainFrame === request.frame)
      if (!ours || process.platform !== 'win32') { callback({}) ; return }
      // thumbnailSize 0 skips scaling a bitmap we never look at. It does NOT
      // avoid the expensive part — see warmCapturer.
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          // An empty callback is how this API says no. Denying is always safe;
          // the caller has a soft-failure path.
          if (!sources.length) { callback({}); return }
          // Which screen is irrelevant — loopback captures the render device,
          // not the picture. sources[0] is here because Chromium will not open
          // a display-capture session without a video source at all.
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch(() => callback({}))
    }, {
      // Must stay false. The native picker is macOS-only and experimental, so
      // on Windows it can only ever be a no-op — and when it IS available this
      // handler is not invoked at all, which would silently drop the
      // `audio: 'loopback'` that is the entire point. It also presents an OS
      // modal, and this app's defining property is that it never takes focus.
      useSystemPicker: false,
    })

    asrService.init({
      ipcMain,
      getWindows: () => allWindows(),
      userDataDir: app.getPath('userData'),
    })

    registerIpc()

    const s = store.getSettings()
    // savedPosition is read but no longer written: the strip is fixed now, and
    // this only keeps it where an older build left it instead of teleporting it
    // on first launch after the upgrade.
    overlay.create({ devServerUrl: DEV_URL, savedPosition: s.overlayPosition })
    overlay.show()

    tray = new Tray(trayImage())
    tray.on('click', () => command('toggle'))
    tray.on('double-click', () => createConsole())
    refreshTray()

    registerHotkeys()

    // Start pulling the recogniser down a few seconds in — late enough not to
    // compete with window creation, early enough that it is usually finished
    // before anyone presses the mic.
    //
    // KUAISHUO_NO_PREFETCH is for the harnesses: they run in throwaway profiles,
    // so a background 228MB fetch would both waste the bandwidth and change the
    // UI out from under them mid-assertion (the model progress takes the same
    // slot as the output-mode label).
    if (store.getSettings().autoDownloadModel && !process.env.KUAISHUO_NO_PREFETCH) {
      setTimeout(() => { asrService.prefetch() }, 4000)
    }

    // A display change can leave the strip stranded on a monitor that no longer
    // exists, or floating over the middle of the screen because the taskbar
    // moved. Re-anchor it.
    screen.on('display-metrics-changed', () => overlay.reposition())
    screen.on('display-removed', () => overlay.reposition())

    // --hidden is what the login item passes: start listening, don't pop a
    // console in the user's face while they're logging in.
    if (!process.argv.includes('--hidden')) createConsole()

    // Harnesses drive these same windows through executeJavaScript — real DOM,
    // real IPC, real store, real microphone — and then quit with a status.
    // Loaded lazily so they aren't in the shipped bundle's require graph.
    if (process.env.KUAISHUO_E2E) {
      const which = process.env.KUAISHUO_E2E === '1' ? 'ui' : process.env.KUAISHUO_E2E
      const harness = require(path.join(__dirname, '..', 'scripts', `${which}-harness.cjs`))
      harness.run({ overlay, getConsole: () => consoleWin, store, pipeline, createConsole })
        .then((code) => { app.isQuitting = true; app.exit(code) })
        .catch((err) => { console.error(err); app.isQuitting = true; app.exit(1) })
    }
  })

  app.on('window-all-closed', () => {
    // Deliberately does nothing. The strip and the tray are the app; the
    // console closing is not a reason to exit.
  })

  app.on('before-quit', () => { app.isQuitting = true })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    try { outbox?.stop() } catch {}
    try { asrService.dispose() } catch {}
    try { store?.close() } catch {}
  })
}
