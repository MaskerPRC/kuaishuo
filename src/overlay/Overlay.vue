<template>
  <div class="root" :style="{ '--accent': ACCENT }">
    <!-- The line above the glass. Only ever the toast — the last thing said,
         then gone. There were 控制台 / 隐藏 links here on hover; both live in
         the tray, and a row of text that appears whenever the cursor passes
         nearby is motion the eye has to check and then discard. At rest this
         line is empty, which is the point. -->
    <div class="above">
      <transition name="fade">
        <div v-if="toast" class="toast" :class="{ 'is-warn': toast.warn }">{{ toast.text }}</div>
      </transition>
    </div>

    <div ref="lensEl" class="lens" @dblclick.stop="openConsole">
      <!-- No capsule, no plate, no rim. Just the things that mean something: a
           waveform, what it is doing with the words, and the two controls you
           reach for. Starting and stopping is the hotkeys' job now — a button
           you have to find with the mouse is the slowest possible way to begin
           talking. -->
      <div class="glass" ref="glassEl">
        <div class="stage">
          <WaveBar
            v-if="!statusText"
            :bands="d.bands"
            :busy="d.phase.value === 'transcribing'"
            :w="228" :h="32"
            :color="waveColor"
          />
          <span v-else class="status" :class="{ 'is-err': !!d.error.value }">{{ statusText }}</span>
        </div>

        <!-- One slot, three things, in priority order:
             the model download (you cannot dictate yet and need to know why),
             the meeting clock (this is being recorded, not typed), and
             otherwise where the next words are going. -->
        <span v-if="d.modelBusy.value" class="note" :title="modelHint">{{ modelLabel }}</span>
        <span v-else-if="meeting.on" class="timer">{{ elapsed }}</span>
        <button v-else class="mode" :title="modeHint" @click.stop="cycleMode">{{ modeLabel }}</button>

        <!-- Exactly two. Pause is the one you reach for without planning to;
             meeting is the one that changes what the app does with what it
             hears. Everything else lives above on hover, or in the tray. -->
        <div class="acts">
          <button
            class="act"
            :class="{ 'is-on': d.muted.value }"
            :disabled="!d.active.value"
            :title="d.muted.value ? '恢复听写' : '暂停（麦克风保持开启，但不识别）'"
            @click.stop="d.toggleMuted()"
          >
            <svg v-if="!d.muted.value" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7">
              <rect x="9" y="3" width="6" height="11" rx="3" stroke-linejoin="round"/>
              <path stroke-linecap="round" d="M18 11a6 6 0 0 1-12 0M12 17v4"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" d="M9 5a3 3 0 0 1 6 0v5m-6 1a3 3 0 0 0 4.5 2.6M18 11a6 6 0 0 1-9.5 4.87M12 17v4M4 3l16 18"/>
            </svg>
          </button>

          <button
            class="act meeting"
            :class="{ 'is-on': meeting.on }"
            :title="meeting.on ? '会议记录中 · 打开控制台' : '在控制台开始会议（需要先选择所属会议）'"
            @click.stop="openMeetingsPage"
          >
            <svg v-if="!meeting.on" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 19v-1.5a2.5 2.5 0 0 0-2.5-2.5h-7A2.5 2.5 0 0 0 4 17.5V19M10 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1.5a2.5 2.5 0 0 0-1.9-2.4M15.5 6.2a3 3 0 0 1 0 5.6"/>
            </svg>
            <span v-else class="rec"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import WaveBar from '../components/WaveBar.vue'
import { useDictation } from '../core/useDictation.js'
import { useSettings, updateSettings } from '../core/settings.js'

// WeChat green. One accent for the whole product; every other colour here is a
// neutral or a warning.
const ACCENT = '#07c160'

const { settings } = useSettings()

const meeting = reactive({ on: false, id: null, startedAt: 0 })
const meetingActive = computed(() => meeting.on)

const d = useDictation({ meetingActive })
// `d` is handed to the template as a whole so the refs stay refs — unwrapping
// them into locals here would fix the values at setup time.

// ---- Status -----------------------------------------------------------------

