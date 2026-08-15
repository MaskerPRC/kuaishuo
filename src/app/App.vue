<template>
  <div class="shell" :class="{ 'is-max': maximized }">
    <!-- Our own title bar. `frame: false` in main.cjs means there is no OS
         chrome behind any of this: the drag region, the double-click-to-
         maximize, and the three buttons are the entire window frame. -->
    <header class="titlebar">
      <div class="drag" @dblclick="toggleMaximize">
        <span class="logo-sm"></span>
        <span class="app-name">快说</span>
        <span class="crumb dim">{{ TABS.find((t) => t.id === tab)?.label }}</span>
      </div>
      <div class="wctl">
        <button class="wbtn" title="最小化" @click="minimize">
          <svg viewBox="0 0 12 12" width="11" height="11"><path d="M2 6h8" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>
        </button>
        <button class="wbtn" :title="maximized ? '还原' : '最大化'" @click="toggleMaximize">
          <svg v-if="!maximized" viewBox="0 0 12 12" width="11" height="11"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>
          <svg v-else viewBox="0 0 12 12" width="11" height="11">
            <rect x="2.2" y="3.8" width="6" height="6" rx="1.1" stroke="currentColor" stroke-width="1.1" fill="none"/>
            <path d="M4.2 3.4V2.9a1 1 0 0 1 1-1h3.9a1 1 0 0 1 1 1v3.9a1 1 0 0 1-1 1h-.5" stroke="currentColor" stroke-width="1.1" fill="none"/>
          </svg>
        </button>
        <button class="wbtn close" title="关闭（不会退出，托盘里还在）" @click="close">
          <svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.15" fill="none" stroke-linecap="round"/></svg>
        </button>
      </div>
    </header>

    <aside class="nav">
      <!-- The live state of the engine, always visible. The console is a place
           you come to look things up while dictation is running somewhere else,
           so "is it listening right now" has to be answerable from any tab. -->
      <div class="live" :class="stateClass">
        <span class="pulse"></span>
        <span>{{ stateLabel }}</span>
      </div>

      <nav>
        <button v-for="t in TABS" :key="t.id" class="tab" :class="{ on: tab === t.id }" @click="tab = t.id">
          <span class="tab-ico" v-html="t.icon"></span>
          {{ t.label }}
        </button>
      </nav>

      <div class="spacer"></div>

      <button class="btn sm ghost" @click="showOverlay">显示悬浮条</button>
      <button class="btn sm ghost" @click="openData">打开数据目录</button>
      <div class="ver dim">v{{ info.version }}</div>
    </aside>

    <main class="body">
      <HistoryView  v-if="tab === 'history'" />
      <StatsView    v-else-if="tab === 'stats'" />
      <MeetingsView v-else-if="tab === 'meetings'" />
      <SettingsView v-else />
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import HistoryView from './views/HistoryView.vue'
import StatsView from './views/StatsView.vue'
import MeetingsView from './views/MeetingsView.vue'
import SettingsView from './views/SettingsView.vue'

const ICON = {
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7L3 8"/><path stroke-linecap="round" d="M3 4v4h4"/></svg>',
  stats:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  meeting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20v-2a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v2M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 20v-2a3 3 0 0 0-2.2-2.9M16 4.1a3 3 0 0 1 0 5.8"/></svg>',
  gear:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
}

const TABS = [
  { id: 'history',  label: '输入历史', icon: ICON.history },
  { id: 'stats',    label: '统计',     icon: ICON.stats },
  { id: 'meetings', label: '会议',     icon: ICON.meeting },
  { id: 'settings', label: '设置',     icon: ICON.gear },
]

const tab = ref('history')
const info = ref({ version: '…' })
const state = reactive({ active: false, phase: 'idle', muted: false, meeting: false })

const stateLabel = computed(() => {
  if (state.meeting) return '会议记录中'
  if (!state.active) return '未监听'
  if (state.muted) return '已暂停'
  if (state.phase === 'transcribing') return '识别中'
  if (state.phase === 'speaking') return '正在说话'
  if (state.phase === 'downloading') return '下载模型中'
  if (state.phase === 'error') return '出错了'
  return '监听中'
})
const stateClass = computed(() => ({
  on: state.active && !state.muted && !state.meeting,
  meeting: state.meeting,
  paused: state.muted,
}))

function showOverlay() { window.kuaishuo.overlay.show() }
function openData() { window.kuaishuo.app.openPath('data') }

// ---- Window controls --------------------------------------------------------

const maximized = ref(false)
function minimize() { window.kuaishuo.win.minimize() }
function toggleMaximize() { window.kuaishuo.win.toggleMaximize() }
// Closing the console is not quitting. The strip is still up and still
// listening; quitting lives in the tray, deliberately.
function close() { window.kuaishuo.win.close() }

