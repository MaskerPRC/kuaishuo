// UI end-to-end, driven through the real DOM.
//
//   npm run e2e:ui
//
// Launched by main.cjs when KUAISHUO_E2E is set, so what it drives is the
// actual application: the real overlay window (non-focusable, above the
// taskbar), the real console, the real preload bridge, the real store on disk.
// Assertions go through webContents.executeJavaScript — querySelector, click,
// read back — because "the button exists and clicking it changes the setting"
// is a fact about the DOM, and a screenshot can only ever be a guess at it.
//
// No Playwright, no driver, no extra dependency. Electron already owns these
// windows; asking them questions is one method call.

const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}

function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }
/** Context that isn't a pass/fail — measurements worth seeing in the log. */
function info(label, value) { console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Resolve once a window has painted its Vue tree, not merely loaded its HTML. */
async function ready(wc, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r))
  while (Date.now() < deadline) {
    const hit = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (hit) return true
    await sleep(120)
  }
  return false
}

// A probe that throws (a null querySelector, usually) means the assertion
// fails — not that the whole run stops. Swallowing it here keeps one missing
// element from hiding the twenty checks after it.
async function $(wc, expr) {
  try {
    return await wc.executeJavaScript(expr)
  } catch (err) {
    return { __error: err.message || String(err) }
  }
}

/** Click through the DOM and give Vue a tick to re-render. */
async function click(wc, selector) {
  const ok = await $(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
  await sleep(160)
  return ok
}

const text = (wc, selector) =>
  $(wc, `(document.querySelector(${JSON.stringify(selector)})?.textContent || '').trim()`)

const count = (wc, selector) =>
  $(wc, `document.querySelectorAll(${JSON.stringify(selector)}).length`)

const exists = async (wc, selector) => (await count(wc, selector)) > 0

/**
 * Poll until a probe satisfies `ok`, then return its last value.
 *
 * Anything that crosses IPC and comes back through a debounce (the search box)
 * or a broadcast (live history append) has no fixed settle time — it depends on
 * what else the machine is doing. A `sleep(420)` passes on a quiet run and
 * fails on a busy one, and a test that fails at random teaches you to ignore
 * it, which is worse than not having written it.
 */
async function until(probe, ok, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await probe()
    if (ok(last)) return last
    if (Date.now() >= deadline) return last
    await sleep(80)
  }
}

