// Reactive mirror of the settings file that main owns.
//
// Not localStorage: two renderers (the overlay and the console) have to agree,
// and main needs the same values to decide where text goes and whether to push
// a webhook. One writable copy on disk, a read-only-ish mirror here, and a
// broadcast on every change — so tightening the VAD in the console takes effect
// on the overlay's next sentence with no restart and no reload.

import { ref, readonly } from 'vue'

const state = ref({})
const ready = ref(false)

let loading = null

export function loadSettings() {
  if (loading) return loading
  loading = (async () => {
    state.value = await window.kuaishuo.settings.get()
    ready.value = true
    window.kuaishuo.settings.onChange((next) => { state.value = next })
    return state.value
  })()
  return loading
}

/** Read-only view. Write through updateSettings so main stays the source. */
export function useSettings() {
  return { settings: state, ready: readonly(ready) }
}

export async function updateSettings(patch) {
  // Optimistic: the UI moves now, main confirms in a millisecond. A toggle that
  // waits for a disk write before it visibly flips feels broken.
  state.value = { ...state.value, ...patch }
  state.value = await window.kuaishuo.settings.set(patch)
  return state.value
}

export async function resetSettings() {
  state.value = await window.kuaishuo.settings.reset()
  return state.value
}

/** Snapshot for non-reactive callers (the VAD reads this every frame). */
export function currentSettings() {
  return state.value
}
