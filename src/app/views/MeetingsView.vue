<template>
  <div class="view">
    <aside class="list-pane">
      <div class="pane-head row">
        <b>会议</b>
        <span class="spacer"></span>
        <button v-if="!recording" class="btn sm primary" @click="start">开始记录</button>
        <button v-else class="btn sm danger" @click="stop">结束</button>
      </div>

      <!-- Choosing what this recording belongs to. Only in the way when a list
           endpoint is configured; nothing about it appears otherwise. -->
      <div v-if="picking" class="picker">
        <div class="row">
          <b>这场录的是哪个会？</b>
          <span class="spacer"></span>
          <button class="btn sm ghost" @click="cancelPick">取消</button>
        </div>

        <div v-if="pickLoading" class="dim small pad">正在拉取会议列表…</div>

        <template v-else-if="pickItems.length">
          <input v-model="pickQuery" class="input" placeholder="搜索…" autofocus />
          <ul class="plist">
            <li v-for="g in pickGroups" :key="g.name || '_'">
              <div v-if="g.name" class="pgroup dim">{{ g.name }}</div>
              <button
                v-for="it in g.items" :key="it.id"
                class="pitem" @click="confirmPick(it)"
              >
                <span class="pname">{{ it.name }}</span>
                <span class="dim mono small">{{ it.projectId }}</span>
              </button>
            </li>
          </ul>
        </template>

        <!-- Fetch failed, or the mapping matched nothing. Recording anyway is
             the right default: losing the meeting is worse than losing the
             filing, and it can be re-filed afterwards from the detail pane. -->
        <div v-else class="pad">
          <div class="bad-text small"><b>{{ pickError || '列表是空的' }}</b></div>
          <div class="dim small">可以先照常录，事后在右侧改归属。</div>
          <button class="btn sm" @click="confirmPick(null)">不归属，直接开始</button>
        </div>
      </div>

      <div v-if="!meetings.length" class="empty small">
        还没有会议。<br />开始记录后，所有人说的话都会进逐字稿，<br />不会被输入到任何应用里。
      </div>

      <ul v-else class="mlist">
        <li
          v-for="m in meetings"
          :key="m.id"
          class="mitem"
          :class="{ on: selected === m.id, live: m.status === 'recording' }"
          @click="select(m.id)"
        >
          <div class="row">
            <span class="mtitle">{{ m.title }}</span>
            <span v-if="m.status === 'recording'" class="rec"></span>
          </div>
          <div class="row msub dim">
            <span class="tnum">{{ fmtDate(m.startedAt) }}</span>
            <span class="spacer"></span>
            <span class="tnum">{{ m.segments }} 段</span>
          </div>
          <div v-if="m.projectName || m.delivery" class="row tags">
            <span v-if="m.projectName" class="tag" :title="`项目 ID ${m.projectId}`">{{ m.projectName }}</span>
            <span v-if="m.delivery" class="tag" :class="m.delivery.ok ? 'ok' : 'bad'">
              {{ m.delivery.ok ? '已推送' : '推送失败' }}
            </span>
          </div>
        </li>
      </ul>
    </aside>

    <section v-if="doc" class="detail">
      <header class="dhead">
        <input v-model="doc.title" class="input title" @change="patch({ title: doc.title })" />
        <div class="row dmeta dim">
          <span class="tnum">{{ fmtDate(doc.startedAt) }}</span>
          <span>·</span>
          <span class="tnum">{{ duration }}</span>
          <span>·</span>
          <span class="tnum">{{ doc.segments.length }} 段 / {{ charCount }} 字</span>
          <span class="spacer"></span>
          <button class="btn sm" @click="exportAs('md')">导出 MD</button>
          <button class="btn sm" @click="exportAs('json')">导出 JSON</button>
          <button class="btn sm" :disabled="pushing" @click="push">
            {{ pushing ? '推送中…' : '推送到 Webhook' }}
          </button>
          <button class="btn sm ghost" @click="showPayload = !showPayload">{{ showPayload ? '收起' : '看推送格式' }}</button>
        </div>
        <div v-if="doc.delivery" class="delivery" :class="doc.delivery.ok ? 'ok' : 'bad'">
          {{ doc.delivery.ok
            ? `已推送 · HTTP ${doc.delivery.status} · ${fmtDate(doc.delivery.at)}`
            : `推送失败 · ${doc.delivery.error}${doc.delivery.permanent ? '（不会自动重试）' : '（已排队重试）'}` }}
        </div>

        <!-- Where this recording is filed, and how the live feed is doing. Only
             rendered once either endpoint is in play — an app with no project
             backend configured should look exactly as it did before. -->
        <div v-if="doc.projectName || doc.projectId || doc.projectDelivery || livePushLabel" class="row dmeta dim proj">
          <span class="tag" :class="doc.projectId ? 'ok' : ''">
            {{ doc.projectName || doc.projectId || '未归属' }}
          </span>
          <span v-if="livePushLabel">{{ livePushLabel }}</span>
          <span v-if="doc.projectDelivery" :class="doc.projectDelivery.ok ? 'ok-text' : 'bad-text'">
            {{ doc.projectDelivery.ok ? `完整记录已推送 · HTTP ${doc.projectDelivery.status}` : `完整记录推送失败 · ${doc.projectDelivery.error}` }}
          </span>
          <span class="spacer"></span>
          <button v-if="!recording" class="btn sm ghost" @click="repick">改归属</button>
        </div>
      </header>

      <pre v-if="showPayload" class="payload mono">{{ payloadPreview }}</pre>

      <div v-if="doc.speakers?.length" class="speakers">
        <span class="dim small">说话人（点名字可改，改完会同步到逐字稿和推送内容）：</span>
        <input
          v-for="sp in doc.speakers"
          :key="sp.id"
          v-model="sp.label"
          class="input spk"
          :class="{ owner: sp.isOwner }"
          :title="`${sp.segments} 段`"
          @change="renameSpeakers"
        />
      </div>

      <div class="transcript">
        <div v-for="(turn, i) in turns" :key="i" class="turn">
          <div class="who" :class="{ me: turn.speaker === '我' }">{{ turn.speaker }}</div>
          <div class="say">
            <span class="ts mono dim">{{ hhmmss(turn.offsetMs) }}</span>
            {{ turn.text }}
          </div>
        </div>
        <div v-if="!turns.length" class="empty small">还没有内容。说话即可开始记录。</div>
      </div>

      <div class="notes">
        <span class="dim small">备注（会一起推送到 webhook，作为 notes 字段）</span>
        <textarea v-model="doc.notes" class="textarea" rows="3" placeholder="会议背景、参会人、想让 AI 怎么写…" @change="patch({ notes: doc.notes })"></textarea>
      </div>

      <div class="row danger-row">
        <span class="spacer"></span>
        <button class="btn sm danger" :disabled="doc.status === 'recording'" @click="remove">删除这场会议</button>
      </div>
    </section>

    <section v-else class="detail empty-detail">
      <div class="empty">选择左侧的一场会议查看逐字稿。</div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const meetings = ref([])