async function run({ overlay, getConsole, store, pipeline, createConsole }) {
  console.log('\n=== 快说 · UI harness (真实 DOM) ===')

  // ── Overlay ───────────────────────────────────────────────────────────────
  stage('1. 悬浮条')

  const ow = overlay.get()
  check('悬浮窗已创建', !!ow)
  if (!ow) return 1

  const owc = ow.webContents
  check('悬浮条渲染完成', await ready(owc, '.glass'))

  check('不可获得焦点（输入法的前提）', ow.isFocusable() === false, `isFocusable=${ow.isFocusable()}`)
  check('置顶', ow.isAlwaysOnTop() === true)
  check('不在任务栏占位', ow.isVisible() === true)
  check('窗口本身透明（不是一块底板）', ow.isVisible() && ow.getBackgroundColor().toLowerCase().startsWith('#00'),
    ow.getBackgroundColor())

  // Where it sits. Measured against the CAPSULE, not the window: the window's
  // bottom band is transparent on purpose — it is where the capsule's drop
  // shadow fades out, and it deliberately overhangs the taskbar so the visible
  // strip can sit close to it without the shadow being clipped into a hard
  // line. Asserting on window bounds would be asserting on empty air.
  const { screen } = require('electron')
  const bounds = ow.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const glassRect = await $(owc, `(() => { const r = document.querySelector('.glass').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } })()`)
  const capsuleGap = (area.y + area.height) - (bounds.y + glassRect.bottom)
  // Roughly a third of the capsule's own height: close enough to read as
  // belonging to the taskbar, far enough not to look welded to it.
  check('胶囊贴近任务栏（约 1/3 条高）', capsuleGap >= 8 && capsuleGap <= 24,
    `胶囊下沿距任务栏 ${Math.round(capsuleGap)}px，条高 ${Math.round(glassRect.height)}px`)
  check('窗口没有过度盖住任务栏',
    (bounds.y + bounds.height) - (area.y + area.height) <= 12,
    `越过工作区 ${(bounds.y + bounds.height) - (area.y + area.height)}px`)
  check('水平居中', Math.abs((bounds.x + bounds.width / 2) - (area.x + area.width / 2)) < 4,
    `窗口中心 ${bounds.x + bounds.width / 2}，屏幕中心 ${area.x + area.width / 2}`)

  // No start button at all: the strip is a display, and beginning to talk is a
  // hotkey. Hunting for a button with a mouse is the slowest way to start a
  // sentence, and by the time you have found it the sentence is gone.
  check('左侧没有开始按钮了', !(await exists(owc, '.dot')))
  check('有波形画布', await exists(owc, '.glass canvas.wave'))
  check('右侧正好两个按钮', (await count(owc, '.acts .act')) === 2, `${await count(owc, '.acts .act')} 个`)
  check('第一个是暂停', await exists(owc, '.acts .act:first-child svg'))
  check('第二个是会议', await exists(owc, '.acts .act.meeting'))
  check('有输出方式切换（文字，不是按钮块）', await exists(owc, '.glass .mode'))

  // Click-through hit testing. The window ignores the mouse everywhere except
  // where something is painted, and it asks for the mouse back from a
  // mousemove handler. Two ways that goes wrong and both are invisible to
  // el.click(): a painted control the handler doesn't know about is dead, and
  // a claimed region with nothing in it is a hole punched through the user's
  // documents. This drives the same geometry a real cursor does.
  const hitAt = async (sel) => {
    const p = await $(owc, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) return null
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    await sleep(120)
    return p
  }

  check('光标在胶囊上时窗口接管鼠标', !!(await hitAt('.glass')) && overlay.isInteractive() === true,
    `isInteractive=${overlay.isInteractive()}`)

  // Nothing above the capsule is clickable any more — the hover links are
  // gone and the line holds only the toast. Claiming that band would swallow
  // clicks aimed at the window underneath for as long as a toast is up.
  check('胶囊上方没有悬停链接了', !(await exists(owc, '.above .links')))
  const toastBand = await $(owc, `(() => { const r = document.querySelector('.above').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await $(owc, `(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: ${toastBand.x}, clientY: ${toastBand.y} })); return true })()`)
  await sleep(120)
  check('提示行不抢鼠标', overlay.isInteractive() === false, `isInteractive=${overlay.isInteractive()}`)

  // And the empty air around the capsule must still fall through, or the strip
  // becomes a dead band across the user's documents.
  await $(owc, `(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 4, clientY: 4 })); return true })()`)
  await sleep(120)
  check('空白处仍然点得穿', overlay.isInteractive() === false, `isInteractive=${overlay.isInteractive()}`)

  // The canvas has to be a real, sized drawing surface — a 0×0 canvas renders
  // nothing and looks identical to "the waveform is idle".
  const canvas = await $(owc, `(() => { const c = document.querySelector('canvas.wave'); return c ? { w: c.width, h: c.height } : null })()`)
  check('波形画布有实际像素', !!canvas && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas))

  // The ribbon is the resting state, not a thing that appears once you start:
  // a strip with nothing moving on it reads as broken.
  check('未开始时波形仍在（呼吸态）', await exists(owc, 'canvas.wave'))
  check('未开始时不显示状态文字', !(await exists(owc, '.glass .status')))

  // The whole point of the redesign: no frame anywhere. Anything with a visible
  // border or a solid background would put a box back on the screen, which is
  // exactly what a floating strip must not have.
  const chrome = await $(owc, `(() => {
    const bad = []
    // The bar itself is meant to be a solid, shaped surface — that is the
    // fix, not the bug. Everything *else* still has to be chrome-free.
    for (const el of document.querySelectorAll('.root, .root *')) {
      if (el.classList.contains('glass') || el.classList.contains('toast') || el.classList.contains('links')) continue
      const cs = getComputedStyle(el)
      const w = ['Top','Right','Bottom','Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0)
      if (w && cs.borderTopStyle !== 'none') bad.push('border:' + (el.className || el.tagName))
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) bad.push('outline:' + (el.className || el.tagName))
      // A flat solid fill on anything of real size is a plate; the haze uses
      // gradients that reach zero alpha, which is what keeps it edgeless.
      // Indicator dots (the status dot, the recording dot) are supposed to be
      // solid — they're marks, not surfaces — so anything this small is exempt.
      const r = el.getBoundingClientRect()
      if (Math.max(r.width, r.height) > 14) {
        const bg = cs.backgroundColor
        const m = bg.match(/rgba?\\(([^)]+)\\)/)
        if (m) {
          const parts = m[1].split(',').map(s => parseFloat(s))
          const alpha = parts.length > 3 ? parts[3] : 1
          if (alpha > 0.02) bad.push('solid-bg:' + (el.className || el.tagName) + '=' + bg + ' @' + Math.round(r.width) + 'x' + Math.round(r.height))
        }
      }
    }
    return bad
  })()`)
  check('整条没有任何边框 / 描边 / 实色底板', Array.isArray(chrome) && chrome.length === 0, JSON.stringify(chrome))

  // …and again after a hover, which used to reveal two extra <button>s. They
  // are gone now (both actions live in the tray), so this doubles as the check
  // that hovering reveals nothing at all — and it still inspects every button
  // that IS on screen, because the original bug here was hover-only controls
  // shipping in the platform's default grey slab chrome with nothing noticing.
  await $(owc, `document.querySelector('.root').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`)
  await sleep(260)
  const revealed = await $(owc, `(() => ({
    links: document.querySelectorAll('.above .link').length,
    bad: [...document.querySelectorAll('.root button')].filter(el => {
      const cs = getComputedStyle(el)
      const bordered = ['Top','Right','Bottom','Left'].some(s => parseFloat(cs['border' + s + 'Width']) > 0) && cs.borderTopStyle !== 'none'
      const m = cs.backgroundColor.match(/rgba?\\(([^)]+)\\)/)
      const parts = m ? m[1].split(',').map(Number) : []
      const alpha = parts.length > 3 ? parts[3] : (m ? 1 : 0)
      const r = el.getBoundingClientRect()
      return bordered || (alpha > 0.02 && Math.max(r.width, r.height) > 14)
    }).map(el => (el.className || el.tagName) + ':' + getComputedStyle(el).backgroundColor),
  }))()`)
  check('悬停不再变出任何东西，且条上的按钮都不是原生控件',
    revealed?.links === 0 && revealed.bad.length === 0, JSON.stringify(revealed))
  await $(owc, `document.querySelector('.root').dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))`)
  await sleep(200)

  stage('1b. 表面：有形状、不透明、不变色')

  const surface = await $(owc, `(() => {
    const bar = document.querySelector('.glass')
    const cs = getComputedStyle(bar)
    const r = bar.getBoundingClientRect()
    // Outer shadow layers only — insets cannot paint outside the element.
    const outer = cs.boxShadow.split(',').filter(s => !s.includes('inset')).join(',')
    const nums = (outer.match(/-?[0-9.]+px/g) || []).map(parseFloat).map(Math.abs)
    return {
      radius: parseFloat(cs.borderTopLeftRadius),
      height: Math.round(r.height),
      borderWidth: parseFloat(cs.borderTopWidth),
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      alpha: (() => {
        const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/)
        if (!m) return 1
        const parts = m[1].split(',').map(Number)
        return parts.length > 3 ? parts[3] : 1
      })(),
      maxShadowPx: nums.length ? Math.max(...nums) : 0,
      hasInsetHighlight: cs.boxShadow.includes('inset'),
      hasPane: !!document.querySelector('.pane'),
      imgTags: document.querySelectorAll('img').length,
      svgFilters: document.querySelectorAll('svg filter').length,
      backdropFilter: cs.backdropFilter || 'none',
      usesStateColour: cs.backgroundImage.includes('var(--glow') || cs.backgroundImage.includes('color-mix'),
    }
  })()`)
  info('表面', JSON.stringify(surface))

  // It has a shape now. Three rounds of "no border" ended with no shape at all
  // — a soft gradient that read as a smear over a light document.
  check('是个真正的圆角形状', surface?.radius >= 10, `radius=${surface?.radius}`)
  check('圆角是全圆的（药丸，不是圆角方块）',
    surface?.radius >= surface?.height / 2 - 1, `radius=${surface?.radius} height=${surface?.height}`)
  check('实心填充，不是渐变', surface?.bgImage === 'none' && surface?.bg !== 'rgba(0, 0, 0, 0)',
    `${surface?.bg} / ${surface?.bgImage}`)
  check('完全不透明（背后的东西透不过来，所以不会变色）',
    surface?.alpha >= 0.98, `alpha=${surface?.alpha}`)
  check('背景不引用任何状态色', surface?.usesStateColour === false)
  check('没有 1px 描边', surface?.borderWidth === 0)
  check('有顶边内高光（不是一圈边框）', surface?.hasInsetHighlight === true)
  check('外阴影克制（≤24px）', surface?.maxShadowPx <= 24, `${surface?.maxShadowPx}px`)

  // The screen capture is gone from the wiring, not merely unused: a channel
  // left in place is one call away from pinning a core again.
  check('没有桌面截图层', surface?.hasPane === false && surface?.imgTags === 0,
    `pane=${surface?.hasPane} img=${surface?.imgTags}`)
  check('没有残留的 SVG 滤镜', surface?.svgFilters === 0, `还有 ${surface?.svgFilters} 个`)
  check('没有 backdrop-filter（透明窗口里它本来也采样不到东西）',
    surface?.backdropFilter === 'none', surface?.backdropFilter)

  const wiring = await $(owc, `(() => ({
    reportGlassRect: typeof window.kuaishuo.overlay.reportGlassRect,
    onBackdrop: typeof window.kuaishuo.overlay.onBackdrop,
  }))()`)
  check('截屏的 IPC 通道已从桥里删掉',
    wiring?.reportGlassRect === 'undefined' && wiring?.onBackdrop === 'undefined',
    JSON.stringify(wiring))

  const green = await $(owc, `(() => {
    const root = document.querySelector('.root')
    const accent = getComputedStyle(root).getPropertyValue('--accent').trim()
    // The ribbon reads its colour from the same value, so check the canvas is
    // being handed it rather than trusting the variable alone.
    return { accent, wave: document.querySelector('canvas.wave')?.getAttribute('style') || '' }
  })()`)
  check('主色是微信绿 #07c160', green?.accent.toLowerCase() === '#07c160', JSON.stringify(green))

  const fit = await $(owc, `(() => {
    const g = document.querySelector('.glass').getBoundingClientRect()
    return {
      noScroll: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
      slack: Math.round(innerWidth - g.width),
      gapBelow: Math.round(innerHeight - g.bottom),
    }
  })()`)
  check('内容没有溢出窗口', fit?.noScroll === true, JSON.stringify(fit))
  check('胶囊两侧留有余量', fit?.slack >= 60, JSON.stringify(fit))
  check('胶囊下方留出了发光空间', fit?.gapBelow >= 18, JSON.stringify(fit))

  stage('2. 输出方式：点一下，设置真的变了')

  const startMode = store.getSettings().outputMode
  const labelBefore = await text(owc, '.mode')
  check('初始文案与设置一致',
    labelBefore === { type: '直接输入', clipboard: '剪贴板', none: '仅记录' }[startMode],
    `设置=${startMode} 文案=${labelBefore}`)

  await click(owc, '.mode')
  const afterMode = store.getSettings().outputMode
  check('点击后主进程的设置已改变', afterMode !== startMode, `${startMode} → ${afterMode}`)
  const labelAfter = await text(owc, '.mode')
  check('文案跟着变了', labelAfter !== labelBefore, `${labelBefore} → ${labelAfter}`)

  // Cycle back so the rest of the run starts from a known state.
  for (let i = 0; i < 2 && store.getSettings().outputMode !== startMode; i++) {
    await click(owc, '.mode')
  }
  check('循环三次回到起点', store.getSettings().outputMode === startMode)

  check('未开始听写时暂停按钮是禁用的',
    await $(owc, `document.querySelector('.acts .act')?.disabled === true`))

  stage('3. 会议模式：悬浮条 ↔ 主进程状态同步')

  // The strip reports on a meeting; it no longer starts one. A recording has to
  // be filed under a project first, and picking one needs a window that can
  // take focus — which this one deliberately is not. So the glyph raises the
  // console, and the meeting itself starts from there.
  await click(owc, '.acts .act.meeting')
  await sleep(500)
  check('点会议按钮不会直接开会', store.listMeetings({ limit: 1 }).length === 0,
    JSON.stringify(store.listMeetings({ limit: 1 })))
  {
    const w = getConsole()
    check('点会议按钮唤起了控制台', !!w && !w.isDestroyed())
    if (w && !w.isDestroyed()) {
      const tab = await until(
        () => w.webContents.executeJavaScript(`(document.querySelector('.tab.on')?.textContent || '').trim()`),
        (t) => t && t.includes('会议'),
      )
      check('并且落在会议页', !!tab && tab.includes('会议'), String(tab))
    }
  }

  // Start it the way a person now would, then check the strip mirrors it.
  const meeting = pipeline.startMeeting({ projectId: 'p-harness', projectName: '探针项目' })
  const meetingId = meeting?.id
  await sleep(400)
  check('会议已在主进程建立', !!meetingId, JSON.stringify(store.listMeetings({ limit: 1 })))
  check('会议带上了所属项目', store.getMeeting(meetingId)?.projectId === 'p-harness')
  check('会议按钮进入录制态', await exists(owc, '.acts .act.meeting.is-on'))
  check('有红色录制指示点', await exists(owc, '.acts .act.meeting .rec'))
  // 同一个位置按优先级三选一：模型进度 > 会议计时器 > 输出方式。
  // "还不能转写"压过"正在录音"，"正在录音、不会打进你的文档"压过"下一句去哪"。
  const slot = await $(owc, `(() => ({
    note: (document.querySelector('.note')?.textContent || '').trim(),
    timer: (document.querySelector('.timer')?.textContent || '').trim(),
    mode: (document.querySelector('.mode')?.textContent || '').trim(),
  }))()`)
  if (slot.note) {
    // 这台机器上没装模型，下载优先级更高 —— 依然是正确行为，但看不到计时器。
    check('模型未就绪时进度优先于计时器', /%$/.test(slot.note), JSON.stringify(slot))
  } else {
    check('计时器顶替了输出方式', /^\d{2}:\d{2}/.test(slot.timer), JSON.stringify(slot))
  }
  check('会议中不再显示输出方式', !(await exists(owc, '.glass .mode')))

  // A meeting must be able to take segments while the UI is live.
  const seg = store.addSegment(meetingId, { text: 'harness 写入的一段', speaker: '我', durationMs: 1200 })
  check('会议可写入段落', seg.i === 0)

  pipeline.stopMeeting()
  await sleep(400)
  check('结束会议', store.getMeeting(meetingId).status === 'ended')
  check('会议按钮回到常态', !(await exists(owc, '.acts .act.meeting.is-on')))
  const back = await until(
    () => $(owc, `(() => ({ timer: !!document.querySelector('.timer'), mode: !!document.querySelector('.glass .mode'), note: !!document.querySelector('.note') }))()`),
    (s) => s && !s.timer && (s.mode || s.note),
  )
  check('计时器消失，输出方式回来', back && !back.timer && (back.mode || back.note), JSON.stringify(back))

  // ── Console ───────────────────────────────────────────────────────────────
  stage('4. 控制台：四个页签都能渲染')

  // Nothing below may reach the real keyboard, so the output mode goes to
  // 'none' first — inject.sendText returns before it ever touches the clipboard
  // in that mode.
  store.setSettings({ outputMode: 'none' })

  // Seed enough history that the views have something real to draw. Written
  // directly, then the console is reloaded — this is the "open the app and see
  // what you said yesterday" path, as opposed to the live-append path checked
  // further down.
  const now = Date.now()
  store.addHistory({ text: 'harness 写入的第一句', at: now - 60000, durationMs: 1500, decodeMs: 90, output: 'type' })
  store.addHistory({ text: '第二句，用来验证搜索', at: now - 30000, durationMs: 1200, decodeMs: 70, output: 'clipboard' })
  store.addHistory({ text: '被声纹挡下的一句', at: now - 20000, rejected: true })

  let cw = getConsole()
  if (!cw || cw.isDestroyed()) { createConsole(); await sleep(600); cw = getConsole() }
  check('控制台窗口存在', !!cw)
  if (!cw) return 1
  const cwc = cw.webContents
  cwc.reload()
  check('控制台渲染完成', await ready(cwc, '.shell'))
  check('侧边栏有四个页签', (await count(cwc, '.tab')) === 4)

  stage('5. 历史')
  check('历史列表有内容', await ready(cwc, '.list .item'), `${await count(cwc, '.list .item')} 行`)
  check('三条都在', (await count(cwc, '.list .item')) === 3, `${await count(cwc, '.list .item')} 行`)
  check('最新的一条在最上面', (await text(cwc, '.list .item:first-child .text')).includes('被声纹挡下'))
  check('被拒绝的那条有标记', await exists(cwc, '.list .item.rejected'))
  // State is a dot with a tooltip now, not a coloured chip per row — forty
  // chips down a page was forty repetitions of the same four words.
  check('每行都有状态点', (await count(cwc, '.list .item .dot')) === (await count(cwc, '.list .item')))
  check('「已输入」是绿点', (await $(cwc, `!!document.querySelector('.list .item .dot.ok')`)) === true)
  check('状态的文字在 tooltip 里', (await $(cwc, `[...document.querySelectorAll('.list .item .dot')].some(d => (d.title || '').includes('已输入到光标处'))`)) === true)
  // The row has to be one line — the previous version was 112px tall for a
  // single short sentence, so a screenful showed six things you had said.
  check('一行一条（行高 ≤ 44px）',
    (await $(cwc, `Math.round(document.querySelector('.list .item').getBoundingClientRect().height)`)) <= 44,
    `${await $(cwc, `Math.round(document.querySelector('.list .item').getBoundingClientRect().height)`)}px`)

  // Live append: a sentence committed through the real pipeline has to show up
  // in an already-open console without a refresh. The console is usually on a
  // second screen while dictation happens elsewhere, so a list that needs a
  // manual reload to show what you just said reads as broken.
  await pipeline.commit({ text: '这句是实时追加进来的', durationMs: 1100, decodeMs: 60 })
  const appended = await until(
    () => text(cwc, '.list .item:first-child .text'),
    (t) => typeof t === 'string' && t.includes('实时追加'),
  )
  check('新识别的句子实时出现在列表顶部', String(appended).includes('实时追加'), String(appended))
  check('列表计数同步更新', (await count(cwc, '.list .item')) === 4)

  // Search is the one interaction here that goes back through IPC.
  await $(cwc, `(() => { const el = document.querySelector('.search'); el.value = '验证搜索'; el.dispatchEvent(new Event('input')); return true })()`)
  const filtered = await until(() => count(cwc, '.list .item'), (n) => n === 1)
  check('搜索能过滤', filtered === 1, `${filtered} 行`)

  await $(cwc, `(() => { const el = document.querySelector('.search'); el.value = ''; el.dispatchEvent(new Event('input')); return true })()`)
  const restored = await until(() => count(cwc, '.list .item'), (n) => n === 4)
  check('清空搜索后恢复', restored === 4, `${restored} 行`)

  stage('6. 统计')
  await click(cwc, '.tab:nth-child(2)')
  check('切到了统计页', await ready(cwc, '.tiles'))
  check('四张数字卡', (await count(cwc, '.tile')) === 4)
  check('累计字数不为零', !(await text(cwc, '.tile:first-child .v')).startsWith('0'),
    await text(cwc, '.tile:first-child .v'))
  // `.bars` matches the hours chart too — it carries both classes — so the
  // daily chart has to be selected by excluding it, or the count comes back 54.
  check('按天的柱子画出来了', (await count(cwc, '.bars:not(.hours) .bar-slot')) === 30,
    `${await count(cwc, '.bars:not(.hours) .bar-slot')} 根`)
  check('二十四小时分布画出来了', (await count(cwc, '.bars.hours .bar-slot')) === 24)
  check('至少有一根柱子有高度',
    await $(cwc, `[...document.querySelectorAll('.bars .bar')].some(b => parseFloat(b.style.height) > 0)`))
  check('声纹拦截数被单独说明', (await text(cwc, '.note')).includes('声纹'))

  stage('7. 会议')
  await click(cwc, '.tab:nth-child(3)')
  check('切到了会议页', await ready(cwc, '.list-pane'))
  check('列表里有刚才那场会', (await count(cwc, '.mitem')) >= 1)
  check('逐字稿渲染出来了', await ready(cwc, '.transcript .turn'))
  check('段落文字正确', (await text(cwc, '.transcript .turn .say')).includes('harness 写入的一段'))
  check('说话人显示为「我」', (await text(cwc, '.transcript .turn .who')) === '我')

  // The payload preview is the documented contract; it has to be the real thing.
  await click(cwc, '.dmeta .btn.ghost')
  check('能看到真实推送格式', await ready(cwc, '.payload'))
  const payloadText = await text(cwc, '.payload')
  check('预览里是 meeting.completed', payloadText.includes('"event": "meeting.completed"'))
  check('预览里有 specVersion', payloadText.includes('"specVersion": "1.0"'))
  check('预览里带逐字段落', payloadText.includes('"segments"'))

  stage('8. 设置')
  await click(cwc, '.tab:nth-child(4)')
  check('切到了设置页', await ready(cwc, '.switch'))
  check('有多个分组', (await count(cwc, '.section-title')) >= 6)
  check('有开关', (await count(cwc, '.switch')) >= 8)
  check('有五个快捷键（临时/一直/会议/暂停/控制台）', (await count(cwc, '.hotkey')) === 5,
    `${await count(cwc, '.hotkey')} 个`)
  check('第一个快捷键是「临时录音」并显示当前值',
    (await text(cwc, '.hotkey')) === store.getSettings().hotkeyPushToTalk,
    `显示 ${await text(cwc, '.hotkey')}，设置里是 ${store.getSettings().hotkeyPushToTalk}`)

  // A switch has to write through to disk, not just flip a local ref.
  const before = store.getSettings().restoreClipboard
  await click(cwc, '.card .field:nth-child(2) .switch')
  await sleep(280)
  check('拨动开关会写回主进程', store.getSettings().restoreClipboard !== before,
    `${before} → ${store.getSettings().restoreClipboard}`)

  // ---- Hotkeys are the only way to start now -------------------------------
  // With no start button on the strip, an accelerator that silently failed to
  // register would leave no way at all to begin talking. globalShortcut.register
  // returns false when another application already owns the combination, and
  // nothing in the UI would show it.
  stage('9. 三个启动快捷键真的注册上了')
  {
    const { globalShortcut } = require('electron')
    const s = store.getSettings()
    const wanted = [
      ['临时录音（按住说）', s.hotkeyPushToTalk],
      ['一直录音（开关）',   s.hotkeyToggle],
      ['会议录音',           s.hotkeyMeeting],
      ['暂停 / 恢复',        s.hotkeyMute],
      ['打开控制台',         s.hotkeyPanel],
    ]
    // Global shortcuts are exclusive OS-wide, and the harness runs on a
    // throwaway profile — which means Electron's single-instance lock does NOT
    // stop it starting alongside a normal 快说 that is already running. That
    // one holds the keys, and every check here fails for a reason that has
    // nothing to do with the code. Say so, rather than sending someone hunting.
    const rival = require('child_process')
    let othersRunning = false
    try {
      othersRunning = rival.execSync(
        'powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*kuaishuo*\' -and $_.ProcessId -ne ' + process.pid + ' } | Where-Object { $_.Name -notlike \'*bash*\' -and $_.Name -notlike \'*powershell*\' -and $_.Name -notlike \'*node*\' }).Count"',
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      ).trim() !== '0'
    } catch { /* the hint is a nicety; never fail the run over it */ }

    for (const [label, accel] of wanted) {
      const ok = !!accel && globalShortcut.isRegistered(accel)
      if (!ok && othersRunning) {
        info(`${label}：${accel}`, '跳过 —— 另一个快说实例正在运行并占着这个组合键')
        continue
      }
      check(`${label}：${accel}`, ok,
        accel ? '注册失败 —— 多半是被其它程序占用了' : '没有配置')
    }
    const combos = wanted.map(([, a]) => a)
    check('五个组合键互不重复', new Set(combos).size === combos.length, combos.join(' / '))

    // The push-to-talk key has to resolve to a virtual-key code, or the release
    // can never be observed and holding it would record forever.
    const { acceleratorToVk } = require('../electron/hotkeys.cjs')
    check('按住说话的键能解析出 VK 码（否则松手检测不到）',
      acceleratorToVk(s.hotkeyPushToTalk) != null,
      `${s.hotkeyPushToTalk} → ${acceleratorToVk(s.hotkeyPushToTalk)}`)
  }

  // ---- The bottom-gap setting ------------------------------------------------
  // Measured against the capsule, not the window: the window's bottom band is
  // transparent room for the shadow, so a check against the window edge would
  // pass while the visible strip sits 22px away from where it was asked to be.
  stage('10. 距任务栏高度可调')
  {
    const { screen } = require('electron')
    const ow2 = overlay.get()
    const SHADOW_ROOM = overlay.SHADOW_ROOM

    const capsuleBottomGap = () => {
      const b = ow2.getBounds()
      const area = screen.getDisplayMatching(b).workArea
      return (area.y + area.height) - (b.y + b.height - SHADOW_ROOM)
    }

    const before = store.getSettings().overlayBottomGap
    for (const want of [15, 60, 4]) {
      await cwc.executeJavaScript(`window.kuaishuo.settings.set({ overlayBottomGap: ${want} })`)
      const got = await until(async () => capsuleBottomGap(), (g) => Math.abs(g - want) <= 1, 3000)
      check(`设为 ${want}px 时条子真的移到了那里`, Math.abs(got - want) <= 1, `实际 ${got}px`)
    }
    await cwc.executeJavaScript(`window.kuaishuo.settings.set({ overlayBottomGap: ${before} })`)

    check('设置页有这个滑块', await exists(cwc, `input[type=range]`))
  }

  check('声纹未登记时开关是禁用的',
    await $(cwc, `[...document.querySelectorAll('.switch')].some(s => s.disabled)`))

  // ── Done ──────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length ? '\x1b[31m' : '\x1b[32m'}${results.length - failed.length}/${results.length} 通过\x1b[0m`)
  if (failed.length) console.log('失败：\n' + failed.map((f) => `  · ${f.label}`).join('\n'))
  return failed.length ? 1 : 0
}

module.exports = { run }
