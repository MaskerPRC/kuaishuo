// Fetching the list of meetings/projects a recording can be filed under.
//
// The whole design problem here is that there is no such thing as "the" shape
// of this response. One backend returns a bare array, another wraps it in
// {code, data:{list:[…]}}, another calls the id `meetingId` and hangs the
// project off a nested object. Hardcoding any one of those means supporting
// exactly one deployment, so the shape is configuration: a dot path to the
// array, and a dot path to each field inside an item.
//
// Kept free of Electron (only http/https/url) for the same reason webhook.cjs
// is: the mapping rules are the part most likely to be wrong, and they need to
// be testable against real responses without launching an app.

const http = require('http')
const https = require('https')

const TIMEOUT_MS = 15_000
// A list for a human to pick from. Past a few hundred the picker is the wrong
// UI anyway, and this bounds what a misconfigured URL can do to memory.
const MAX_ITEMS = 500

/**
 * Walk a dot path, tolerating everything. Returns undefined rather than
 * throwing on a missing link, a null, or a primitive in the middle — the input
 * is a stranger's JSON and a typo in the config must produce an empty picker,
 * not a crash in the main process.
 *
 * Supports array indices: 'data.items.0.id'.
 */
function resolvePath(obj, path) {
  if (!path) return obj
  let cur = obj
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

/** Anything that isn't a string/number is not an id. Objects stringify to junk. */
function scalar(v) {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * @typedef {object} Mapping
 * @property {string} [itemsPath]      dot path to the array; '' = the root is it
 * @property {string} [idField]        required per item
 * @property {string} [nameField]      falls back to the id
 * @property {string} [projectIdField] falls back to the id — see below
 * @property {string} [groupField]     optional heading in the picker
 */

/**
 * Turn an arbitrary response into pickable items.
 *
 * `projectIdField` falling back to `idField` is what lets one config serve two
 * different backends: one that returns a flat list of projects (the id IS the
 * project) and one that returns meetings each carrying a project reference.
 * Asking the user to know which kind they have, in order to fill in a field
 * that is usually the same value, would be a question with no good answer.
 *
 * @returns {{items: Array, skipped: number, reason: string}}
 *          `skipped` is not diagnostics-only: a mapping whose idField is wrong
 *          yields an empty picker that looks exactly like "not configured", so
 *          the count is surfaced in the settings test button.
 */
function mapItems(json, mapping = {}) {
  const {
    itemsPath = '', idField = 'id', nameField = 'name',
    projectIdField = '', groupField = '',
  } = mapping

  const raw = resolvePath(json, itemsPath)
  if (!Array.isArray(raw)) {
    return {
      items: [],
      skipped: 0,
      reason: itemsPath
        ? `路径 "${itemsPath}" 不是数组（拿到 ${describe(raw)}）`
        : `响应的根不是数组（拿到 ${describe(json)}），需要填「列表路径」`,
    }
  }

  const items = []
  let skipped = 0
  for (const row of raw) {
    if (!row || typeof row !== 'object') { skipped++; continue }
    const id = scalar(resolvePath(row, idField))
    if (!id) { skipped++; continue }
    const name = scalar(resolvePath(row, nameField)) || id
    const projectId = (projectIdField ? scalar(resolvePath(row, projectIdField)) : '') || id
    const group = groupField ? scalar(resolvePath(row, groupField)) : ''
    items.push({ id, name, projectId, group })
    if (items.length >= MAX_ITEMS) { skipped += raw.length - items.length - skipped; break }
  }

  return {
    items,
    skipped,
    reason: items.length === 0 && raw.length > 0
      ? `${raw.length} 条里没有一条能取到 id（字段 "${idField}" 对不上）`
      : '',
  }
}

function describe(v) {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ---- Shape discovery ---------------------------------------------------------
// Asking someone to type `data.list` and `project.id` into five text boxes is
// asking them to read their own API's JSON by eye and transcribe it without a
// typo — and the failure when they get it wrong is an empty picker, which looks
// exactly like "not configured". But the test request already fetched a real
// response, so the paths are sitting right there. Find them and let the user
// point at one.

const MAX_DEPTH = 5          // deep enough for {code,data:{result:{page:{list:[]}}}}
const MAX_NODES = 5000       // a runaway response must not hang the main process
const MAX_ITEM_SAMPLE = 5    // items scanned per array to union their keys
const MAX_FIELDS = 60

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A short, readable stand-in for a value, for the dropdown's second line. */
function sampleOf(v) {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v
  return String(v)
}

/** Every scalar leaf inside an item, as dot paths — `project.id` included. */
function leafFields(items) {
  const seen = new Map()
  const walk = (obj, prefix, depth) => {
    if (depth > 3 || seen.size >= MAX_FIELDS) return
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (isPlainObject(v)) walk(v, p, depth + 1)
      else if (scalar(v) !== '' && !seen.has(p)) seen.set(p, sampleOf(v))
    }
  }
  for (const it of items.slice(0, MAX_ITEM_SAMPLE)) if (isPlainObject(it)) walk(it, '', 1)
  return [...seen].map(([path, sample]) => ({ path, sample }))
}

const looksLikeId = (p) => /(^|\.)(id|uuid|guid|code|key|no)$/i.test(p) || /id$/i.test(p)
const looksLikeName = (p) => /(^|\.)(name|title|label|subject|text)$/i.test(p) || /(name|title)$/i.test(p)
const mentionsProject = (p) => /(project|proj|team|space|workspace|group)/i.test(p)

/**
 * Find every array-of-objects in a response, with the fields inside each.
 *
 * @returns {{arrays: Array<{path:string,count:number,fields:Array}>, guess: object}}
 */
function inspectShape(json) {
  const arrays = []
  let nodes = 0

  const visit = (value, path, depth) => {
    if (depth > MAX_DEPTH || nodes++ > MAX_NODES) return
    if (Array.isArray(value)) {
      // Arrays of scalars are not pickable lists — there is nothing to map an
      // id and a name out of.
      if (value.some(isPlainObject)) {
        arrays.push({ path, count: value.length, fields: leafFields(value) })
      }
      // Don't descend into array elements: a path with an index in it is not a
      // list the user can select, it's one row of one.
      return
    }
    if (!isPlainObject(value)) return
    for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k, depth + 1)
  }
  visit(json, '', 0)

  // Most fields first, then shallowest: the real list is usually the fattest
  // array in the response, and a wrapper like {data:{list:[…]}} beats a
  // stray [] hanging off some unrelated key.
  arrays.sort((a, b) =>
    (b.fields.length - a.fields.length) ||
    (a.path.split('.').length - b.path.split('.').length) ||
    (b.count - a.count))

  return { arrays, guess: guessMapping(arrays[0]) }
}

/**
 * A first pick, so the common case needs no thought at all. Deliberately
 * conservative: leave a field blank rather than choose something wrong, because
 * a blank projectIdField falls back to the id and still works.
 */
function guessMapping(arr) {
  if (!arr) return null
  const paths = arr.fields.map((f) => f.path)
  const pick = (test, extra = () => true) => paths.find((p) => test(p) && extra(p)) || ''

  // Prefer a plain top-level id over a nested one — `meetingId` is the row's
  // own identity, `project.id` is a reference to something else.
  const idField =
    pick((p) => !p.includes('.') && /^id$/i.test(p)) ||
    pick((p) => !p.includes('.') && looksLikeId(p) && !mentionsProject(p)) ||
    pick((p) => looksLikeId(p) && !mentionsProject(p)) ||
    paths[0] || 'id'

  const nameField =
    pick((p) => !p.includes('.') && looksLikeName(p) && !mentionsProject(p)) ||
    pick((p) => looksLikeName(p) && !mentionsProject(p)) ||
    ''

  // Only when the response actually carries a separate project reference. If it
  // doesn't, blank is right: that means "the row IS the project".
  const projectIdField = pick((p) => mentionsProject(p) && looksLikeId(p) && p !== idField)
  const groupField = pick((p) => mentionsProject(p) && looksLikeName(p) && p !== nameField)

  return { itemsPath: arr.path, idField, nameField, projectIdField, groupField }
}

// ---- Transport ---------------------------------------------------------------
// webhook.cjs only has a POST. This is the GET half, deliberately not merged
// into it: that module is about delivering our data outward, this one is about
// reading someone else's, and they fail in different ways.

function getJson(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return reject(new Error(`地址格式不对: ${url}`))
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(new Error(`不支持的协议 ${target.protocol}`))
    }
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      target,
      { method: 'GET', headers: { accept: 'application/json', ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)
            err.status = res.statusCode
            return reject(err)
          }
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text), raw: text })
          } catch {
            // Overwhelmingly this is an HTML login page from an endpoint that
            // wanted an auth header. Say that, rather than "Unexpected token <".
            reject(new Error(`响应不是 JSON（前 120 字：${text.slice(0, 120).replace(/\s+/g, ' ')}）`))
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.end()
  })
}