let unsub = null
let unsubMax = null
let unsubNav = null
onMounted(async () => {
  info.value = await window.kuaishuo.app.info()
  unsub = window.kuaishuo.app.onState((s) => Object.assign(state, s))
  // The tray item, the meeting hotkey and the strip's meeting glyph all raise
  // the console and ask for a specific page — meetings, because that is now the
  // only place a recording can be started.
  unsubNav = window.kuaishuo.app.onNavigate((e) => {
    if (e?.tab && TABS.some((t) => t.id === e.tab)) tab.value = e.tab
  })
  maximized.value = await window.kuaishuo.win.isMaximized()
  // Main reports it rather than the button assuming, because the state also
  // changes from Win+Up, a drag to the top edge, and a double-click on the bar.
  unsubMax = window.kuaishuo.win.onMaximized((v) => { maximized.value = v })
})
onBeforeUnmount(() => {
  try { unsub?.() } catch {}
  try { unsubMax?.() } catch {}
  try { unsubNav?.() } catch {}
})
</script>

<style scoped>
/* The window is one surface: a title bar across the top, then the sidebar and
   the body under it. Rounded because Windows 11 rounds frameless windows and a
   square page inside a rounded window shows a sliver of desktop in each corner.
   Squared off again when maximized, where the OS does not round. */
.shell {
  display: grid;
  grid-template-rows: 38px 1fr;
  grid-template-columns: 186px 1fr;
  grid-template-areas: "title title" "nav body";
  height: 100%;
  border-radius: 8px;
  overflow: hidden;
}
.shell.is-max { border-radius: 0; }

/* ---- Title bar ------------------------------------------------------------ */
.titlebar {
  grid-area: title;
  display: flex;
  align-items: stretch;
  background: #0c0e12;
  border-bottom: 1px solid var(--border-soft);
  user-select: none;
}
/* The only draggable region. Everything with -webkit-app-region: no-drag below
   punches a hole in it, which is how a frameless window gets clickable controls
   in a bar you can also throw around. */
.drag {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
  min-width: 0;
  -webkit-app-region: drag;
}
.logo-sm {
  width: 14px; height: 14px; border-radius: 5px; flex: none;
  background:
    linear-gradient(175deg, rgba(255, 255, 255, 0.36) 0%, rgba(255, 255, 255, 0.04) 48%, rgba(255, 255, 255, 0.12) 100%),
    linear-gradient(160deg, #2dd47e, #059848);
  box-shadow: inset 0 0.5px 0 rgba(255, 255, 255, 0.5);
}
.app-name { font-size: 12.5px; letter-spacing: 0.02em; }
.crumb { font-size: 12px; }
.crumb::before { content: "·"; margin-right: 8px; opacity: 0.5; }

.wctl { display: flex; -webkit-app-region: no-drag; }
.wbtn {
  width: 46px;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.wbtn:hover { background: rgba(255, 255, 255, 0.07); color: var(--text); }
/* Windows convention: the close button goes red, and only the close button. */
.wbtn.close:hover { background: #c42b1c; color: #fff; }

.nav {
  grid-area: nav;
  width: 186px;
  flex: none;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-right: 1px solid var(--border-soft);
  background: #0c0e12;
}

.live {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 10px;
  margin-bottom: 10px;
  border-radius: 8px;
  background: var(--bg-inset);
  color: var(--text-3);
  font-size: 12px;
}
.live .pulse { width: 6px; height: 6px; border-radius: 50%; background: #4b5563; flex: none; }
.live.on { color: var(--accent); }
.live.on .pulse { background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
.live.paused { color: var(--text-2); }
.live.meeting { color: var(--warn); }
.live.meeting .pulse { background: var(--warn); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }

nav { display: flex; flex-direction: column; gap: 2px; }
.tab {
  display: flex; align-items: center; gap: 9px;
  height: 34px; padding: 0 10px;
  border: none; border-radius: 8px;
  background: transparent; color: var(--text-2);
  cursor: pointer; text-align: left;
  transition: background 0.14s, color 0.14s;
}
.tab:hover { background: var(--bg-inset); color: var(--text); }
.tab.on { background: var(--bg-inset); color: var(--text); }
.tab-ico { width: 16px; height: 16px; display: inline-flex; opacity: 0.85; }
.tab-ico :deep(svg) { width: 16px; height: 16px; }

.spacer { flex: 1; }
.ver { font-size: 11px; text-align: center; padding: 6px 0 2px; }

.body { grid-area: body; min-width: 0; overflow: auto; }
</style>
