// Pulling the list of meetings a recording can be filed under.
//
// Everything here is about one thing: the response comes from someone else's
// backend, in a shape nobody agreed on in advance, and the extraction rules are
// typed in by hand. So the interesting cases are all the ways a plausible
// config can be subtly wrong — and the requirement that none of them throw,
// because a typo in a settings field must not take out the main process.

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolvePath, mapItems, fetchProjects } = require('../electron/projects.cjs')

describe('resolvePath', () => {
  const obj = { a: { b: { c: 1 } }, list: [{ id: 'x' }], zero: 0, empty: '' }

  test('walks a dot path', () => {
    assert.equal(resolvePath(obj, 'a.b.c'), 1)
    assert.equal(resolvePath(obj, 'list.0.id'), 'x')
  })

  test('an empty path is the object itself — that is how "root is the array" works', () => {
    assert.equal(resolvePath(obj, ''), obj)
    assert.equal(resolvePath(obj, undefined), obj)
  })

  test('falsy-but-present values survive', () => {
    assert.equal(resolvePath(obj, 'zero'), 0)
    assert.equal(resolvePath(obj, 'empty'), '')
  })

  test('a missing or impossible path is undefined, never a throw', () => {
    // Every one of these is a realistic typo in the settings field.
    for (const p of ['a.b.nope', 'a.b.c.d', 'nope.nope', 'zero.x', 'empty.x', 'a..b']) {
      assert.equal(resolvePath(obj, p), undefined, p)
    }
    assert.equal(resolvePath(null, 'a'), undefined)
    assert.equal(resolvePath(undefined, 'a.b'), undefined)
  })
})

describe('mapItems', () => {
  const nested = {
    code: 0,
    data: {
      list: [
        { meetingId: 'm1', meetingName: '周会', project: { id: 'p1', name: '快说' } },
        { meetingId: 'm2', meetingName: '评审', project: { id: 'p2', name: '别的' } },
      ],
    },
  }
  const mapping = {
    itemsPath: 'data.list', idField: 'meetingId', nameField: 'meetingName',
    projectIdField: 'project.id', groupField: 'project.name',
  }

  test('extracts through a nested path', () => {
    const { items, skipped } = mapItems(nested, mapping)
    assert.equal(skipped, 0)
    assert.deepEqual(items[0], { id: 'm1', name: '周会', projectId: 'p1', group: '快说' })
    assert.equal(items[1].projectId, 'p2')
  })

  test('a bare array at the root needs no path', () => {
    const { items } = mapItems([{ id: 'a', name: 'A' }], {})
    assert.deepEqual(items, [{ id: 'a', name: 'A', projectId: 'a', group: '' }])
  })

  test('projectIdField blank falls back to the id', () => {
    // This is what lets one config serve a backend that returns projects and
    // one that returns meetings carrying a project — without asking the user
    // which kind they have.
    const { items } = mapItems([{ id: 'p9', name: '项目九' }], { projectIdField: '' })
    assert.equal(items[0].projectId, 'p9')
  })

  test('numeric ids are usable, objects are not', () => {
    const { items, skipped } = mapItems(
      [{ id: 42, name: 'n' }, { id: { nope: true }, name: 'x' }, { id: null }],
      {},
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].id, '42')
    assert.equal(skipped, 2)
  })

  test('a name that cannot be read falls back to the id rather than blank', () => {
    const { items } = mapItems([{ id: 'a' }], { nameField: 'title' })
    assert.equal(items[0].name, 'a')
  })

  test('rows with no id are skipped and counted', () => {
    // The headline failure mode: the request worked, the array was found, and
    // the id field is wrong. Without the count this is indistinguishable from
    // "the backend returned nothing".
    const { items, skipped, reason } = mapItems(nested, { ...mapping, idField: 'wrong' })
    assert.equal(items.length, 0)
    assert.equal(skipped, 2)
    assert.match(reason, /wrong/)
  })

  test('a path that is not an array explains itself', () => {
    const { items, reason } = mapItems(nested, { ...mapping, itemsPath: 'data' })
    assert.equal(items.length, 0)
    assert.match(reason, /data/)
  })

  test('root-is-not-an-array says to fill in the path', () => {
    const { reason } = mapItems(nested, {})
    assert.match(reason, /列表路径/)
  })

  test('junk in the array does not throw', () => {
    const { items, skipped } = mapItems([null, 'str', 7, [], { id: 'ok' }], {})
    assert.equal(items.length, 1)
    assert.equal(skipped, 4)
  })
})

