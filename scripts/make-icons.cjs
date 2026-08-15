// Generates the app and tray icons as real PNG files.
//
// Committing binary blobs to a repo means nobody can ever answer "why is the
// tray icon 3px off-centre" without opening an image editor. This draws them
// from numbers instead: change a constant, re-run, see the diff in the source.
// Pure Node (zlib + a CRC table) — no image library, nothing to install.
//
//   node scripts/make-icons.cjs

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT = path.join(__dirname, '..', 'electron', 'assets')

// ---- PNG encoder ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** @param {Uint8Array} rgba  size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // colour type: RGBA
  // 10,11,12 = deflate / adaptive filtering / no interlace, all zero

  // One filter byte (0 = None) per scanline. Filtering would shrink the file;
  // these are a few KB either way and unfiltered is one less thing to get wrong.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- Drawing ----------------------------------------------------------------
// Everything is expressed in 0..1 of the icon box and rendered at SS× before
// being box-filtered down, which is what gives the curves clean edges without
// writing an antialiasing rasteriser.

const SS = 4

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}

/**
 * @param {number} size            final pixel size
 * @param {object} o
 * @param {[number,number,number,number]|null} o.bg   rounded-square plate, or null for transparent
 * @param {[number,number,number]} o.fg               glyph colour
 * @param {boolean} [o.arc]                           draw the pickup arc (too thin to read below ~24px)
 */
function drawIcon(size, { bg, fg, arc = true }) {
  const n = size * SS
  const acc = new Float32Array(size * size * 4)

  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = (px + 0.5) / n
      const y = (py + 0.5) / n

      let r = 0, g = 0, b = 0, a = 0

      if (bg && sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0) {
        // A touch of vertical lift so the plate doesn't read as flat paint.
        const lift = 1 + (0.5 - y) * 0.18
        r = Math.min(255, bg[0] * lift); g = Math.min(255, bg[1] * lift); b = Math.min(255, bg[2] * lift)
        a = bg[3]
      }

      let inGlyph = false
      // Capsule (the mic body).
      if (sdRoundRect(x, y, 0.5, 0.395, 0.105, 0.175, 0.105) <= 0) inGlyph = true
      // Stem + base.
      if (sdRoundRect(x, y, 0.5, 0.735, 0.022, 0.075, 0.02) <= 0) inGlyph = true
      if (sdRoundRect(x, y, 0.5, 0.815, 0.115, 0.024, 0.024) <= 0) inGlyph = true
      // Pickup arc: a ring segment below the capsule's centre.
      if (arc) {
        const d = Math.hypot(x - 0.5, y - 0.44)
        if (y > 0.47 && Math.abs(d - 0.215) <= 0.026) inGlyph = true
      }

      if (inGlyph) { r = fg[0]; g = fg[1]; b = fg[2]; a = 255 }

      const i = (Math.floor(py / SS) * size + Math.floor(px / SS)) * 4
      acc[i] += r; acc[i + 1] += g; acc[i + 2] += b; acc[i + 3] += a
    }
  }

  const out = new Uint8Array(size * size * 4)
  const per = SS * SS
  for (let i = 0; i < out.length; i += 4) {
    const a = acc[i + 3] / per
    out[i + 3] = Math.round(a)
    // Straight (non-premultiplied) alpha: average the colour over the covered
    // samples only, otherwise every edge pixel gets pulled toward black.
    const cover = a > 0 ? a / 255 : 1
    out[i]     = Math.round(acc[i]     / per / cover)
    out[i + 1] = Math.round(acc[i + 1] / per / cover)
    out[i + 2] = Math.round(acc[i + 2] / per / cover)
  }
  return out
}

// ---- Output -----------------------------------------------------------------

// WeChat green. One accent for the whole product — icon, tray, ribbon, console.
const WECHAT = [7, 193, 96, 255]

const TARGETS = [
  { file: 'icon.png',        size: 256, bg: WECHAT, fg: [255, 255, 255], arc: true },
  { file: 'tray-active.png', size: 32,  bg: null,   fg: WECHAT.slice(0, 3), arc: false },
  { file: 'tray-idle.png',   size: 32,  bg: null,   fg: [156, 163, 175],    arc: false },
  { file: 'tray-muted.png',  size: 32,  bg: null,   fg: [239, 68, 68],      arc: false },
]

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  for (const t of TARGETS) {
    const rgba = drawIcon(t.size, { bg: t.bg, fg: t.fg, arc: t.arc })
    const png = encodePng(rgba, t.size)
    fs.writeFileSync(path.join(OUT, t.file), png)
    console.log(`${t.file.padEnd(18)} ${t.size}×${t.size}  ${png.length} bytes`)
  }
}

if (require.main === module) main()

module.exports = { encodePng, drawIcon, crc32 }
