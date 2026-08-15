// On-disk state: settings, dictation history, meetings, stats.
//
// Written as a plain factory over a directory rather than a module that reads
// app.getPath('userData') itself, so the tests can point it at a temp dir and
// exercise the real code instead of a mock of it.
//
// History is an append-only JSONL file, and that is the whole durability story:
// the user's words are appended the instant they are recognised, with an fd
// that stays open, so nothing recognised can be lost to a crash, a force-quit,
// or the machine sleeping mid-sentence. A JSON array rewritten on every entry
// would have been simpler to read and would lose the file to a half-written
// bracket exactly once — which is once more than acceptable for something whose
// entire job is "don't lose what I said".

const fs = require('fs')
const path = require('path')

// ---- Settings ---------------------------------------------------------------

const DEFAULTS = {
  // --- capture -------------------------------------------------------------
  micDeviceId: '',            // '' = system default
  asrSilenceMs: 900,          // silence that ends a sentence
  asrSensitivity: 'medium',   // high | medium | low, see core/voiceVad.js
  asrLanguage: 'zh',          // zh | en | ja | ko | yue | auto

  // Capture what the machine is playing, not only what the microphone hears.
  // On by default, and used ONLY while a meeting is recording.
  //
  // Why it matters: the mic is opened with echoCancellation on, and AEC's
  // entire job is to subtract the speakers from the microphone signal — so the
  // remote half of a call is precisely the part being removed. Meetings have
  // been transcribing one side of the conversation and calling it a
  // transcript. A loopback tap gets that audio at render quality instead of
  // via the room.
  //
  // Why NOT in plain dictation: the voiceprint gate exists because televisions
  // and videos should not put words into your document. Feeding the video
  // straight in would be the same mistake from the other end.
  //
  // Windows only — Electron's loopback capture has no macOS/Linux equivalent.
  // Elsewhere this is inert rather than broken.
  systemAudioInMeetings: true,

  // --- output --------------------------------------------------------------
  // 'type'      → clipboard + a real Ctrl+V into whatever app has focus
  // 'clipboard' → clipboard only, the user pastes when they're ready
  // 'none'      → recognised, logged, and left in the history list
  outputMode: 'type',
  // Put the clipboard back the way we found it a moment after pasting. On by
  // default: an input method that silently eats whatever you had copied is a
  // bad neighbour.
  restoreClipboard: true,
  // Some chat apps want the message sent, not just filled in.
  pressEnterAfterType: false,
  // Trailing space between dictated sentences so consecutive utterances don't
  // run together as onewordlikethis.
  appendSpace: false,

  // --- voiceprint ----------------------------------------------------------
  // Only utterances matching the enrolled voice drive input. Off until enrolled,
  // because with no reference it could only reject everything.
  voiceprintEnabled: false,
  voiceprint: null,           // 192 floats, L2-normalised, averaged over takes
  voiceprintThreshold: 0.5,

  // --- meeting mode --------------------------------------------------------
  // The point of a meeting is the other people in it, so the "only my voice"
  // gate is bypassed there by default — otherwise the transcript would be a
  // monologue with everyone else's turns missing.
  meetingBypassVoiceprint: true,
  meetingDiarize: true,       // cluster embeddings into 说话人1/2/3…
  meetingDiarizeThreshold: 0.55,

  // --- webhook -------------------------------------------------------------
  webhookEnabled: false,
  webhookUrl: '',
  webhookSecret: '',          // HMAC-SHA256 over the raw body, if set
  webhookHeaders: {},         // extra static headers, e.g. an Authorization
  webhookIncludeSegments: true,
  webhookAutoOnEnd: true,     // push automatically when a meeting ends

  // --- project binding -------------------------------------------------------
  // Where a recording gets filed. Two endpoints, both optional, and the whole
  // feature degrades cleanly when neither is set.
  //
  // The list endpoint answers "which meeting is this?" — it is GET, and the
  // response shape is configuration rather than a contract, because there is no
  // such shape every backend agrees on. See electron/projects.cjs.
  projectsEnabled: false,
  projectsUrl: '',
  projectsHeaders: {},        // usually an Authorization
  // The "hierarchy of the result": a dot path to the array, then a dot path to
  // each field inside an item ('project.id' works).
  projectsItemsPath: '',      // '' = the response root is the array
  projectsIdField: 'id',
  projectsNameField: 'name',
  // Blank falls back to the id field, which is what lets one config serve both
  // "returns projects" and "returns meetings that each carry a project".
  projectsProjectIdField: '',
  projectsGroupField: '',     // optional heading in the picker

  // The push endpoint. Real-time, one POST per recognised sentence, plus a
  // complete record when the meeting ends. Both carry the project id when the
  // meeting has one and omit it entirely when it doesn't.
  projectPushEnabled: false,
  projectPushUrl: '',
  projectPushSecret: '',      // same HMAC scheme as the webhook above
  projectPushHeaders: {},
  projectPushSegments: true,  // the live half; off = only the end-of-meeting push
  projectPushOnEnd: true,

  // --- shell ---------------------------------------------------------------
  // Pull the 228MB recogniser down shortly after launch rather than on the
  // first press of the mic. The alternative — which is what shipped first — is
  // that a new user's first interaction is a progress number where the
  // waveform should be, for two minutes, with no audio anywhere. Off is
  // available for metered connections; it just moves the wait to first use.
  autoDownloadModel: true,

  // Three ways to start, because they are three different intentions and
  // making one of them cover all three is what forces a mouse into the loop.
  //
  //   pushToTalk — hold it, say the thing, let go. The strip has no start
  //                button at all now: reaching for one with a mouse is the
  //                slowest possible way to begin talking, and by the time you
  //                have found it you have forgotten the sentence. A quick tap
  //                is treated as "one utterance, then stop".
  //   toggle     — on until told otherwise. For dictating a paragraph.
  //   meeting    — start a meeting outright: transcript only, nothing typed
  //                anywhere. Distinct from the other two because it changes
  //                what the app does with what it hears, not just when.
  hotkeyPushToTalk: 'Control+Shift+Space',
  hotkeyToggle:     'Control+Shift+D',
  hotkeyMeeting:    'Control+Shift+M',
  hotkeyMute:       'Control+Shift+X',
  hotkeyPanel:      'Control+Shift+H',
  // Deprecated: the strip is fixed above the taskbar and can no longer be
  // dragged. Still read at startup so an upgrade doesn't visibly teleport it
  // out from under someone who had moved it; nothing writes it any more.
  overlayPosition: null,

  // Distance in pixels from the bottom of the visible capsule to the top of the
  // taskbar. Measured against the capsule, not the window: the window's bottom
  // band is transparent room for the drop shadow, so a number expressed against
  // the window edge would be 22px away from anything you can see.
  //
  // A setting rather than a constant because the line the strip should sit above
  // is not something the app can find out: an auto-hiding taskbar, a second row
  // of icons, a docked toolbar, or simply preferring it further from the edge —
  // all move it, and none of them are visible from in here.
  overlayBottomGap: 15,

  launchAtLogin: false,
  historyLimit: 5000,         // entries kept in the queryable window
}