// Text only ever replaces the ribbon for a hard failure. A model download used
// to take the ribbon's place, and the result — a strip with a percentage on it
// and nothing moving — was reported as "there is no audio input at all". The
// waveform is the thing that says the app is alive; it does not get evicted for
// a status line.
const statusText = computed(() => {
  if (d.error.value) {
    if (d.error.value === 'mic-ended' || d.error.value === 'mic-stalled') return '麦克风已断开'
    if (d.error.value === 'mic-gone') return '选中的麦克风不可用'
    if (d.error.value === 'unsupported') return '当前环境不支持'
    return String(d.error.value).slice(0, 40)
  }
  return ''
})

const modelLabel = computed(() => {
  const m = d.model.value
  const pct = Math.round((m.progress || 0) * 100)
  if (m.stage === 'extracting-model') return `解压 ${pct}%`
  if (m.stage === 'downloading-speaker') return `声纹 ${pct}%`
  return `模型 ${pct}%`
})
const modelHint = computed(() =>
  d.active.value
    ? '识别模型还在下载，下完会自动开始听写'
    : '正在后台下载识别模型（约 228MB），完成前无法听写')

const waveColor = computed(() => {
  if (d.error.value) return '#ff5a5a'
  if (!d.active.value) return '#7b8794'    // resting: alive, not listening
  if (d.muted.value) return '#9aa5b1'
  return ACCENT                            // listening and recording are both green
})

// ---- Toast ------------------------------------------------------------------

const toast = ref(null)
let toastTimer = null

function flash(text, warn = false) {
  toast.value = { text, warn }
  clearTimeout(toastTimer)
  // Long enough to read a sentence, short enough that it's gone before it
  // becomes furniture.
  toastTimer = setTimeout(() => { toast.value = null }, warn ? 2600 : 4200)
}

watch(d.lastText, (t) => { if (t) flash(t) })
// No toast for a voiceprint rejection. The gate firing is the normal, expected
// state of a room with a television in it — announcing every time it works
// turns the thing that is protecting you into a nag. It is still recorded, so
// the history and stats pages can account for a quiet session; it just no
// longer interrupts.

// Losing system audio costs you the far end of the call, not the session — so
// it goes in the toast and never in `statusText`, which evicts the waveform and
// is reserved for "this app cannot hear you at all".
const SYS_AUDIO_MSG = {
  denied: '没能获取系统声音，这场会议只录到麦克风',
  unavailable: '系统声音不可用，只录到麦克风',
  lost: '系统声音中断了，之后只录麦克风',
}
watch(d.systemAudioWarn, (w) => { if (w) flash(SYS_AUDIO_MSG[w] || '系统声音不可用，只录到麦克风', true) })

// ---- Output mode ------------------------------------------------------------

const MODES = ['type', 'clipboard', 'none']
const MODE_LABEL = { type: '直接输入', clipboard: '剪贴板', none: '仅记录' }
const MODE_HINT = {
  type: '识别结果直接输入到当前光标处',
  clipboard: '识别结果只复制到剪贴板，自己粘贴',
  none: '只写进历史，不输出到任何地方',
}
const modeLabel = computed(() => MODE_LABEL[settings.value.outputMode] || '直接输入')
const modeHint = computed(() => `输出方式：${MODE_HINT[settings.value.outputMode] || ''}（点击切换）`)

function cycleMode() {
  const i = MODES.indexOf(settings.value.outputMode)
  const next = MODES[(i + 1) % MODES.length]
  updateSettings({ outputMode: next })
  flash(`输出方式：${MODE_LABEL[next]}`, true)
}

// ---- Meeting ----------------------------------------------------------------

const now = ref(Date.now())
let clock = null

