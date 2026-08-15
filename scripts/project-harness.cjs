// Project binding, end to end, against a fake backend this script runs itself.
//
//   npm run probe:project
//
// The unit tests cover the mapping rules and the sender. What they cannot cover
// is the part that only exists inside Electron: the IPC handlers, main's wiring
// of pipeline.onMeeting into the live sender, and whether the settings a person
// types actually reach the request. Those are also where this feature is most
// likely to be quietly broken — a whitelist that drops projectId leaves
// everything looking fine right up until the backend gets an anonymous meeting.
//
// The backend is in-process on a random port so the probe needs no setup and
// leaves nothing running.

const http = require('http')

const results = []

function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${!ok && detail ? `\n      ${detail}` : ''}`)
}
function info(label, value) { console.log(`  \x1b[2m·\x1b[0m ${label}: ${value}`) }
function stage(name) { console.log(`\n\x1b[1m${name}\x1b[0m`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A backend shaped like a real one: the list is nested three deep. */
function startFakeBackend() {
  const received = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/meetings')) {
        // Deliberately awkward: wrapped in code/data/list, the id is not `id`,
        // and the project hangs off a nested object. If the mapping config can
        // handle this it can handle most things.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          code: 0,
          data: {
            list: [
              { meetingId: 'm1', meetingName: '周会', project: { id: 'p1', name: '快说' } },
              { meetingId: 'm2', meetingName: '技术评审', project: { id: 'p2', name: '另一个项目' } },
            ],
          },
        }))
        return
      }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try { received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch {}
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, received, base: `http://127.0.0.1:${port}` })
    })
  })
}

