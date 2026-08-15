<template>
  <div class="field stack">
    <div class="label">
      <b>请求头（可选）</b>
      <span>{{ hint }}</span>
    </div>
    <div class="hdrs">
      <div v-for="(row, i) in rows" :key="i" class="hdr-row">
        <input
          v-model="row.key" class="input mono" placeholder="Authorization" spellcheck="false"
          @change="emitRows"
        />
        <input
          v-model="row.value" class="input mono" placeholder="Bearer …" spellcheck="false"
          @change="emitRows"
        />
        <button class="btn sm ghost" title="删除这一行" @click="removeRow(i)">×</button>
      </div>
      <button class="btn sm ghost add" @click="addRow">+ 加一行</button>
    </div>
  </div>
</template>

<script setup>
// A key-value editor for custom HTTP headers.
//
// The settings store has held a `webhookHeaders` object since the beginning
// with no way to edit it — fine while the only endpoint was an internal
// automation hook, useless the moment an endpoint needs a bearer token. Shared
// by both new endpoints rather than written twice.
//
// Rows are local state, not a computed over the prop: an object has no
// ordering and no concept of a half-typed key, so editing it directly would
// reorder the list under the cursor and drop any row whose key was momentarily
// blank. The object is rebuilt on change instead.

import { ref, watch } from 'vue'

const props = defineProps({
  model: { type: Object, default: () => ({}) },
  hint: { type: String, default: '' },
})
const emit = defineEmits(['update'])

const rows = ref([])

function load(obj) {
  rows.value = Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value) }))
}
load(props.model)

// Only reload from the prop when it genuinely differs from what these rows
// already represent — otherwise the echo of our own emit resets the cursor.
watch(() => props.model, (next) => {
  if (JSON.stringify(toObject()) !== JSON.stringify(next || {})) load(next)
})

function toObject() {
  const out = {}
  for (const r of rows.value) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
}

function emitRows() { emit('update', toObject()) }
function addRow() { rows.value.push({ key: '', value: '' }) }
function removeRow(i) { rows.value.splice(i, 1); emitRows() }
</script>

<style scoped>
.hdrs { display: flex; flex-direction: column; gap: 6px; }
.hdr-row { display: grid; grid-template-columns: 1fr 1.6fr auto; gap: 6px; }
.add { align-self: flex-start; }
</style>