const elapsed = computed(() => {
  const ms = Math.max(0, now.value - meeting.startedAt)
  const s = Math.floor(ms / 1000)
  const p = (n) => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`
})

// The strip reports on a meeting; it no longer starts or stops one.
//
// A recording has to be filed under a project before its first sentence, and
// picking one needs a list, a search box, and a window that can take focus —
// none of which this one can be, since `focusable: false` is the whole reason
// the app can paste into the window you were already typing in. So the glyph
// opens the console instead. The timer and the recording dot still live here,
// because "this is being recorded" is exactly what a strip is for.
function openMeetingsPage() {
  window.kuaishuo.app.openMeetings()
}

function setMeeting(doc) {
  meeting.on = !!doc && doc.status === 'recording'
  meeting.id = doc?.id || null
  meeting.startedAt = doc?.startedAt || 0
}

// ---- Wiring -----------------------------------------------------------------

// Double-clicking the capsule is the only way in from here now. Hiding the
// strip lives in the tray, which is where an action you take once a week
// belongs.
function openConsole() { window.kuaishuo.app.openConsole() }

// ---- Click-through -----------------------------------------------------------
// The window is mostly empty air. Everything outside the strip lets clicks fall
// through to whatever is behind it, so it never becomes a dead zone hovering
// over someone's document. Main keeps the window in "ignore mouse, forward
// moves" mode; this handler asks for interactivity back when the cursor is
// actually over the content.

const lensEl = ref(null)
let interactive = null

const glassEl = ref(null)

const PAD = 6   // a little slack so the edge isn't a knife-edge to hit

function over(el, e) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  // A row with nothing in it has zero height and must not claim the cursor.
  if (r.width === 0 || r.height === 0) return false
  return e.clientX >= r.left - PAD && e.clientX <= r.right + PAD &&
         e.clientY >= r.top - PAD && e.clientY <= r.bottom + PAD
}

function onPointerMove(e) {
  // The capsule only. The line above it holds nothing clickable now that the
  // hover links are gone — claiming it for the toast would swallow clicks
  // aimed at the user's own window for the seconds the toast is up, which is
  // a worse bug than the one it would be imitating.
  const want = over(lensEl.value, e)
  if (want !== interactive) {
    interactive = want
    window.kuaishuo.overlay.setInteractive(want)
  }
}

let unsubs = []

onMounted(async () => {
  clock = setInterval(() => { now.value = Date.now() }, 1000)

  // Bound to the window, not the capsule: while clicks are being forwarded
  // through, the capsule itself never receives an enter event — the only thing
  // that arrives is a stream of moves over the document.
  window.addEventListener('mousemove', onPointerMove, { passive: true })

  const current = await window.kuaishuo.meeting.current()
  if (current) setMeeting(current)

  unsubs.push(window.kuaishuo.dictation.onCommand(({ cmd }) => {
    if (cmd === 'toggle') d.toggle()
    else if (cmd === 'start' || cmd === 'start-for-meeting') { if (!d.active.value) d.start() }
    else if (cmd === 'stop') d.stop()
    else if (cmd === 'mute') d.toggleMuted()
    // 'meeting-toggle' is deliberately gone: the tray item and the meeting
    // hotkey now open the console directly from main, because a meeting cannot
    // start until it has been filed under a project.
  }))

  // Opening the loopback tap needs transient user activation, and the click
  // that starts a meeting now happens in the console — a different renderer.
  // IPC does not carry activation, so main reaches in with
  // executeJavaScript(code, true), which does. That needs something on `window`
  // to call, hence this: the alternative is losing system audio in every
  // meeting on Windows, silently.
  window.__kuaishuoArmSystemAudio = () => { try { d.armSystemAudio() } catch {} }
  unsubs.push(() => { delete window.__kuaishuoArmSystemAudio })

  unsubs.push(window.kuaishuo.meeting.onChange(async (e) => {
    if (e?.started || e?.ended) setMeeting(await window.kuaishuo.meeting.current())
  }))

  // Main drives the tray icon and tooltip off this, so it has to be sent on
  // every transition rather than polled.
  const report = () => window.kuaishuo.dictation.reportState({
    active: d.active.value, phase: d.phase.value, muted: d.muted.value, meeting: meeting.on,
  })
  watch([d.active, d.phase, d.muted, () => meeting.on], report, { immediate: true })
})

onBeforeUnmount(() => {
  clearInterval(clock)
  clearTimeout(toastTimer)
  window.removeEventListener('mousemove', onPointerMove)
  for (const u of unsubs) { try { u() } catch {} }
})
</script>

<style>
html, body, #overlay {
  margin: 0;
  height: 100%;
  background: transparent;
  overflow: hidden;
  user-select: none;
  -webkit-font-smoothing: antialiased;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
}
</style>

<style scoped>
.root {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  box-sizing: border-box;
  /* Room for the surface to fade out in. Clipped by the window edge it would
     show a straight line under the strip — the exact artefact the edge fade
     exists to avoid. */
  padding-bottom: 22px;
}
/* Only the glass is grabbable. Everything else in this window is air that
   clicks fall straight through. */
.lens { cursor: grab; }
.lens:active { cursor: grabbing; }

/* ---- The line above ------------------------------------------------------- */
.above {
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 460px;
}
.toast {
  font-size: 12.5px;
  line-height: 1.45;
  color: #f2f5f8;
  padding: 5px 13px;
  /* Same material as the bar, smaller. A gradient cloud was tried here too and
     had the same problem: over a light background a soft dark blob reads as a
     stain, not as a label. */
  background: #151a21;
  border-radius: 14px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.toast.is-warn { color: #ffd66b; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(4px); }

/* ---- Liquid glass --------------------------------------------------------- */
/* ---- The surface -----------------------------------------------------------
   Opaque, and deliberately so.

   Three rounds of glass all failed the same way. Showing the desktop through
   the strip means the strip's colour is whatever happens to be behind it — so
   it changes as you scroll, as windows move, as you drag it. That reads as the
   UI glitching, and no amount of blur fixes it because the problem is not
   sharpness, it is that the colour is not ours.

   And a real blur of the desktop needs the desktop, which in a transparent
   window means photographing the screen. That capture cost ~600ms a shot on a
   large desktop — the whole reason this was slow. Removing it is not a
   compromise; it removes the lag and the colour shifting at the same time.

   What is left is a solid dark surface that fades to nothing at the edges, so
   there is still no border anywhere. It looks the same over a white document
   as over a dark IDE, because it is the same. */

.lens { position: relative; }

/* A defined shape, a solid fill, one small shadow. Nothing clever.

   The last few rounds chased "no border" all the way to having no shape at all
   — a radial gradient fading out on every side. Over a light document that does
   not read as weightless; it reads as a smear someone left on the screen. A
   control that floats over other people's windows needs an edge to look
   deliberate. What it must not have is a *drawn* edge: a 1px stroke, a rim, a
   plate with a hairline. Those are what made the earlier versions look like a
   dialog that had lost its window. */
.glass {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 8px 0 16px;
  border-radius: 23px;
  border: none;
  /* Opaque. Nothing behind can tint it, so it looks the same over a white
     document as over a dark editor — the whole point of giving up on
     transparency. */
  background: #151a21;
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.28),
    0 1px 3px rgba(0, 0, 0, 0.24),
    /* Not a border. A highlight along the top edge only, which fades out at the
       sides rather than ringing the shape. */
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

/* Nothing else. "It is listening" is already said by the waveform going from
   grey to green, and the waveform is the thing that moves — an accent line
   along the bottom was the same fact stated a second time, in a place where it
   could only read as a stray coloured edge. */

/* Content sits above the haze. */
.stage, .mode, .timer, .note, .acts { position: relative; z-index: 1; }

/* ---- Ribbon --------------------------------------------------------------- */
.stage {
  width: 228px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.status {
  font-size: 11.5px;
  color: #d4dbe3;
  white-space: nowrap;
}
.status.is-err { color: #ff8f8f; }

/* ---- Mode / timer --------------------------------------------------------- */
.mode, .timer, .note {
  flex: none;
  min-width: 48px;
  text-align: center;
  font-size: 11.5px;
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  color: #a8b3bf;
  white-space: nowrap;
}
.mode { cursor: pointer; transition: color 0.15s; }
.mode:hover { color: #f2f5f8; }
.timer { color: var(--accent); font-variant-numeric: tabular-nums; }
.note  { color: var(--accent); font-variant-numeric: tabular-nums; opacity: 0.85; }

/* ---- The two buttons ------------------------------------------------------ */
/* Glyphs, not controls. Brightness is the entire affordance — a hover plate
   would put a small rectangle back inside the capsule. */
.acts {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: none;
}
.act {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: #a8b3bf;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, opacity 0.15s, transform 0.15s;
}
.act:hover:not(:disabled) { color: #ffffff; transform: translateY(-1px); }
.act:disabled { opacity: 0.3; cursor: default; }
.act.is-on { color: #ff7a7a; }
.act.meeting.is-on { color: #ff5a5a; }

.rec {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff453a;
  box-shadow: 0 0 10px 1px rgba(255, 69, 58, 0.65);
  animation: blink 1.6s ease-in-out infinite;
}
@keyframes blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }
</style>
