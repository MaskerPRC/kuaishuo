// Waveform painter for the dictation strip. Plain module rather than living
// inside VoiceWaveBar.vue so the look can be rendered and eyeballed outside the
// app — the shape is the whole point of this file, and "does it read as a voice
// or as a machine" is not a thing you can settle by reading code.
//
// Three overlaid ribbons, one per frequency band, each a smooth curve sampled
// across the width rather than a row of bars. Bars quantize a continuous thing
// into 40 rectangles; that's what reads as mechanical.
//
// Each ribbon is a sum of three travelling sines at incommensurate spatial
// frequencies and drift speeds. The irrationality is the trick: harmonically
// related components repeat on a visible cycle and the eye picks up the loop,
// while slightly-off ratios never quite line up, so the curve keeps folding
// into shapes it hasn't held before. Amplitude comes from that band's live
// energy, so lows swell slow and wide while sibilance flickers narrow and
// fast — the three genuinely move apart instead of being one envelope drawn
// three times.

// amp:   how far this band may swing, as a fraction of half-height
// comps: [spatial frequency, temporal drift, weight] per sine component
// Spatial frequencies are kept well apart between ribbons (≈0.9 / 1.9 / 3.3
// cycles across the width) so the three read as separate strands. Packing them
// close together is what turned an earlier pass into a single fuzzy smudge:
// similar curves plus glow just pile up in the middle.
export const RIBBONS = [
  { band: 0, amp: 1.00, width: 1.7, alpha: 0.92, comps: [[0.9, 0.31, 1.0], [2.1, -0.19, 0.34], [3.3, 0.13, 0.14]] },
  { band: 1, amp: 0.58, width: 1.3, alpha: 0.50, comps: [[1.9, -0.27, 1.0], [3.4, 0.37, 0.30], [5.1, -0.16, 0.14]] },
  // Sibilance gets a deliberately generous amp for how quiet it is: /s/ and /sh/
  // carry little energy but a lot of information, and at the honest amplitude
  // the top strand was invisible — the band may as well not have existed.
  { band: 2, amp: 0.46, width: 1.0, alpha: 0.42, comps: [[3.3, 0.49, 1.0], [6.1, -0.41, 0.26], [9.2, 0.24, 0.12]] },
]

// Never let a ribbon go perfectly flat: a listening mic should look alive. This
// is a resting breath, not fake activity — it does not grow with silence.
const IDLE_LEVEL = 0.055
const EASE = 0.12

const clamp01 = (v) => Math.min(1, Math.max(0, v))

// The CSS `color` we sample can be in any notation the theme uses; normalise it
// through a throwaway canvas once, then re-alpha per gradient stop.
let _colorCache = { input: '', rgb: '7, 193, 96' }
export function withAlpha(color, alpha) {
  if (_colorCache.input !== color) {
    let rgb = '7, 193, 96'
    try {
      const probe = document.createElement('canvas').getContext('2d')
      probe.fillStyle = '#000'
      probe.fillStyle = color
      const resolved = probe.fillStyle
      if (resolved.startsWith('#') && resolved.length === 7) {
        rgb = `${parseInt(resolved.slice(1, 3), 16)}, ${parseInt(resolved.slice(3, 5), 16)}, ${parseInt(resolved.slice(5, 7), 16)}`
      } else {
        const m = resolved.match(/(\d+),\s*(\d+),\s*(\d+)/)
        if (m) rgb = `${m[1]}, ${m[2]}, ${m[3]}`
      }
    } catch { /* keep the default */ }
    _colorCache = { input: color, rgb }
  }
  return `rgba(${_colorCache.rgb}, ${alpha})`
}

/**
 * @param {CanvasRenderingContext2D} ctx  already transformed to CSS pixels
 * @param {object}  o
 * @param {number}  o.w      width in CSS px
 * @param {number}  o.h      height in CSS px
 * @param {ArrayLike<number>} o.bands  [low, mid, high] 0..1, live
 * @param {number[]} o.eased  3 slots of persistent per-band easing state
 * @param {number}  o.time    seconds; drives the drift
 * @param {string}  o.color   CSS color for the stroke
 * @param {boolean} [o.busy]  transcribing — run the sweep instead of a label
 */
export function drawRibbons(ctx, { w, h, bands, eased, time, color, busy = false }) {
  ctx.clearRect(0, 0, w, h)
  const mid = h / 2
  const maxSwing = h / 2 - 2

  // "Transcribing" used to be spelled out in text next to the ribbon, and with
  // the endpointer firing between sentences it flashed 识别中… over and over,
  // which reads as stuttering rather than progress. The ribbon says it instead:
  // it settles to a calm line and a brighter band travels along it. Same
  // information, no words, and repeated occurrences look continuous rather than
  // like something going wrong.
  const sweep = busy ? ((time * 0.85) % 1.6) / 1.6 : -1

  for (const r of RIBBONS) {
    // While busy the mic is usually silent anyway; damping the target keeps the
    // sweep legible instead of fighting a jittery curve underneath it.
    const target = busy ? 0 : Math.min(1, (bands?.[r.band] || 0) * 1.6)
    // Second easing stage on top of the FFT's own smoothing. Without it a hard
    // consonant snaps the ribbon instead of swelling it.
    eased[r.band] += (target - eased[r.band]) * EASE
    const level = Math.max(IDLE_LEVEL, eased[r.band])
    const amp = level * r.amp * maxSwing

    ctx.beginPath()
    for (let px = 0; px <= w; px += 2) {
      const x = px / w
      // Centre-weighted envelope so the ribbon tapers to nothing at both ends
      // instead of being cut off by the canvas edge.
      const env = Math.sin(Math.PI * x) ** 1.6
      let y = 0
      let wsum = 0
      for (const [freq, drift, weight] of r.comps) {
        y += Math.sin((x * freq + time * drift) * Math.PI * 2) * weight
        wsum += weight
      }
      const py = mid + (y / wsum) * amp * env
      if (px === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }

    // Gradient along the width so the stroke itself dissolves at the ends —
    // the envelope flattens the curve there, the gradient removes the line.
    const grad = ctx.createLinearGradient(0, 0, w, 0)
    if (sweep >= 0) {
      // Dim baseline with a bright travelling window riding along it.
      const dim = r.alpha * 0.22
      const stops = [
        [0, 0], [0.16, dim], [0.84, dim], [1, 0],
        [clamp01(sweep - 0.18), dim],
        [clamp01(sweep), r.alpha],
        [clamp01(sweep + 0.18), dim],
      ].sort((a, b) => a[0] - b[0])
      for (const [at, a] of stops) grad.addColorStop(at, withAlpha(color, a))
    } else {
      grad.addColorStop(0, withAlpha(color, 0))
      grad.addColorStop(0.25, withAlpha(color, r.alpha))
      grad.addColorStop(0.75, withAlpha(color, r.alpha))
      grad.addColorStop(1, withAlpha(color, 0))
    }
    ctx.strokeStyle = grad
    ctx.lineWidth = r.width
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // Glow scales with the band's own level, so loud passages bloom. Kept low:
    // enough blur and the three strands melt back into one blob.
    ctx.shadowColor = withAlpha(color, 0.38 * level)
    ctx.shadowBlur = 3.5 * level
    ctx.stroke()
    ctx.shadowBlur = 0
  }
}
