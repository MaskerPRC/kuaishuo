// The single bridge both renderers get. contextIsolation stays on and nothing
// from Node leaks through — every capability below is an explicit, named IPC
// call, so the surface a compromised renderer could reach is exactly this list.

const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const handler = (_e, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('kuaishuo', {
  platform: process.platform,
  version: process.env.KUAISHUO_VERSION || '0.0.0',

  settings: {
    get:   () => ipcRenderer.invoke('settings:get'),
    set:   (patch) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    // Fired on every window whenever anything changes settings, so the overlay
    // picks up a sensitivity tweak made in the console without a restart.
    onChange: (cb) => on('settings:changed', cb),
  },

  asr: {
    status:             () => ipcRenderer.invoke('asr:status'),
    ensureModel:        (opts) => ipcRenderer.invoke('asr:ensure-model', opts || {}),
    ensureSpeakerModel: () => ipcRenderer.invoke('asr:ensure-speaker-model'),
    clearModel:         () => ipcRenderer.invoke('asr:clear-model'),
    transcribe:         (payload) => ipcRenderer.invoke('asr:transcribe', payload || {}),
    onProgress:         (cb) => on('asr:progress', cb),
  },

  // One recognised utterance, handed to main to be gated, labelled, stored and
  // injected. The renderer deliberately does not decide any of that — settings
  // live in main and this keeps one copy of the policy.
  dictation: {
    commit: (payload) => ipcRenderer.invoke('dictation:commit', payload),
    // Utterances that were captured but never became text (voiceprint reject,
    // too short, empty decode) — counted so the stats page can explain a quiet
    // session instead of pretending it didn't happen.
    reportState: (state) => ipcRenderer.send('dictation:state', state),
    onCommand: (cb) => on('engine:command', cb),
  },

  history: {
    list:   (opts) => ipcRenderer.invoke('history:list', opts || {}),
    remove: (id) => ipcRenderer.invoke('history:delete', id),
    clear:  () => ipcRenderer.invoke('history:clear'),
    copy:   (text) => ipcRenderer.invoke('history:copy', text),
    resend: (text) => ipcRenderer.invoke('history:resend', text),
    onAdd:  (cb) => on('history:added', cb),
  },

  stats: {
    get: (opts) => ipcRenderer.invoke('stats:get', opts || {}),
  },

  meeting: {
    start:   (opts) => ipcRenderer.invoke('meeting:start', opts || {}),
    stop:    () => ipcRenderer.invoke('meeting:stop'),
    current: () => ipcRenderer.invoke('meeting:current'),
    get:     (id) => ipcRenderer.invoke('meeting:get', id),
    list:    (opts) => ipcRenderer.invoke('meeting:list', opts || {}),
    remove:  (id) => ipcRenderer.invoke('meeting:delete', id),
    update:  (id, patch) => ipcRenderer.invoke('meeting:update', { id, patch }),
    push:    (id) => ipcRenderer.invoke('meeting:push', id),
    export:  (id, format) => ipcRenderer.invoke('meeting:export', { id, format }),
    preview: (id) => ipcRenderer.invoke('meeting:preview-payload', id),
    pushProject: (id) => ipcRenderer.invoke('meeting:push-project', id),
    onChange: (cb) => on('meeting:changed', cb),
  },

  // Where a recording gets filed. `list` is what the picker calls before a
  // meeting starts; it answers `{configured:false}` rather than failing when no
  // endpoint is set, because that is a supported way to run the app.
  projects: {
    list:     (over) => ipcRenderer.invoke('projects:list', over || {}),
    test:     (over) => ipcRenderer.invoke('projects:test', over || {}),
    pushTest: (config) => ipcRenderer.invoke('projects:push-test', config || {}),
  },

  webhook: {
    test:    (config) => ipcRenderer.invoke('webhook:test', config),
    outbox:  () => ipcRenderer.invoke('webhook:outbox'),
    flush:   () => ipcRenderer.invoke('webhook:flush'),
  },

  overlay: {
    show:      () => ipcRenderer.invoke('overlay:show'),
    hide:      () => ipcRenderer.invoke('overlay:hide'),
    resize:    (size) => ipcRenderer.invoke('overlay:resize', size),
    reposition: () => ipcRenderer.invoke('overlay:reposition'),
    // Whether the strip should take clicks or let them fall through to whatever
    // is behind it. Driven by the renderer's own hit-testing on mousemove.
    setInteractive: (on) => ipcRenderer.send('overlay:interactive', !!on),
  },

  // The console draws its own title bar; these are the parts of a window frame
  // that have no HTML equivalent.
  win: {
    minimize:       () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close:          () => ipcRenderer.send('window:close'),
    isMaximized:    () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized:    (cb) => on('window:maximized', cb),
  },

  app: {
    openConsole: () => ipcRenderer.invoke('app:open-console'),
    // The tray item, the meeting hotkey and the strip's meeting glyph all land
    // here: a recording has to be filed under a project before its first
    // sentence, and choosing one needs a window that can take focus.
    openMeetings: () => ipcRenderer.invoke('app:open-meetings'),
    onNavigate:  (cb) => on('app:navigate', cb),
    // Shortcuts another application already holds. Registration failure is
    // otherwise invisible — the key simply does nothing.
    onHotkeysFailed: (cb) => on('hotkeys:failed', cb),
    quit:        () => ipcRenderer.invoke('app:quit'),
    info:        () => ipcRenderer.invoke('app:info'),
    openPath:    (which) => ipcRenderer.invoke('app:open-path', which),
    onState:     (cb) => on('app:state', cb),
  },
})
