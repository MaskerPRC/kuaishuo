<template>
  <div class="view">
    <header class="head">
      <h1>统计</h1>
      <p class="dim">全部来自本机的历史记录，没有任何数据离开这台电脑。</p>
    </header>

    <div class="tiles">
      <div class="tile card">
        <span class="k">累计说了</span>
        <b class="v tnum">{{ fmtNum(s.total.chars) }}<i>字</i></b>
        <span class="sub dim">{{ fmtNum(s.total.count) }} 句</span>
      </div>
      <div class="tile card">
        <span class="k">语音时长</span>
        <b class="v tnum">{{ fmtDuration(s.total.audioMs) }}</b>
        <span class="sub dim">平均每句 {{ (s.total.count ? s.total.audioMs / s.total.count / 1000 : 0).toFixed(1) }} 秒</span>
      </div>
      <div class="tile card">
        <span class="k">识别速度</span>
        <b class="v tnum">{{ s.avg.realtimeFactor || 0 }}<i>× 实时</i></b>
        <span class="sub dim">平均 {{ s.avg.decodeMs }} ms / 句</span>
      </div>
      <div class="tile card">
        <span class="k">会议</span>
        <b class="v tnum">{{ fmtNum(s.meeting.count) }}<i>段</i></b>
        <span class="sub dim">{{ fmtNum(s.meeting.chars) }} 字逐字稿</span>
      </div>
    </div>

    <!-- One hue throughout, value encoded by height only. Colour here would be
         a second encoding of the same number — decorative, and one more thing
         to get wrong in a colour-blind palette. -->
    <section class="card chart">
      <div class="chart-head row">
        <b>最近 {{ days }} 天</b>
        <span class="spacer"></span>
        <span class="dim small">峰值 {{ fmtNum(peakDay) }} 字/天</span>
        <select v-model.number="days" class="select days" @change="load">
          <option :value="14">14 天</option>
          <option :value="30">30 天</option>
          <option :value="90">90 天</option>
        </select>
      </div>
      <div class="bars" :style="{ '--n': s.series.length }">
        <div
          v-for="d in s.series"
          :key="d.day"
          class="bar-slot"
          :title="`${d.day}　${d.chars} 字 / ${d.count} 句`"
        >
          <div class="bar" :style="{ height: barHeight(d.chars) }"></div>
        </div>
      </div>
      <div class="axis dim small">
        <span>{{ s.series[0]?.day.slice(5) }}</span>
        <span class="spacer"></span>
        <span>{{ s.series[s.series.length - 1]?.day.slice(5) }}</span>
      </div>
    </section>

    <section class="card chart">
      <div class="chart-head row">
        <b>一天里什么时候说得多</b>
        <span class="spacer"></span>
        <span class="dim small">共 {{ fmtNum(s.total.count) }} 句</span>
      </div>
      <div class="bars hours">
        <div v-for="(n, h) in s.byHour" :key="h" class="bar-slot" :title="`${h}:00　${n} 句`">
          <div class="bar" :style="{ height: hourHeight(n) }"></div>
        </div>
      </div>
      <div class="axis dim small hour-axis">
        <span v-for="h in [0, 6, 12, 18, 23]" :key="h">{{ h }}:00</span>
      </div>
    </section>

    <p v-if="s.total.rejected" class="note dim">
      另有 <b>{{ s.total.rejected }}</b> 句被声纹校验挡下，未计入以上统计 —— 那是别人（或电视、视频）的声音。
    </p>
    <p v-if="s.firstAt" class="note dim">第一句记录于 {{ new Date(s.firstAt).toLocaleString('zh-CN', { hour12: false }) }}。</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const days = ref(30)
const s = ref({
  total: { count: 0, chars: 0, words: 0, audioMs: 0, decodeMs: 0, rejected: 0 },
  avg: { charsPerUtterance: 0, decodeMs: 0, realtimeFactor: 0 },
  meeting: { count: 0, chars: 0 },
  series: [],
  byHour: new Array(24).fill(0),
  firstAt: null,
})

const peakDay = computed(() => Math.max(0, ...s.value.series.map((d) => d.chars)))
const peakHour = computed(() => Math.max(0, ...s.value.byHour))

// A floor of 2px so a day with a single sentence is still visibly different
// from a day with none — otherwise "quiet" and "didn't use it" look identical.
function barHeight(v) {
  if (!peakDay.value) return '0px'
  return v === 0 ? '0px' : `${Math.max(2, Math.round((v / peakDay.value) * 100))}%`
}
function hourHeight(v) {
  if (!peakHour.value) return '0px'
  return v === 0 ? '0px' : `${Math.max(2, Math.round((v / peakHour.value) * 100))}%`
}

function fmtNum(n) {
  if (!n) return '0'
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return n.toLocaleString('zh-CN')
}

function fmtDuration(ms) {
  const s2 = Math.round(ms / 1000)
  if (s2 < 60) return `${s2} 秒`
  const m = Math.floor(s2 / 60)
  if (m < 60) return `${m} 分`
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

async function load() {
  s.value = await window.kuaishuo.stats.get({ days: days.value })
}

onMounted(load)
</script>

<style scoped>
.view { padding: 26px 28px 40px; max-width: 980px; }
.head h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; }
.head p { margin: 0 0 18px; font-size: 12.5px; }

.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
.tile { padding: 15px 16px; display: flex; flex-direction: column; gap: 4px; }
.tile .k { font-size: 12px; color: var(--text-3); }
.tile .v { font-size: 24px; font-weight: 600; line-height: 1.25; }
.tile .v i { font-size: 12.5px; font-weight: 400; font-style: normal; color: var(--text-3); margin-left: 3px; }
.tile .sub { font-size: 11.5px; }

.chart { padding: 16px; margin-bottom: 14px; }
.chart-head { margin-bottom: 14px; }
.chart-head b { font-weight: 500; font-size: 13px; }
.days { width: 84px; height: 26px; font-size: 12px; }
.small { font-size: 11.5px; }

.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 120px;
}
.bars.hours { gap: 4px; }
.bar-slot {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  /* The whole column is the hover target, not just the drawn bar — chasing a
     3px-tall rectangle with the cursor to read a tooltip is not interaction. */
  border-radius: 3px;
}
.bar-slot:hover { background: rgba(255, 255, 255, 0.04); }
.bar {
  width: 100%;
  background: linear-gradient(180deg, var(--accent-soft), var(--accent));
  border-radius: 3px 3px 1px 1px;
  min-height: 0;
  transition: height 0.25s ease;
}

.axis { display: flex; margin-top: 8px; }
.hour-axis { justify-content: space-between; }

.note { font-size: 12.5px; line-height: 1.8; margin: 6px 0 0; }
.note b { color: var(--text-2); }
</style>
