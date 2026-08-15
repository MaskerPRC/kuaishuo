// Opt-in probe for the one thing no automated test can safely check: whether a
// synthetic Ctrl+V actually lands in another application.
//
//   npm run probe:inject
//
// It types into whatever window has focus, which is why it is a script you run
// deliberately with a countdown rather than part of `npm test`. Open Notepad (or
// a browser address bar, or WeChat) and click into it while it counts down.
//
// Runs under Electron because that's where the clipboard API lives, and because
// running it anywhere else would be testing a different code path than the one
// that ships.

const { app, clipboard } = require('electron')
const inject = require('../electron/inject.cjs')

const SAMPLE = '快说注入测试 · kuaishuo injection probe · 12345'
const COUNTDOWN = 6

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('\n=== 快说 · 注入探针 ===\n')
  console.log(`平台        : ${process.platform}`)
  console.log(`前台窗口    : ${JSON.stringify(inject.foregroundWindowTitle())}`)
  console.log(`按键序列    : ${JSON.stringify(inject.pastePlan())}`)
  console.log(`\n将在 ${COUNTDOWN} 秒后向当前前台窗口粘贴一段文字。`)
  console.log('请现在点进记事本 / 输入框 —— 否则文字会进到你当前正在用的窗口。\n')

  for (let i = COUNTDOWN; i > 0; i--) {
    process.stdout.write(`\r  ${i}… `)
    await sleep(1000)
  }
  process.stdout.write('\r      \r')

  const before = clipboard.readText()
  const target = inject.foregroundWindowTitle()
  console.log(`目标窗口    : ${JSON.stringify(target)}`)

  const res = await inject.sendText(SAMPLE, {
    mode: 'type', enter: false, restoreClipboard: true, appendSpace: false,
  })
  console.log(`结果        : ${JSON.stringify(res)}`)

  // The restore is deliberately delayed inside sendText; wait past it so the
  // check below measures the settled state rather than a race.
  await sleep(1200)
  const after = clipboard.readText()
  console.log(`剪贴板恢复  : ${after === before ? '✔ 已还原' : `✖ 现在是 ${JSON.stringify(after.slice(0, 40))}`}`)

  console.log('\n如果目标窗口里出现了那段文字 —— 注入链路是通的。')
  console.log('如果没有：看上面的 via 字段。user32 表示走了 FFI，powershell 表示 FFI 没加载起来。\n')
  app.quit()
}

app.whenReady().then(() => main().catch((err) => { console.error(err); app.exit(1) }))