async function run({ store, pipeline, getConsole, createConsole }) {
  console.log('\n=== 快说 · 会议归属链路诊断 ===')
  const backend = await startFakeBackend()
  info('假后端', backend.base)

  try {
    stage('1. 配置两个接口')
    store.setSettings({
      projectsEnabled: true,
      projectsUrl: `${backend.base}/api/meetings`,
      projectsHeaders: { Authorization: 'Bearer probe-token' },
      projectsItemsPath: 'data.list',
      projectsIdField: 'meetingId',
      projectsNameField: 'meetingName',
      projectsProjectIdField: 'project.id',
      projectsGroupField: 'project.name',
      projectPushEnabled: true,
      projectPushUrl: `${backend.base}/api/ingest`,
      projectPushSecret: 'sh4red',
      projectPushSegments: true,
      projectPushOnEnd: true,
      outputMode: 'none',   // nothing here may reach the real keyboard
    })
    check('设置已写回', store.getSettings().projectsUrl.includes('/api/meetings'))

    // ── The console is where a meeting starts now, so it has to be up ────────
    stage('2. 控制台能拿到会议列表')
    let cw = getConsole()
    if (!cw || cw.isDestroyed()) { createConsole(); await sleep(800); cw = getConsole() }
    if (!cw) { check('控制台窗口存在', false); return finish(backend) }
    if (cw.webContents.isLoading()) await new Promise((r) => cw.webContents.once('did-finish-load', r))

    const listed = await cw.webContents.executeJavaScript('window.kuaishuo.projects.list()')
    check('列表接口被调用且解析成功', listed.ok === true, JSON.stringify(listed).slice(0, 300))
    check('configured 为 true', listed.configured === true)
    check('解析出两条', listed.items?.length === 2, JSON.stringify(listed.items))
    if (listed.items?.length) {
      const it = listed.items[0]
      check('嵌套的 project.id 被取到', it.projectId === 'p1', JSON.stringify(it))
      check('名称来自 meetingName', it.name === '周会', JSON.stringify(it))
      check('分组来自 project.name', it.group === '快说', JSON.stringify(it))
    }

    // ── Discovery ────────────────────────────────────────────────────────────
    stage('2b. 不填映射，靠「测试拉取」自己认出结构')
    // Nobody should have to read their own API's JSON by eye and transcribe
    // data.list / project.id into text boxes. Wipe the mapping and check the
    // response alone is enough to rebuild it.
    store.setSettings({
      projectsItemsPath: '', projectsIdField: 'id', projectsNameField: 'name',
      projectsProjectIdField: '', projectsGroupField: '',
    })
    const shape = await cw.webContents.executeJavaScript('window.kuaishuo.projects.test({})')
    check('找到了可选的数组', Array.isArray(shape.arrays) && shape.arrays.length > 0,
      JSON.stringify(shape.arrays?.map((a) => a.path)))
    const g = shape.guess || {}
    check('猜到了列表路径', g.itemsPath === 'data.list', JSON.stringify(g))
    check('猜到了 ID 字段', g.idField === 'meetingId', JSON.stringify(g))
    check('猜到了名称字段', g.nameField === 'meetingName', JSON.stringify(g))
    check('猜到了嵌套的项目 ID', g.projectIdField === 'project.id', JSON.stringify(g))
    check('猜到了分组字段', g.groupField === 'project.name', JSON.stringify(g))
    const firstArr = (shape.arrays || []).find((a) => a.path === 'data.list')
    check('下拉框里带着真实取值', !!firstArr?.fields?.some((f) => f.path === 'project.id' && f.sample === 'p1'),
      JSON.stringify(firstArr?.fields))

    // Apply the guess the way the settings page does, then confirm it parses.
    store.setSettings({
      projectsItemsPath: g.itemsPath, projectsIdField: g.idField, projectsNameField: g.nameField,
      projectsProjectIdField: g.projectIdField, projectsGroupField: g.groupField,
    })
    const reparsed = await cw.webContents.executeJavaScript('window.kuaishuo.projects.list()')
    check('用猜出来的映射能解析出两条', reparsed.items?.length === 2, JSON.stringify(reparsed.items))
    check('解析出的项目 ID 正确', reparsed.items?.[0]?.projectId === 'p1', JSON.stringify(reparsed.items?.[0]))

    // ── Live feed ────────────────────────────────────────────────────────────
    stage('3. 开一场会，逐句实时推送')
    // Through the IPC the console actually uses, not pipeline.startMeeting
    // directly: main's wrapper is where the end-of-meeting push and the
    // system-audio arming live, and a probe that skips it would pass while the
    // real path was broken.
    const doc = await cw.webContents.executeJavaScript(
      `window.kuaishuo.meeting.start({ projectId: 'p1', projectName: '快说', projectMeetingId: 'm1' })`)
    check('会议带着项目建立', store.getMeeting(doc.id)?.projectId === 'p1')

    for (const t of ['第一句话', '第二句话', '第三句话']) {
      await pipeline.commit({ text: t, source: 'mic' })
    }
    // The live sender is bounded-retry but still asynchronous; give the chain
    // a moment rather than reaching into main's internals.
    await sleep(1200)

    const segs = backend.received.filter((r) => r.body.event === 'meeting.segment')
    check('三句都推到了后端', segs.length === 3, `收到 ${segs.length} 条`)
    if (segs.length) {
      check('顺序和说出的顺序一致',
        JSON.stringify(segs.map((s) => s.body.segment.text)) === JSON.stringify(['第一句话', '第二句话', '第三句话']),
        JSON.stringify(segs.map((s) => s.body.segment.text)))
      check('带上了 projectId', segs.every((s) => s.body.project?.id === 'p1'),
        JSON.stringify(segs[0].body.project))
      check('带了签名头', !!segs[0].headers['x-kuaishuo-signature'])
      check('event 头正确', segs[0].headers['x-kuaishuo-event'] === 'meeting.segment')
    }
    const after = store.getMeeting(doc.id)
    check('推送计数写回了会议文档', (after?.livePush?.sent || 0) === 3, JSON.stringify(after?.livePush))

    // ── Completed ────────────────────────────────────────────────────────────
    stage('4. 结束会议，推完整记录')
    await cw.webContents.executeJavaScript('window.kuaishuo.meeting.stop()')
    await sleep(1800)
    const done = backend.received.filter((r) => r.body.event === 'meeting.completed')
    check('收到了完整记录', done.length >= 1, `收到 ${done.length} 条`)
    if (done.length) {
      check('完整记录也带 projectId', done[0].body.project?.id === 'p1', JSON.stringify(done[0].body.project))
      check('结构和旧 webhook 一致（有 specVersion / transcript）',
        !!done[0].body.specVersion && !!done[0].body.transcript)
      check('完整记录晚于所有实时句子',
        backend.received.findIndex((r) => r.body.event === 'meeting.completed') === backend.received.length - 1,
        '完整记录不应该抢在实时句子前面到达')
    }

    // ── Degraded path ────────────────────────────────────────────────────────
    stage('5. 不配列表接口：照常推，但没有归属')
    store.setSettings({ projectsEnabled: false, projectsUrl: '' })
    const unconfigured = await cw.webContents.executeJavaScript('window.kuaishuo.projects.list()')
    check('未配置时明确回报 configured:false', unconfigured.configured === false, JSON.stringify(unconfigured))

    const before = backend.received.length
    await cw.webContents.executeJavaScript('window.kuaishuo.meeting.start({})')
    await pipeline.commit({ text: '无归属的一句' })
    await sleep(1200)
    const anon = backend.received.slice(before).filter((r) => r.body.event === 'meeting.segment')
    check('没选会议也照样推送', anon.length === 1, `收到 ${anon.length} 条`)
    if (anon.length) {
      check('payload 里完全没有 project 块', !('project' in anon[0].body),
        JSON.stringify(anon[0].body.project))
    }
    await cw.webContents.executeJavaScript('window.kuaishuo.meeting.stop()')
    await sleep(800)

    // ── Failure is survivable ────────────────────────────────────────────────
    stage('6. 后端挂掉时，逐字稿依然完好')
    store.setSettings({ projectPushUrl: 'http://127.0.0.1:1/dead' })
    const doc3 = await cw.webContents.executeJavaScript(`window.kuaishuo.meeting.start({ projectId: 'p2' })`)
    await pipeline.commit({ text: '后端挂了也要记下来' })
    // The live sender retries at 800ms then 2500ms before giving up, so a
    // shorter wait than that would be measuring the retry, not the outcome.
    await sleep(5000)
    const saved = store.getMeeting(doc3.id)
    // Not a count: the probe runs with a live microphone, so anything said in
    // the room lands in this meeting too. What matters is that the sentence we
    // committed is on disk despite the endpoint being unreachable.
    check('段落照常落盘', (saved?.segments || []).some((s) => s.text === '后端挂了也要记下来'),
      JSON.stringify(saved?.segments))
    check('失败被计数而不是被吞掉', (saved?.livePush?.failed || 0) >= 1, JSON.stringify(saved?.livePush))
    await cw.webContents.executeJavaScript('window.kuaishuo.meeting.stop()')

    return finish(backend)
  } catch (err) {
    console.error('\n探针本身出错：', err)
    check('探针跑完', false, err.message)
    return finish(backend)
  }
}

function finish(backend) {
  try { backend.server.close() } catch {}
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  const ok = passed === total
  console.log(`\n\x1b[${ok ? 32 : 31}m${passed}/${total} 通过\x1b[0m`)
  return ok ? 0 : 1
}

module.exports = { run }