// Real sockets, same approach as webhook.test.js — the point is to exercise the
// actual request path, including the ways it can fail.
const servers = []
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/api` })
    })
  })
}
after(() => { for (const s of servers) { try { s.close() } catch {} } })

describe('fetchProjects', () => {
  test('fetches and maps in one call', async () => {
    let seenAuth = null
    const { url } = await startServer((req, res) => {
      seenAuth = req.headers.authorization
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { list: [{ mid: '1', nm: '周会' }] } }))
    })
    const r = await fetchProjects({
      url, headers: { Authorization: 'Bearer t0ken' },
      itemsPath: 'data.list', idField: 'mid', nameField: 'nm',
    })
    assert.equal(r.ok, true)
    assert.equal(seenAuth, 'Bearer t0ken', 'custom headers must reach the endpoint')
    assert.deepEqual(r.items, [{ id: '1', name: '周会', projectId: '1', group: '' }])
  })

  test('a missing url is reported, not thrown', async () => {
    const r = await fetchProjects({})
    assert.equal(r.ok, false)
    assert.deepEqual(r.items, [])
  })

  test('a non-2xx is reported with its status', async () => {
    const { url } = await startServer((req, res) => { res.writeHead(404); res.end('nope') })
    const r = await fetchProjects({ url })
    assert.equal(r.ok, false)
    assert.match(r.error, /404/)
  })

  test('an HTML login page says so instead of "Unexpected token"', async () => {
    // Overwhelmingly the first thing that happens when the auth header is
    // missing, and the raw JSON.parse message points nowhere useful.
    const { url } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body>Please sign in</body></html>')
    })
    const r = await fetchProjects({ url })
    assert.equal(r.ok, false)
    assert.match(r.error, /不是 JSON/)
    assert.match(r.error, /sign in/)
  })

  test('a dead port fails without throwing', async () => {
    const r = await fetchProjects({ url: 'http://127.0.0.1:1/api' })
    assert.equal(r.ok, false)
    assert.ok(r.error)
  })

  test('a malformed url fails without throwing', async () => {
    const r = await fetchProjects({ url: 'not a url' })
    assert.equal(r.ok, false)
  })

  test('a non-http protocol is refused', async () => {
    const r = await fetchProjects({ url: 'file:///etc/passwd' })
    assert.equal(r.ok, false)
    assert.match(r.error, /协议/)
  })

  test('reaching the endpoint but mapping nothing is still ok:true, with a reason', async () => {
    // The distinction matters: the network is fine and the config is not, and
    // the settings UI says different things about those two.
    const { url } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ uuid: 'a' }]))
    })
    const r = await fetchProjects({ url, idField: 'id' })
    assert.equal(r.ok, true)
    assert.equal(r.items.length, 0)
    assert.ok(r.reason)
  })
})

// Discovery. The point of this is that nobody should have to read their own
// API's JSON by eye and transcribe `data.list` and `project.id` into text
// boxes — the test request already has the response, so the paths are findable.
describe('inspectShape', () => {
  const { inspectShape } = require('../electron/projects.cjs')

  const nested = {
    code: 0,
    msg: 'ok',
    data: {
      total: 2,
      list: [
        { meetingId: 'm-1001', meetingName: '周会', project: { id: 'p-88', name: '快说' } },
        { meetingId: 'm-1002', meetingName: '技术评审', project: { id: 'p-90', name: '另一个' } },
      ],
    },
  }

  test('finds the array however deep it is, with the fields inside it', () => {
    const { arrays } = inspectShape(nested)
    const hit = arrays.find((a) => a.path === 'data.list')
    assert.ok(hit, JSON.stringify(arrays.map((a) => a.path)))
    assert.equal(hit.count, 2)
    const paths = hit.fields.map((f) => f.path)
    // Nested scalars are reachable as dot paths — that is the whole reason the
    // config accepts them.
    assert.deepEqual(paths.sort(), ['meetingId', 'meetingName', 'project.id', 'project.name'])
  })

  test('carries a real sample value for each field, so the dropdown is readable', () => {
    const { arrays } = inspectShape(nested)
    const f = arrays.find((a) => a.path === 'data.list').fields
    assert.equal(f.find((x) => x.path === 'project.id').sample, 'p-88')
    assert.equal(f.find((x) => x.path === 'meetingName').sample, '周会')
  })

  test('guesses a mapping that actually parses', () => {
    const { guess } = inspectShape(nested)
    assert.equal(guess.itemsPath, 'data.list')
    assert.equal(guess.idField, 'meetingId')
    assert.equal(guess.nameField, 'meetingName')
    // The row references a project, so that is what the push should carry —
    // not the row's own id.
    assert.equal(guess.projectIdField, 'project.id')
    assert.equal(guess.groupField, 'project.name')

    // The real assertion: feeding the guess straight back in produces items.
    const { items } = mapItems(nested, guess)
    assert.equal(items.length, 2)
    assert.deepEqual(items[0], { id: 'm-1001', name: '周会', projectId: 'p-88', group: '快说' })
  })

  test('a bare array at the root is found as the empty path', () => {
    const { arrays, guess } = inspectShape([{ id: 'a', name: 'A' }])
    assert.equal(arrays[0].path, '')
    assert.equal(guess.itemsPath, '')
    assert.equal(guess.idField, 'id')
  })

  test('a flat project list leaves projectIdField blank, which means "use the id"', () => {
    const { guess } = inspectShape({ data: [{ id: 'p1', name: '项目一' }] })
    assert.equal(guess.idField, 'id')
    assert.equal(guess.projectIdField, '', '没有单独的项目引用时就不该猜一个出来')
    const { items } = mapItems({ data: [{ id: 'p1', name: '项目一' }] }, guess)
    assert.equal(items[0].projectId, 'p1')
  })

  test('arrays of scalars are not offered — there is nothing to map', () => {
    const { arrays } = inspectShape({ tags: ['a', 'b'], rows: [{ id: 1 }] })
    assert.deepEqual(arrays.map((a) => a.path), ['rows'])
  })

  test('the richest array is offered first', () => {
    const { arrays } = inspectShape({
      meta: [{ k: 1 }],
      data: { list: [{ id: 'a', name: 'n', extra: 1, more: 2 }] },
    })
    assert.equal(arrays[0].path, 'data.list')
  })

  test('survives junk without throwing', () => {
    for (const junk of [null, 3, 'str', {}, [], { a: { b: { c: { d: { e: 1 } } } } }]) {
      const r = inspectShape(junk)
      assert.ok(Array.isArray(r.arrays))
    }
  })

  test('fetchProjects exposes the shape only when asked', async () => {
    const { url } = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(nested))
    })
    const plain = await fetchProjects({ url })
    assert.equal(plain.arrays, undefined)
    const withShape = await fetchProjects({ url, withShape: true })
    assert.ok(withShape.arrays.length)
    assert.equal(withShape.guess.itemsPath, 'data.list')
  })
})
