<template>
  <canvas ref="canvasEl" class="wave" :style="{ width: w + 'px', height: h + 'px' }"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { drawRibbons } from '../core/voiceRibbon.js'

const props = defineProps({
  // [low, mid, high] band energy 0..1, mutated in place by useDictation and
  // sampled here on rAF. No `type`: Vue reads a typed array's raw type as
  // 'Float32Array' and an Object check would warn on every mount.
  bands: { required: true },
  busy: { type: Boolean, default: false },
  // Wide and short on purpose: a low-amplitude curve needs horizontal room to
  // read as a flowing ribbon. Squeezed shorter, the same curve is a smudge.
  w: { type: Number, default: 196 },
  h: { type: Number, default: 30 },
  color: { type: String, default: '' },
})

const canvasEl = ref(null)
let raf = 0
let dpr = 1
const eased = [0, 0, 0]   // persistent per-band easing state, owned here

function resize(cv) {
  const next = window.devicePixelRatio || 1
  if (cv.width === props.w * next && cv.height === props.h * next) return
  dpr = next
  cv.width = props.w * dpr
  cv.height = props.h * dpr
}

function draw() {
  raf = requestAnimationFrame(draw)
  const cv = canvasEl.value
  if (!cv) return
  resize(cv)
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawRibbons(ctx, {
    w: props.w,
    h: props.h,
    bands: props.bands,
    eased,
    time: performance.now() / 1000,
    // Sampled from CSS so the ribbon inherits whatever colour the state put on
    // the element — muted drains to grey, error goes red — without this file
    // knowing any of those states exist.
    color: props.color || getComputedStyle(cv).getPropertyValue('color').trim() || '#07c160',
    busy: props.busy,
  })
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<style scoped>
.wave {
  display: block;
  color: var(--wave-color, #07c160);
}
</style>