/**
 * Fetch and map in one call. Never throws — the caller is either a UI test
 * button or a picker that has to stay usable when the endpoint is down.
 *
 * @returns {Promise<{ok:boolean, items:Array, skipped:number, error:string, reason:string, raw:string}>}
 */
async function fetchProjects({ url, headers = {}, timeoutMs, withShape = false, ...mapping } = {}) {
  if (!url) return { ok: false, items: [], skipped: 0, error: '未配置列表接口地址', reason: '', raw: '' }
  let res
  try {
    res = await getJson(url, { headers, timeoutMs })
  } catch (err) {
    return { ok: false, items: [], skipped: 0, error: err.message || String(err), reason: '', raw: '' }
  }
  const mapped = mapItems(res.json, mapping)
  return {
    ok: true,
    items: mapped.items,
    skipped: mapped.skipped,
    reason: mapped.reason,
    error: '',
    // The settings page fills its dropdowns from this, so the user picks paths
    // out of their own response instead of transcribing them by eye.
    ...(withShape ? inspectShape(res.json) : {}),
    // Trimmed: this goes to the renderer for the "test" button to show, and a
    // large list would otherwise cross the IPC boundary in full.
    raw: res.raw.slice(0, 2000),
  }
}

module.exports = {
  resolvePath, mapItems, getJson, fetchProjects,
  inspectShape, guessMapping,
  MAX_ITEMS, TIMEOUT_MS,
}
