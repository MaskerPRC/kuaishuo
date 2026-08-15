import { createApp } from 'vue'
import Overlay from './Overlay.vue'
import { loadSettings } from '../core/settings.js'

// Settings before mount: the strip reads output mode and mute state on its
// first paint, and a frame of wrong state on a window that lives above every
// other window is more noticeable than a frame of nothing.
loadSettings().finally(() => {
  createApp(Overlay).mount('#overlay')
})
