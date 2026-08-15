<template>
  <div class="view">
    <header class="head">
      <h1>输入历史</h1>
      <p class="dim">每一句识别结果在出现的瞬间就已经追加落盘，崩溃、断电、强杀都不会丢。</p>
      <div class="row tools">
        <input v-model="query" class="input search" placeholder="搜索说过的话…" @input="debouncedLoad" />
        <select v-model="mode" class="select filter" @change="load">
          <option value="">全部</option>
          <option value="dictation">听写</option>
          <option value="meeting">会议</option>
        </select>
        <span class="spacer"></span>
        <span class="dim tnum">{{ total }} 条</span>
        <button class="btn sm" @click="clearAll">清空</button>
      </div>
    </header>

    <div v-if="!items.length" class="empty">
      还没有记录。<br />按住 <code class="mono">{{ hotkey }}</code> 说一句试试。
    </div>

    <ul v-else class="list">
      <!-- One line per utterance. The previous version stacked the time above a
           tag above nothing, which made every row 112px tall to hold a single
           short sentence — a screenful showed six things you had said. -->
      <li v-for="e in items" :key="e.id" class="item" :class="{ rejected: e.rejected }">
        <span class="time tnum">{{ fmtTime(e.at) }}</span>
        <span class="dot" :class="kindOf(e)" :title="labelOf(e)"></span>
        <span class="text">{{ e.text }}</span>
        <span class="app dim" :title="e.app">{{ e.app || '' }}</span>
        <span class="chars dim tnum">{{ e.chars }}</span>
        <span class="actions">
          <button class="icon" title="复制" @click="copy(e)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>
            </svg>
          </button>
          <button class="icon" title="重新输入到当前光标处" @click="resend(e)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 10h11a4 4 0 1 1 0 8h-3M4 10l4-4M4 10l4 4"/>
            </svg>
          </button>
          <button class="icon danger" title="删除" @click="remove(e)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12"/>
            </svg>
          </button>
        </span>
      </li>
    </ul>

    <div v-if="items.length < total" class="more">
      <button class="btn" @click="loadMore">加载更多（还有 {{ total - items.length }} 条）</button>
    </div>

    <transition name="fade"><div v-if="flash" class="flash">{{ flash }}</div></transition>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useSettings } from '../../core/settings.js'

const { settings } = useSettings()
const hotkey = ref(settings.value.hotkeyPushToTalk || 'Ctrl+Shift+Space')

const items = ref([])
const total = ref(0)
const query = ref('')
const mode = ref('')
const flash = ref('')
const PAGE = 100

let flashTimer = null
function say(msg) {
  flash.value = msg
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flash.value = '' }, 1800)
}

async function load() {
  const r = await window.kuaishuo.history.list({ limit: PAGE, query: query.value, mode: mode.value })
  items.value = r.items
  total.value = r.total
}

async function loadMore() {
  const r = await window.kuaishuo.history.list({
    limit: PAGE, offset: items.value.length, query: query.value, mode: mode.value,
  })
  items.value = [...items.value, ...r.items]
  total.value = r.total
}

// Typing in a search box shouldn't re-read the whole log on every keystroke.
let debounce = null
function debouncedLoad() {
  clearTimeout(debounce)
  debounce = setTimeout(load, 180)
}

async function copy(e) {
  await window.kuaishuo.history.copy(e.text)
  say('已复制')
}

async function resend(e) {
  const r = await window.kuaishuo.history.resend(e.text)
  say(r?.ok ? (r.mode === 'clipboard' ? '已复制到剪贴板' : '已输入到光标处') : '输入失败')
}

async function remove(e) {
  await window.kuaishuo.history.remove(e.id)
  items.value = items.value.filter((x) => x.id !== e.id)
  total.value = Math.max(0, total.value - 1)
}

async function clearAll() {
  if (!confirm('清空全部输入历史？统计数据也会一并归零，且不可恢复。')) return
  await window.kuaishuo.history.clear()
  await load()
}

// What happened to this utterance, as one dot rather than a coloured chip. A
// chip per row was four words of furniture repeated forty times down the page;
// the dot carries the same four states and the tooltip carries the word.
function kindOf(e) {
  if (e.rejected) return 'bad'
  if (e.mode === 'meeting') return 'meeting'
  if (e.output === 'failed') return 'bad'
  if (e.output === 'type') return 'ok'
  return 'plain'
}
function labelOf(e) {
  if (e.rejected) return '声纹不符，已忽略'
  if (e.mode === 'meeting') return `会议 · ${e.speaker || '未分配'}`
  if (e.output === 'failed') return '输出失败'
  if (e.output === 'type') return '已输入到光标处'
  if (e.output === 'clipboard') return '已复制到剪贴板'
  return '仅记录'
}

function fmtTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

let unsub = null
onMounted(() => {
  load()
  // Live append: the console is often open on a second monitor while dictation
  // happens elsewhere, and a list that needs a manual refresh to show what you
  // just said reads as broken.
  unsub = window.kuaishuo.history.onAdd((entry) => {
    if (mode.value && entry.mode !== mode.value) return
    if (query.value && !entry.text.includes(query.value)) return
    items.value = [entry, ...items.value]
    total.value++
  })
})
onBeforeUnmount(() => { try { unsub?.() } catch {} ; clearTimeout(debounce); clearTimeout(flashTimer) })
</script>

<style scoped>
.view { padding: 26px 28px 40px; max-width: 980px; }
.head h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; }
.head p { margin: 0 0 16px; font-size: 12.5px; }
.tools { margin-bottom: 14px; }
.search { width: 280px; }
.filter { width: 110px; }

.list { list-style: none; margin: 0; padding: 0; }

/* One row, one line. Columns instead of a stacked block: the time and the state
   are narrow and fixed, the sentence takes everything that's left, and the
   trailing metadata only claims space when it has something to say. */
.item {
  display: grid;
  grid-template-columns: 56px 8px 1fr auto 34px 84px;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 10px;
  border-radius: 7px;
  border-bottom: 1px solid transparent;
}
.item + .item { box-shadow: inset 0 1px 0 var(--border-soft); }
.item:hover { background: var(--bg-raised); box-shadow: none; }
.item:hover + .item { box-shadow: none; }
.item.rejected .text { color: var(--text-3); text-decoration: line-through; }

.time { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }

/* The state, as a mark rather than a chip. Forty coloured chips down a page is
   forty times the same four words; a dot says the same thing and gets out of
   the way of the sentence, which is the part anyone came to read. */
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-3);
}
.dot.ok      { background: var(--accent); }
.dot.meeting { background: var(--warn); }
.dot.bad     { background: var(--danger); }
.dot.plain   { background: #3d4652; }

.text {
  min-width: 0;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app {
  font-size: 11.5px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.chars { font-size: 11.5px; text-align: right; }

/* Icons, revealed on hover. Three text buttons on their own line was what made
   the row two lines tall in the first place. */
.actions {
  display: flex;
  gap: 2px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity 0.12s;
}
.item:hover .actions { opacity: 1; }
.icon {
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.icon:hover { background: var(--bg-inset); color: var(--text); }
.icon.danger:hover { background: rgba(239, 68, 68, 0.14); color: var(--danger); }

.more { margin-top: 18px; text-align: center; }

.flash {
  position: fixed;
  bottom: 22px; left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  font-size: 12.5px;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

code { background: var(--bg-inset); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
</style>