const selected = ref(null)
const doc = ref(null)
const pushing = ref(false)
const showPayload = ref(false)
const payloadPreview = ref('')
const now = ref(Date.now())

const recording = computed(() => meetings.value.some((m) => m.status === 'recording'))
const charCount = computed(() => (doc.value?.segments || []).reduce((n, s) => n + s.text.length, 0))
const duration = computed(() => {
  if (!doc.value) return ''
  const end = doc.value.endedAt || now.value
  return hhmmss(end - doc.value.startedAt)
})

// Consecutive segments from one speaker read as one turn. The recogniser
// endpoints on breath pauses, so a single sentence often arrives as three
// segments — rendering each with its own name badge turns a conversation into
// a stutter.
const turns = computed(() => {
  const out = []
  for (const s of doc.value?.segments || []) {
    const last = out[out.length - 1]
    if (last && last.speaker === s.speaker) last.text += s.text
    else out.push({ speaker: s.speaker, offsetMs: s.offsetMs, text: s.text })
  }
  return out
})

function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function loadList() {
  meetings.value = await window.kuaishuo.meeting.list({})
  if (!selected.value && meetings.value.length) select(meetings.value[0].id)
}

async function select(id) {
  selected.value = id
  doc.value = await window.kuaishuo.meeting.get(id)
  showPayload.value = false
}

// ---- Choosing what a recording belongs to ------------------------------------
// This is the only place a meeting starts now. It used to be startable from the
// strip, the tray and a hotkey; all three open this page instead, because a
// recording has to be filed before its first sentence and the strip is
// deliberately unfocusable.