// Every global-shortcut setting, in the order they get to claim a combination.
// The order is the fix, not decoration: when two of them collide the earlier
// one keeps the key. Push-to-talk is first because it inherited
// Control+Shift+Space from the redesign, and a person upgrading has that
// combination in their fingers.
const HOTKEY_KEYS = ['hotkeyPushToTalk', 'hotkeyToggle', 'hotkeyMeeting', 'hotkeyMute', 'hotkeyPanel']

/**
 * No two shortcuts may be the same combination.
 *
 * A global shortcut is claimed OS-wide by whoever registers it first, so a
 * duplicate does not produce two behaviours or an error — it silently deletes
 * the second one. The whole feature just isn't there, with nothing on screen
 * to say why.
 *
 * That is not hypothetical. Splitting "start dictating" into push-to-talk and
 * toggle gave push-to-talk the old toggle default (Control+Shift+Space) and
 * moved toggle to Control+Shift+D — but a settings file written by the old
 * build still said `hotkeyToggle: Control+Shift+Space`, and saved values win
 * over defaults. Both landed on Space, push-to-talk registered first, and
 * continuous dictation became unreachable: press the key, say one sentence,
 * watch it stop, with no combination anywhere that would keep it running.
 *
 * Resolved by walking in priority order and sending any latecomer back to its
 * own default — which for the case above is exactly the intended new layout.
 * If the default is taken too, the setting is cleared: visibly unset in the
 * console is honest, silently dead is not.
 *
 * @returns {{settings: object, changed: string[]}}
 */
