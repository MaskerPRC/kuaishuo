import { createApp } from 'vue'
import App from './App.vue'
import { loadSettings } from '../core/settings.js'
import '../styles.css'

loadSettings().finally(() => {
  createApp(App).mount('#app')
})