const picking = ref(false)
const pickLoading = ref(false)
const pickItems = ref([])
const pickError = ref('')
const pickQuery = ref('')
// null while starting a new meeting; a meeting id when re-filing an old one.
const repickTarget = ref(null)

const pickFiltered = computed(() => {
  const q = pickQuery.value.trim().toLowerCase()
  if (!q) return pickItems.value
  return pickItems.value.filter((it) =>
    it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q) || (it.group || '').toLowerCase().includes(q))
})

/** Preserve first-appearance order rather than sorting: the backend's order is
    usually meaningful (most recent first) and re-sorting throws that away. */
const pickGroups = computed(() => {
  const out = []
  const byName = new Map()
  for (const it of pickFiltered.value) {
    const name = it.group || ''
    if (!byName.has(name)) { const g = { name, items: [] }; byName.set(name, g); out.push(g) }
    byName.get(name).items.push(it)
  }
  return out
})

async function openPicker(target = null) {
  repickTarget.value = target
  picking.value = true
  pickLoading.value = true
  pickQuery.value = ''
  pickItems.value = []
  pickError.value = ''
  try {
    const res = await window.kuaishuo.projects.list()
    pickItems.value = res.items || []
    // reason explains a mapping that matched nothing; error explains a request
    // that never landed. Either way the picker offers "record anyway".
    pickError.value = res.reason || res.error || ''
  } catch (err) {
    pickError.value = err?.message || String(err)
  } finally {
    pickLoading.value = false
  }
}

function cancelPick() {
  // Cancelling means "changed my mind" — no meeting is created. The alternative
  // (record anyway) would quietly produce exactly the unattributable meeting
  // this feature exists to prevent.
  picking.value = false
  repickTarget.value = null
}

async function confirmPick(item) {
  picking.value = false
  const project = item
    ? { projectId: item.projectId, projectName: item.name, projectMeetingId: item.id }
    : { projectId: '', projectName: '', projectMeetingId: '' }

  if (repickTarget.value) {
    // Re-filing an existing meeting. Only changes where the end-of-meeting
    // record goes — sentences already pushed carry what was true at the time.
    const id = repickTarget.value
    repickTarget.value = null
    await window.kuaishuo.meeting.update(id, project)
    await loadList()
    await select(id)
    return
  }

  const d = await window.kuaishuo.meeting.start(project)
  await loadList()
  await select(d.id)
}

function repick() { if (selected.value) openPicker(selected.value) }

async function start() {
  const res = await window.kuaishuo.projects.list()
  // No list endpoint configured is a supported way to run: start immediately
  // and push without a project block.
  if (!res.configured) {
    const d = await window.kuaishuo.meeting.start({})
    await loadList()
    await select(d.id)
    return
  }
  pickItems.value = res.items || []
  pickError.value = res.reason || res.error || ''
  pickQuery.value = ''
  repickTarget.value = null
  pickLoading.value = false
  picking.value = true
}

const livePushLabel = computed(() => {
  const lp = doc.value?.livePush
  if (!lp || (!lp.sent && !lp.failed)) return ''
  return lp.failed ? `实时推送 ${lp.sent} 成功 / ${lp.failed} 失败` : `实时推送 ${lp.sent} 句`
})

async function stop() {
  await window.kuaishuo.meeting.stop()
  await loadList()
  if (selected.value) await select(selected.value)
}

async function patch(p) {
  if (!doc.value) return
  await window.kuaishuo.meeting.update(doc.value.id, p)
  await loadList()
}

async function renameSpeakers() {
  if (!doc.value) return
  doc.value = await window.kuaishuo.meeting.update(doc.value.id, {
    speakers: doc.value.speakers.map(({ id, label }) => ({ id, label })),
  })
}

async function push() {
  if (!doc.value) return
  pushing.value = true
  try {
    const res = await window.kuaishuo.meeting.push(doc.value.id)
    doc.value = await window.kuaishuo.meeting.get(doc.value.id)
    if (!res.ok) alert(`推送失败：${res.error}`)
    await loadList()
  } finally {
    pushing.value = false
  }
}

async function exportAs(format) {
  const r = await window.kuaishuo.meeting.export(doc.value.id, format)
  if (r?.ok) alert(`已导出到\n${r.path}`)
}

async function remove() {
  if (!confirm('删除这场会议的逐字稿？不可恢复。')) return
  await window.kuaishuo.meeting.remove(doc.value.id)
  selected.value = null
  doc.value = null
  await loadList()
}

let unsub = null
let clock = null