function dedupeHotkeys(settings) {
  const out = { ...settings }
  const taken = new Map()   // accelerator -> the key holding it
  const changed = []

  for (const key of HOTKEY_KEYS) {
    const want = out[key]
    if (!want) continue
    if (!taken.has(want)) { taken.set(want, key); continue }

    const fallback = DEFAULTS[key]
    if (fallback && !taken.has(fallback)) {
      out[key] = fallback
      taken.set(fallback, key)
    } else {
      out[key] = ''
    }
    changed.push(`${key}: ${want} → ${out[key] || '(未设置)'}（与 ${taken.get(want)} 冲突）`)
  }

  return { settings: out, changed }
}

// ---- Helpers ----------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  // Write-then-rename: a process killed mid-write leaves the old file intact
  // rather than a truncated one that parses as nothing.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function readJsonl(file, { limit = Infinity, fromEnd = false } = {}) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n')
  const out = []
  const iter = fromEnd ? lines.slice().reverse() : lines
  for (const line of iter) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn last line is the expected cost of append-only + a hard kill.
      // Skipping it loses at most the one utterance that was mid-flush.
    }
    if (out.length >= limit) break
  }
  return out
}

const pad = (n) => String(n).padStart(2, '0')

/** Local-time YYYY-MM-DD. Stats are read by a human in their own timezone. */
function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

let _seq = 0
function makeId(prefix, ts = Date.now()) {
  const d = new Date(ts)
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  _seq = (_seq + 1) % 46656
  return `${prefix}_${stamp}_${_seq.toString(36).padStart(3, '0')}`
}

// Counting "words" across mixed Chinese/English: CJK characters each count as
// one, runs of Latin letters/digits count as one. A plain .length over-counts
// Chinese by ~2x against what anyone means by 字数, and splitting on whitespace
// under-counts it to nearly zero.
function countWords(text) {
  if (!text) return 0
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length
  const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length
  return cjk + latin
}

// ---- Store ------------------------------------------------------------------

function createStore({ dir }) {
  fs.mkdirSync(dir, { recursive: true })
  const meetingsDir = path.join(dir, 'meetings')
  fs.mkdirSync(meetingsDir, { recursive: true })

  const settingsFile = path.join(dir, 'settings.json')
  const historyFile  = path.join(dir, 'history.jsonl')
  const indexFile    = path.join(meetingsDir, 'index.jsonl')

  // Defaults first so a new key appears, saved values second so a choice
  // survives — and then the hotkey invariant, because that combination is
  // exactly how a new default and an old saved value can collide.
  let settings = { ...DEFAULTS, ...readJson(settingsFile, {}) }
  {
    const fixed = dedupeHotkeys(settings)
    if (fixed.changed.length) {
      settings = fixed.settings
      // Written back immediately rather than only held in memory: otherwise
      // the settings page shows the repaired value while the file still holds
      // the broken one, and the next launch repairs it again.
      writeJsonAtomic(settingsFile, settings)
      for (const line of fixed.changed) console.warn('[hotkey] 快捷键冲突已修正 —', line)
    }
  }

  // One long-lived append fd for history. Opening per write would cost a
  // syscall pair per utterance and, worse, would give the OS more chances to
  // interleave two writes into one line.
  let historyFd = null
  function historyStream() {
    if (historyFd === null) historyFd = fs.openSync(historyFile, 'a')
    return historyFd
  }
  function appendLine(fd, obj) {
    // fs.writeSync on an 'a' fd is atomic for writes under PIPE_BUF on POSIX
    // and serialised by the fd on Windows. One write per line, newline
    // included, so a partial write can only ever truncate the tail.
    fs.writeSync(fd, JSON.stringify(obj) + '\n')
  }

  // ---- settings -------------------------------------------------------------

  function getSettings() { return { ...settings } }

  function setSettings(patch) {
    const merged = { ...settings, ...(patch || {}) }
    // Also enforced on write, so the settings page cannot create the very
    // state the load-time repair exists to undo — assigning a combination that
    // another shortcut already holds would otherwise disable one of them.
    settings = dedupeHotkeys(merged).settings
    writeJsonAtomic(settingsFile, settings)
    return { ...settings }
  }

  /**
   * Which other shortcut already holds this combination, if any. The settings
   * page asks before saving so it can say so, instead of letting the write be
   * silently corrected under the cursor.
   */
  function hotkeyConflict(key, accel) {
    if (!accel) return ''
    for (const other of HOTKEY_KEYS) {
      if (other !== key && settings[other] === accel) return other
    }
    return ''
  }

  function resetSettings() {
    settings = { ...DEFAULTS }
    writeJsonAtomic(settingsFile, settings)
    return { ...settings }
  }

  // ---- history --------------------------------------------------------------

  /**
   * Record one recognised utterance. Called on the transcription path, so it
   * has to be cheap and it has to be durable — in that order of frequency and
   * the reverse order of importance.
   *
   * @param {object} e
   * @param {string} e.text
   * @param {number} [e.at]        epoch ms
   * @param {number} [e.durationMs] length of the audio, not the decode
   * @param {number} [e.decodeMs]
   * @param {'dictation'|'meeting'} [e.mode]
   * @param {string} [e.meetingId]
   * @param {string} [e.speaker]   diarization label, meetings only
   * @param {string} [e.output]    which output path actually ran
   * @param {boolean} [e.rejected] failed the voiceprint gate
   */
  function addHistory(e) {
    const at = e.at || Date.now()
    const entry = {
      id: makeId('u', at),
      at,
      text: e.text || '',
      chars: (e.text || '').length,
      words: countWords(e.text || ''),
      durationMs: e.durationMs || 0,
      decodeMs: e.decodeMs || 0,
      mode: e.mode || 'dictation',
      output: e.output || 'none',
      ...(e.meetingId ? { meetingId: e.meetingId } : {}),
      ...(e.speaker ? { speaker: e.speaker } : {}),
      ...(e.rejected ? { rejected: true } : {}),
      ...(e.app ? { app: e.app } : {}),
      ...(e.source && e.source !== 'mic' ? { source: e.source } : {}),
    }
    appendLine(historyStream(), entry)
    return entry
  }

  /** Newest first. `limit` bounds the read, `query` filters on text. */
  function listHistory({ limit = 200, offset = 0, query = '', mode = '', meetingId = '' } = {}) {
    const all = readJsonl(historyFile, { fromEnd: true, limit: settings.historyLimit })
    const q = query.trim().toLowerCase()
    const filtered = all.filter((e) => {
      if (mode && e.mode !== mode) return false
      if (meetingId && e.meetingId !== meetingId) return false
      if (q && !(e.text || '').toLowerCase().includes(q)) return false
      return true
    })
    return { total: filtered.length, items: filtered.slice(offset, offset + limit) }
  }

  /** Drop one entry. Rewrites the file — rare enough that O(n) is fine. */
  function deleteHistory(id) {
    const all = readJsonl(historyFile)
    const kept = all.filter((e) => e.id !== id)
    if (kept.length === all.length) return false
    rewriteHistory(kept)
    return true
  }

  function clearHistory() {
    rewriteHistory([])
    return true
  }

  function rewriteHistory(entries) {
    // The append fd has to go first: on Windows you cannot rename over a file
    // that anyone still holds open, and the fd we own is the likeliest anyone.
    if (historyFd !== null) { try { fs.closeSync(historyFd) } catch {} ; historyFd = null }
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
    const tmp = `${historyFile}.tmp`
    fs.writeFileSync(tmp, body)
    try {
      fs.renameSync(tmp, historyFile)
    } catch (err) {
      // Something else still has a handle on it — an antivirus scanner mid-read,
      // a backup agent, an editor the user opened it in. Truncate-and-write in
      // place instead, which Windows permits with other handles open. Slightly
      // less atomic; the alternative is refusing to delete a history entry
      // because Defender happened to be looking at the file.
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err
      fs.writeFileSync(historyFile, body)
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  // ---- stats ----------------------------------------------------------------

  /**
   * Everything the stats page shows, computed in one pass. `days` bounds the
   * daily series; the totals cover the whole retained history.
   */
  function stats({ days = 30 } = {}) {
    const all = readJsonl(historyFile)
    const byDay = new Map()
    let chars = 0, words = 0, count = 0, audioMs = 0, decodeMs = 0, rejected = 0
    let meetingCount = 0, meetingChars = 0
    const byHour = new Array(24).fill(0)

    for (const e of all) {
      if (e.rejected) { rejected++; continue }
      count++
      chars += e.chars || 0
      words += e.words || 0
      audioMs += e.durationMs || 0
      decodeMs += e.decodeMs || 0
      byHour[new Date(e.at).getHours()]++
      if (e.mode === 'meeting') { meetingCount++; meetingChars += e.chars || 0 }
      const k = dayKey(e.at)
      const d = byDay.get(k) || { day: k, count: 0, chars: 0, words: 0, audioMs: 0 }
      d.count++; d.chars += e.chars || 0; d.words += e.words || 0; d.audioMs += e.durationMs || 0
      byDay.set(k, d)
    }

    // Fill the gaps: a bar chart with missing days lies about the cadence.
    const series = []
    const today = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
      const k = dayKey(d.getTime())
      series.push(byDay.get(k) || { day: k, count: 0, chars: 0, words: 0, audioMs: 0 })
    }

    // The number people actually care about: typing 200 chars costs about a
    // minute; saying them costs the audio. Report both and let them do the
    // subtraction, rather than inventing a "time saved" figure.
    return {
      total: { count, chars, words, audioMs, decodeMs, rejected },
      avg: {
        charsPerUtterance: count ? +(chars / count).toFixed(1) : 0,
        decodeMs: count ? Math.round(decodeMs / count) : 0,
        realtimeFactor: decodeMs ? +(audioMs / decodeMs).toFixed(1) : 0,
      },
      meeting: { count: meetingCount, chars: meetingChars },
      series,
      byHour,
      firstAt: all.length ? all[0].at : null,
    }
  }

  // ---- meetings -------------------------------------------------------------

  function meetingFile(id) { return path.join(meetingsDir, `${id}.json`) }

  /**
   * @param {object} [o]
   * @param {string} [o.title]
   * @param {number} [o.at]
   * @param {string} [o.projectId]        what the push endpoint files this under
   * @param {string} [o.projectName]      for display only
   * @param {string} [o.projectMeetingId] the remote list's own id for this meeting
   */
  function createMeeting({ title = '', at = Date.now(), projectId = '', projectName = '', projectMeetingId = '' } = {}) {
    const id = makeId('mt', at)
    const doc = {
      id,
      title: title || `会议 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`,
      startedAt: at,
      endedAt: null,
      status: 'recording',
      segments: [],
      speakers: [],
      notes: '',
      delivery: null,       // last webhook attempt, see webhook.cjs
      // Empty when no list endpoint is configured, or when it could not be
      // reached. Everything downstream treats that as "unassigned" and pushes
      // without a project block rather than refusing to record.
      projectId,
      projectName,
      projectMeetingId,
      projectDelivery: null,        // the project endpoint's own end-of-meeting result
      livePush: { sent: 0, failed: 0 },
    }
    writeJsonAtomic(meetingFile(id), doc)
    // Opened and closed per meeting rather than held: meetings start a few
    // times a day, and a long-lived fd here would be a handle leaked for the
    // life of the app in exchange for saving one syscall an hour.
    const fd = fs.openSync(indexFile, 'a')
    try { appendLine(fd, { id, title: doc.title, startedAt: at }) } finally { fs.closeSync(fd) }
    return doc
  }

  function getMeeting(id) { return readJson(meetingFile(id), null) }

  function saveMeeting(doc) {
    writeJsonAtomic(meetingFile(doc.id), doc)
    return doc
  }

  /** Append one recognised utterance to a live meeting. */
  function addSegment(id, seg) {
    const doc = getMeeting(id)
    if (!doc) throw new Error(`meeting ${id} not found`)
    const entry = {
      i: doc.segments.length,
      at: seg.at || Date.now(),
      offsetMs: Math.max(0, (seg.at || Date.now()) - doc.startedAt),
      durationMs: seg.durationMs || 0,
      speaker: seg.speaker || 'S1',
      text: seg.text || '',
      // Only recorded when it isn't the microphone. Absent means 'mic', which
      // keeps every transcript written before system audio existed readable as
      // exactly what it was.
      ...(seg.source && seg.source !== 'mic' ? { source: seg.source } : {}),
    }
    doc.segments.push(entry)
    // Rewritten in full on each segment. A meeting is one utterance every few
    // seconds and the doc stays well under a megabyte, so the atomic rewrite is
    // cheap; the history JSONL is the crash-proof copy either way.
    saveMeeting(doc)
    return entry
  }

  function endMeeting(id, { at = Date.now() } = {}) {
    const doc = getMeeting(id)
    if (!doc) throw new Error(`meeting ${id} not found`)
    doc.endedAt = at
    doc.status = 'ended'
    return saveMeeting(doc)
  }

  /**
   * Close meetings that disk says are still recording.
   *
   * `status: 'recording'` is written when a meeting starts and only cleared by
   * endMeeting, so a crash, a force-quit, or a dev restart leaves it set
   * forever. Nothing reconciled it, and the result was ugly: every interrupted
   * meeting kept a red dot in the list, the console thought a recording was in
   * progress at launch, and 结束 did nothing at all — it calls through to the
   * pipeline, whose in-memory `active` is empty on a fresh process, so it
   * returned null and no state changed. A button that cannot work is worse than
   * a button that isn't there.
   *
   * Safe by construction: nothing can be recording in a process that has not
   * finished starting, so anything found here is definitionally abandoned.
   * Called once from main before any window renders.
   *
   * endedAt is the end of the last segment rather than now — the meeting stopped
   * whenever the app did, and dating it to this launch would invent hours of
   * silence. A meeting with no segments ends where it began.
   */
  function closeAbandonedMeetings() {
    const closed = []
    for (const row of readJsonl(indexFile)) {
      const doc = getMeeting(row.id)
      if (!doc || doc.status !== 'recording') continue
      const last = doc.segments[doc.segments.length - 1]
      doc.endedAt = last ? last.at + (last.durationMs || 0) : doc.startedAt
      doc.status = 'ended'
      // Distinguishable from a meeting someone actually finished, so the UI can
      // say so instead of implying a clean stop.
      doc.interrupted = true
      saveMeeting(doc)
      closed.push(doc.id)
    }
    return closed
  }

  function listMeetings({ limit = 100 } = {}) {
    const idx = readJsonl(indexFile, { fromEnd: true, limit })
    return idx
      .map((row) => {
        const doc = getMeeting(row.id)
        if (!doc) return null
        return {
          id: doc.id,
          title: doc.title,
          startedAt: doc.startedAt,
          endedAt: doc.endedAt,
          status: doc.status,
          segments: doc.segments.length,
          chars: doc.segments.reduce((n, s) => n + s.text.length, 0),
          speakers: doc.speakers.length,
          delivery: doc.delivery,
          // This projection is a whitelist, so anything the list view shows has
          // to be named here — a project chip on a row reads from these.
          projectId: doc.projectId || '',
          projectName: doc.projectName || '',
          projectDelivery: doc.projectDelivery || null,
          livePush: doc.livePush || null,
        }
      })
      .filter(Boolean)
  }

  function deleteMeeting(id) {
    try { fs.unlinkSync(meetingFile(id)) } catch { return false }
    const idx = readJsonl(indexFile).filter((r) => r.id !== id)
    fs.writeFileSync(indexFile, idx.map((r) => JSON.stringify(r)).join('\n') + (idx.length ? '\n' : ''))
    return true
  }

  function close() {
    if (historyFd !== null) { try { fs.closeSync(historyFd) } catch {} ; historyFd = null }
  }

  return {
    dir,
    DEFAULTS,
    getSettings, setSettings, resetSettings, hotkeyConflict,
    addHistory, listHistory, deleteHistory, clearHistory,
    stats,
    createMeeting, getMeeting, saveMeeting, addSegment, endMeeting, listMeetings, deleteMeeting,
    closeAbandonedMeetings,
    close,
  }
}

module.exports = { createStore, DEFAULTS, HOTKEY_KEYS, dedupeHotkeys, countWords, dayKey, makeId }