onMounted(async () => {
  await loadList()
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  // A meeting in progress has to stream into this view — the whole point of
  // having the console open during a call is watching the transcript build.
  unsub = window.kuaishuo.meeting.onChange(async (e) => {
    if (e?.id && e.id === selected.value) doc.value = await window.kuaishuo.meeting.get(e.id)
    if (e?.started || e?.ended || e?.delivery) await loadList()
    if (e?.started) await select(e.id)
  })
})

onBeforeUnmount(() => { try { unsub?.() } catch {} ; clearInterval(clock) })

// Lazily fetch the exact JSON the webhook will receive. Showing the real
// payload (not a hand-written doc that drifts) is what makes the other side
// codeable against without a round of guessing.
watch(showPayload, async (on) => {
  if (!on || !doc.value) return
  const p = await window.kuaishuo.meeting.preview(doc.value.id)
  payloadPreview.value = JSON.stringify(p, null, 2)
})
</script>

<style scoped>
.view { display: flex; height: 100%; }

.list-pane {
  width: 244px;
  flex: none;
  border-right: 1px solid var(--border-soft);
  padding: 16px 12px;
  overflow: auto;
}
.pane-head { margin-bottom: 12px; padding: 0 4px; }
.pane-head b { font-size: 15px; font-weight: 600; }

/* The project picker. Sits at the top of the list pane rather than floating
   over everything: it is a step in starting a recording, not an interruption,
   and a modal here would have to be dismissed before you could read the list
   of past meetings you were probably checking against. */
.picker {
  margin-bottom: 12px;
  padding: 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.picker .pad { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.plist { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; }
.pgroup { font-size: 11px; letter-spacing: 0.04em; margin: 8px 0 4px; }
.pitem {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  padding: 7px 8px; border: none; border-radius: var(--radius-sm);
  background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.pitem:hover { background: var(--bg-inset); }
.pname { font-size: 13px; }
.small { font-size: 12px; }
.tags { gap: 6px; flex-wrap: wrap; }
.proj { gap: 8px; }
.ok-text { color: var(--accent); }
.bad-text { color: var(--danger); }

.mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mitem {
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid transparent;
  transition: background 0.14s, border-color 0.14s;
}
.mitem:hover { background: var(--bg-raised); }
.mitem.on { background: var(--bg-inset); border-color: var(--border); }
.mtitle { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msub { font-size: 11.5px; }
.rec { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex: none; animation: blink 1.5s infinite; }
@keyframes blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.25 } }

.detail { flex: 1; min-width: 0; overflow: auto; padding: 22px 26px 40px; }
.empty-detail { display: flex; align-items: center; justify-content: center; }

.dhead { margin-bottom: 16px; }
.title { font-size: 17px; font-weight: 600; height: 36px; border-color: transparent; background: transparent; padding-left: 0; }
.title:hover { border-color: var(--border); padding-left: 10px; }
.title:focus { border-color: #3d4a5c; background: var(--bg-inset); padding-left: 10px; }
.dmeta { margin-top: 8px; font-size: 12px; flex-wrap: wrap; }

.delivery { margin-top: 10px; font-size: 12px; padding: 7px 10px; border-radius: var(--radius-sm); }
.delivery.ok  { color: var(--accent); background: var(--accent-dim); }
.delivery.bad { color: var(--danger); background: rgba(239, 68, 68, 0.1); }

.payload {
  max-height: 340px;
  overflow: auto;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: #0a0c10;
  border: 1px solid var(--border-soft);
  font-size: 11.5px;
  line-height: 1.6;
  color: #93c5a8;
  margin: 0 0 16px;
}

.speakers { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.spk { width: 96px; height: 26px; font-size: 12px; text-align: center; }
.spk.owner { color: var(--accent); border-color: rgba(34, 197, 94, 0.3); }

.transcript { display: flex; flex-direction: column; gap: 12px; margin-bottom: 22px; }
.turn { display: flex; gap: 12px; align-items: flex-start; }
.who {
  flex: none;
  width: 76px;
  text-align: right;
  font-size: 12.5px;
  color: var(--text-2);
  padding-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who.me { color: var(--accent); }
.say { flex: 1; line-height: 1.75; word-break: break-word; }
.ts { font-size: 11px; margin-right: 8px; }

.notes { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
.small { font-size: 11.5px; }
.danger-row { padding-top: 10px; border-top: 1px solid var(--border-soft); }
</style>
