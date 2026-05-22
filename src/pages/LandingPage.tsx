/**
 * Landing page — scroll-driven WebGL particle journey.
 *
 *   Section 1 (scroll 0.00 → 0.17) — particles drift in from beyond
 *                                    the viewport edges; "A network of
 *                                    minds." headline.
 *   Section 2 (scroll 0.17 → 0.33) — assembly completes, the cluster
 *                                    settles into an oblate spheroid
 *                                    and begins a slow continuous spin;
 *                                    "Every report. Every signal." headline.
 *   Section 3 (scroll 0.33 → 0.50) — spheroid shrinks, dots shrink with
 *                                    it, and a smaller inner sphere
 *                                    fades in. Department labels
 *                                    (Branding / Outreach / Content /
 *                                    Office of CEO) appear at the four
 *                                    cardinal edges of the spheroid.
 *   Section 4 (scroll 0.50 → 0.67) — spheroid breaks apart into a
 *                                    screen-filling sea of small dots
 *                                    undulating on overlapping sine
 *                                    waves; "One living workspace for
 *                                    all scattered work." headline.
 *   Section 5 (scroll 0.67 → 0.84) — the sea coalesces into the final
 *                                    radial filament burst: a bright
 *                                    dense core with curling tendrils
 *                                    streaming outward. This is the
 *                                    last particle target — the burst
 *                                    just holds from here on.
 *   Section 6 (scroll 0.84 → 1.00) — the burst stays as the backdrop;
 *                                    the bold solid pearl-pink (#ffe4f2)
 *                                    login form fades in on top.
 *
 * Drop your intro audio at `/audio/intro.mp3`. The file is played on
 * the user's first scroll gesture (browsers block autoplay until a
 * user interaction); a missing file fails silently. Respects
 * `prefers-reduced-motion` by snapping to the final state.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import LoginForm from './LoginForm'
import InteractiveCursor from '@/components/InteractiveCursor'

// ── Tunables ─────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 60_000
const CAMERA_Z = 6

// Length of the trimmed intro clip at `/audio/intro.mp3` (seconds). The
// scroll listener drives audio.currentTime as `scrollProgress * AUDIO_DURATION`
// so the soundtrack stays glued to the animation.
const AUDIO_DURATION = 30

// Oblate spheroid (the resting cluster).
const CORE_RADIUS = 1.4
const HALO_RADIUS = 3.4
const CORE_FRACTION = 0.55
const Z_SQUASH = 0.45    // smaller = flatter spheroid silhouette

// Nested inner sphere (visible during section 3 only).
const INNER_COUNT = 7_000
const INNER_R_MIN = 0.38
const INNER_R_MAX = 0.55

// Ambient brand-accent dots — small pearl-pink (#ffe4f2) specks scattered
// across the whole scene that twinkle gently. They do NOT morph with the
// journey; they stay put through every animation phase so the brand
// colour is always present somewhere in the frame.
const ACCENT_COUNT = 220
const ACCENT_COLOR = new THREE.Color(0xffe4f2)
const ACCENT_X_HALF = 8.0
const ACCENT_Y_HALF = 4.8
const ACCENT_Z_HALF = 2.5

// Scroll progress breakpoints — keep in sync with the JSX section heights
// below (each scroll section is `h-screen`, so each owns 1/6 of progress).
const ASSEMBLY_END    = 0.30    // particles done flying in by end of section 2
const SHRINK_START    = 0.33    // section 3 — main mesh + dots shrink
const SHRINK_END      = 0.50
const WAVES_START     = 0.50    // section 4 — cluster → sea waves
const WAVES_END       = 0.66
const BURST_START     = 0.69    // section 5 — sea → radial filament burst (final shape)
const BURST_END       = 0.83
const LOGIN_START     = 0.85    // section 6 — login fades in over the burst

// How small the main mesh scales to once the inner sphere is in.
const MAIN_SHRINK     = 0.62

// ── Helpers ──────────────────────────────────────────────────────────────

function randomDirection(out: THREE.Vector3) {
  const u = Math.random()
  const v = Math.random()
  const theta = 2 * Math.PI * u
  const phi = Math.acos(2 * v - 1)
  out.set(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  )
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// ── Target buffer generators ─────────────────────────────────────────────

// Oblate spheroid: dense core + sparser halo, Z-squashed.
function buildClusterTargets(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3)
  const coreCount = Math.floor(PARTICLE_COUNT * CORE_FRACTION)
  const dir = new THREE.Vector3()
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    randomDirection(dir)
    const r = i < coreCount
      ? CORE_RADIUS * Math.pow(Math.random(), 0.45)
      : CORE_RADIUS + (HALO_RADIUS - CORE_RADIUS) * Math.pow(Math.random(), 0.7)
    arr[i * 3 + 0] = dir.x * r
    arr[i * 3 + 1] = dir.y * r
    arr[i * 3 + 2] = dir.z * r * Z_SQUASH
  }
  // Shuffle so core/halo are interleaved — assembly intro looks natural.
  for (let i = PARTICLE_COUNT - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    for (let k = 0; k < 3; k++) {
      const tmp = arr[i * 3 + k]
      arr[i * 3 + k] = arr[j * 3 + k]
      arr[j * 3 + k] = tmp
    }
  }
  return arr
}

// Starting positions for the assembly intro: well beyond the viewport so
// each particle flies inward along its eventual cluster direction.
function buildStartTargets(cluster: Float32Array): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3)
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const cx = cluster[i * 3 + 0]
    const cy = cluster[i * 3 + 1]
    const cz = cluster[i * 3 + 2]
    const len = Math.max(0.001, Math.hypot(cx, cy, cz))
    const farFactor = 4.5 + Math.random() * 3.5
    arr[i * 3 + 0] = (cx / len) * (HALO_RADIUS + 4) * farFactor
    arr[i * 3 + 1] = (cy / len) * (HALO_RADIUS + 4) * farFactor
    arr[i * 3 + 2] = (cz / len) * (HALO_RADIUS + 4) * farFactor
  }
  return arr
}

// A sea-surface that fills the entire viewport. Particles are scattered
// across the full visible XY plane, then displaced by a sum of overlapping
// sine waves so the result reads as rolling ocean swells covering the
// whole screen rather than a few discrete ribbons.
function buildWavesTargets(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3)
  // Spread a bit wider than the camera frustum so the sea bleeds off-screen
  // at the edges — feels more "infinite ocean" than "rectangle of dots".
  const X_HALF = 8.5
  const Y_HALF = 5.0
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = (Math.random() - 0.5) * 2 * X_HALF
    const yBase = (Math.random() - 0.5) * 2 * Y_HALF
    // Layered sines — different directions / frequencies / phases. Summed,
    // they give the irregular crest-and-trough pattern of an ocean surface.
    const w1 = Math.sin(x * 1.05 + yBase * 0.55)        * 0.32
    const w2 = Math.sin(x * 1.85 - yBase * 0.30 + 1.7)  * 0.18
    const w3 = Math.sin(x * 0.55 + yBase * 1.10 + 2.4)  * 0.22
    const yDisp = w1 + w2 + w3
    // Slight Z roll so the surface has depth — close crests catch a bit
    // more "light" via parallax than the troughs behind them.
    const z = Math.cos(x * 0.8 + yBase * 0.5) * 0.22 + (Math.random() - 0.5) * 0.05
    arr[i * 3]     = x
    arr[i * 3 + 1] = yBase + yDisp + (Math.random() - 0.5) * 0.05
    arr[i * 3 + 2] = z
  }
  return arr
}

// Radial filament burst — a bright dense core with hundreds of curling
// tendrils streaming outward, plus a sparse halo of ambient specks.
// Matches the "synapse firing" reference: small dots converge along
// curved radial paths around a glowing centre.
function buildBurstTargets(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3)
  const FILAMENTS = 260
  const CORE_R = 0.18
  const FILAMENT_MAX_R = 2.6
  const CORE_COUNT = Math.floor(PARTICLE_COUNT * 0.09)
  const AMBIENT_COUNT = Math.floor(PARTICLE_COUNT * 0.16)
  const FILAMENT_TOTAL = PARTICLE_COUNT - CORE_COUNT - AMBIENT_COUNT
  const perFilament = Math.max(1, Math.floor(FILAMENT_TOTAL / FILAMENTS))

  let idx = 0
  const dir = new THREE.Vector3()

  // 1. Dense bright core where every filament converges.
  for (let i = 0; i < CORE_COUNT; i++) {
    randomDirection(dir)
    const r = CORE_R * Math.pow(Math.random(), 0.55)
    arr[idx * 3]     = dir.x * r
    arr[idx * 3 + 1] = dir.y * r
    arr[idx * 3 + 2] = dir.z * r * 0.55
    idx++
  }

  // 2. Filaments — each is a curved trail from the core out to a random
  // direction, with a per-tendril twist + arc so the trails curl rather
  // than reading as a straight star pattern.
  for (let f = 0; f < FILAMENTS && idx < PARTICLE_COUNT - AMBIENT_COUNT; f++) {
    randomDirection(dir)
    // z-squash so the burst reads as a disc-front rather than a sphere.
    const ux = dir.x
    const uy = dir.y
    const uz = dir.z * 0.4
    const inv = 1 / Math.max(1e-4, Math.hypot(ux, uy, uz))
    const nx = ux * inv, ny = uy * inv, nz = uz * inv

    // Perpendicular axis for the curl.
    let tx = -ny, ty = nx, tz = 0
    const tLen = Math.hypot(tx, ty, tz)
    if (tLen < 1e-4) { tx = 1; ty = 0; tz = 0 } else {
      tx /= tLen; ty /= tLen; tz /= tLen
    }

    const twist = (Math.random() - 0.5) * 1.6
    const arcAmp = 0.22 + Math.random() * 0.45
    const reach = FILAMENT_MAX_R * (0.55 + Math.random() * 0.55)

    for (let i = 0; i < perFilament && idx < PARTICLE_COUNT - AMBIENT_COUNT; i++) {
      const t = i / Math.max(1, perFilament - 1)
      const r = CORE_R + (reach - CORE_R) * Math.pow(t, 0.85)
      const curl = arcAmp * t * (1 - t * 0.4) * Math.sin(t * 4 + twist)
      const j = 0.014 + 0.026 * t
      arr[idx * 3]     = nx * r + tx * curl + (Math.random() - 0.5) * j
      arr[idx * 3 + 1] = ny * r + ty * curl + (Math.random() - 0.5) * j
      arr[idx * 3 + 2] = nz * r + tz * curl + (Math.random() - 0.5) * j * 0.5
      idx++
    }
  }

  // 3. Ambient drifting specks scattered well past the filament tips.
  while (idx < PARTICLE_COUNT) {
    randomDirection(dir)
    const r = FILAMENT_MAX_R * 0.5 + Math.random() * FILAMENT_MAX_R * 1.3
    arr[idx * 3]     = dir.x * r
    arr[idx * 3 + 1] = dir.y * r
    arr[idx * 3 + 2] = dir.z * r * 0.4
    idx++
  }

  return arr
}

// Inner sphere — thin shell at small radius, separate Points mesh.
function buildInnerTargets(): Float32Array {
  const arr = new Float32Array(INNER_COUNT * 3)
  const dir = new THREE.Vector3()
  for (let i = 0; i < INNER_COUNT; i++) {
    randomDirection(dir)
    const r = INNER_R_MIN + (INNER_R_MAX - INNER_R_MIN) * Math.random()
    arr[i * 3 + 0] = dir.x * r
    arr[i * 3 + 1] = dir.y * r
    arr[i * 3 + 2] = dir.z * r * Z_SQUASH
  }
  return arr
}

// ── Component ────────────────────────────────────────────────────────────

export default function LandingPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [progress, setProgress] = useState(0)
  const audioStartedRef = useRef(false)
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // Browsers restore the previous scroll position on refresh / back-nav by
  // default — but with a 6×viewport-tall page that means a refresh from
  // anywhere past the first section dumps the visitor straight onto the
  // login form and skips the animation. Force every visit to start at
  // the top, and opt this document out of future auto-restoration. The
  // previous restoration mode is restored on unmount so other routes
  // (which might rely on it) aren't affected.
  useEffect(() => {
    if (reducedMotion) return
    const prev = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
    return () => {
      window.history.scrollRestoration = prev
    }
  }, [reducedMotion])

  // Pre-compute all target buffers once — large, stable.
  const targets = useMemo(() => {
    const cluster = buildClusterTargets()
    const start = buildStartTargets(cluster)
    const inner = buildInnerTargets()
    const waves = buildWavesTargets()
    const burst = buildBurstTargets()
    return { cluster, start, inner, waves, burst }
  }, [])

  // ── Three.js scene (mount once) ────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    const setSize = () => renderer.setSize(window.innerWidth, window.innerHeight, false)
    setSize()

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100)
    camera.position.z = CAMERA_Z

    // Main particle mesh — positions interpolated each frame between the
    // phase-source buffer and the phase-target buffer.
    const positions = new Float32Array(targets.start)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    // Per-particle attributes:
    //   aSeed — twinkle / drift phase
    //   aSize — size multiplier (narrow band so nothing reads as a blob)
    //   aTier — 1.0 = "small" (brighter glow), 0.0 = "very small" (dimmer)
    const seeds = new Float32Array(PARTICLE_COUNT)
    const sizes = new Float32Array(PARTICLE_COUNT)
    const tiers = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      seeds[i] = Math.random()
      sizes[i] = 0.7 + Math.pow(Math.random(), 4) * 1.1
      tiers[i] = Math.random() < 0.5 ? 1.0 : 0.0
    }
    geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geom.setAttribute('aTier', new THREE.BufferAttribute(tiers, 1))

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:       { value: 0 },
        uProgress:   { value: 0 },
        uDotScale:   { value: 1.0 },   // overall size multiplier — shrinks with progress
        uTierMix:    { value: 0.0 },   // 0 = uniform sizes, 1 = enforce tier difference
        uFade:       { value: 1 },     // cluster recedes behind login form
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uProgress;
        uniform float uDotScale;
        uniform float uTierMix;
        uniform float uPixelRatio;
        attribute float aSeed;
        attribute float aSize;
        attribute float aTier;
        varying float vAlpha;
        varying float vTwinkle;
        varying float vTier;

        void main() {
          vec3 pos = position;

          // Breathing: tiny per-particle drift on individual phases.
          float t = uTime * 0.4 + aSeed * 6.2831;
          pos.x += sin(t) * 0.025;
          pos.y += cos(t * 1.21) * 0.025;
          pos.z += sin(t * 0.87) * 0.018;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;

          // Tier-based size: "small" dots are full-size, "very small" are
          // ~55%.  uTierMix lets us blend in the contrast — 0 means all
          // particles the same size, 1 means the full tier distinction.
          float tierSize = mix(1.0, mix(0.55, 1.0, aTier), uTierMix);
          float baseSize = uDotScale * tierSize * mix(0.6, 0.9, uProgress);
          gl_PointSize = baseSize * aSize * uPixelRatio * (14.0 / -mv.z);

          // Twinkle on its own phase.
          vTwinkle = 0.55 + 0.45 * sin(uTime * 1.6 + aSeed * 17.0);

          // Fade in across the slow assembly window so particles brighten
          // gradually rather than popping in once they arrive.
          vAlpha = smoothstep(0.0, ${ASSEMBLY_END.toFixed(3)}, uProgress);

          vTier = aTier;
        }
      `,
      fragmentShader: `
        uniform float uFade;
        uniform float uTierMix;
        varying float vAlpha;
        varying float vTwinkle;
        varying float vTier;
        void main() {
          // Crisp pinprick — antialiased only on the outermost edge.
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = 1.0 - smoothstep(0.40, 0.50, d);
          // Tier glow: very-small dots are dimmer when the tier mix is
          // active.  Inactive (uTierMix=0) keeps everyone equal.
          float tierGlow = mix(1.0, mix(0.55, 1.0, vTier), uTierMix);
          gl_FragColor = vec4(vec3(1.0), vAlpha * vTwinkle * edge * uFade * tierGlow);
        }
      `,
    })

    const points = new THREE.Points(geom, material)
    scene.add(points)

    // ── Inner nested cluster (visible during section 3) ────────────────
    const innerGeom = new THREE.BufferGeometry()
    innerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(targets.inner), 3))
    const innerSeeds = new Float32Array(INNER_COUNT)
    const innerSizes = new Float32Array(INNER_COUNT)
    for (let i = 0; i < INNER_COUNT; i++) {
      innerSeeds[i] = Math.random()
      innerSizes[i] = 0.9 + Math.pow(Math.random(), 4) * 0.9
    }
    innerGeom.setAttribute('aSeed', new THREE.BufferAttribute(innerSeeds, 1))
    innerGeom.setAttribute('aSize', new THREE.BufferAttribute(innerSizes, 1))

    const innerMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:       { value: 0 },
        uAlpha:      { value: 0 },
        uDotScale:   { value: 1.0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uDotScale;
        uniform float uPixelRatio;
        attribute float aSeed;
        attribute float aSize;
        varying float vTwinkle;
        void main() {
          vec3 pos = position;
          float t = uTime * 0.5 + aSeed * 6.2831;
          pos.x += sin(t) * 0.012;
          pos.y += cos(t * 1.17) * 0.012;
          pos.z += sin(t * 0.83) * 0.009;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          vTwinkle = 0.65 + 0.35 * sin(uTime * 1.9 + aSeed * 13.0);
          gl_PointSize = uDotScale * aSize * uPixelRatio * (16.0 / -mv.z);
        }
      `,
      fragmentShader: `
        uniform float uAlpha;
        varying float vTwinkle;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = 1.0 - smoothstep(0.40, 0.50, d);
          gl_FragColor = vec4(vec3(1.0), edge * vTwinkle * uAlpha);
        }
      `,
    })
    const innerPoints = new THREE.Points(innerGeom, innerMaterial)
    scene.add(innerPoints)

    // ── Ambient brand-accent dots (purple-magenta glow) ─────────────────
    // These sit on a separate mesh that never morphs — they live through
    // every section of the journey and just twinkle/drift in place. Soft
    // gaussian glow per particle, additive blending so they read against
    // the black backdrop as small bright "stars" in the brand colour.
    const accentPositions = new Float32Array(ACCENT_COUNT * 3)
    const accentSeeds     = new Float32Array(ACCENT_COUNT)
    const accentSizes     = new Float32Array(ACCENT_COUNT)
    for (let i = 0; i < ACCENT_COUNT; i++) {
      accentPositions[i * 3]     = (Math.random() - 0.5) * 2 * ACCENT_X_HALF
      accentPositions[i * 3 + 1] = (Math.random() - 0.5) * 2 * ACCENT_Y_HALF
      accentPositions[i * 3 + 2] = (Math.random() - 0.5) * 2 * ACCENT_Z_HALF
      accentSeeds[i] = Math.random()
      // Heavy bias toward small dots, with a few larger glowy ones for
      // visual interest — `pow(r, 3)` keeps most particles tiny.
      accentSizes[i] = 0.45 + Math.pow(Math.random(), 3) * 1.8
    }
    const accentGeom = new THREE.BufferGeometry()
    accentGeom.setAttribute('position', new THREE.BufferAttribute(accentPositions, 3))
    accentGeom.setAttribute('aSeed',    new THREE.BufferAttribute(accentSeeds, 1))
    accentGeom.setAttribute('aSize',    new THREE.BufferAttribute(accentSizes, 1))

    const accentMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:       { value: 0 },
        uFade:       { value: 1 },
        uColor:      { value: ACCENT_COLOR },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uPixelRatio;
        attribute float aSeed;
        attribute float aSize;
        varying float vTwinkle;
        void main() {
          vec3 pos = position;
          // Gentle drift — each dot floats on its own phase.
          float t = uTime * 0.28 + aSeed * 6.2831;
          pos.x += sin(t)         * 0.10;
          pos.y += cos(t * 1.13)  * 0.10;
          pos.z += sin(t * 0.87)  * 0.07;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          // Slow brand twinkle, ranging 0.45 .. 1.0 so even the dim end
          // of the cycle is still visibly present.
          vTwinkle = 0.45 + 0.55 * sin(uTime * 1.15 + aSeed * 11.0);
          // Larger base radius than the main pinpricks so the gaussian
          // glow has room to fall off softly.
          gl_PointSize = aSize * uPixelRatio * (26.0 / -mv.z);
        }
      `,
      fragmentShader: `
        uniform vec3  uColor;
        uniform float uFade;
        varying float vTwinkle;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          // Soft gaussian falloff — bright tight core, glow halo around it.
          float glow = exp(-d * d * 16.0);
          gl_FragColor = vec4(uColor, glow * vTwinkle * uFade);
        }
      `,
    })
    const accentPoints = new THREE.Points(accentGeom, accentMaterial)
    scene.add(accentPoints)

    // ── Animation loop ─────────────────────────────────────────────────
    let rafId = 0
    let running = true
    let progressRef = 0
    const startTime = performance.now()

    // Pick the source/target position buffers + interpolation t for the
    // current scroll progress. Each phase has its own pair.
    function pickPhase(p: number): { source: Float32Array; target: Float32Array; t: number } {
      if (p < ASSEMBLY_END) {
        return { source: targets.start, target: targets.cluster, t: easeOutCubic(p / ASSEMBLY_END) }
      }
      if (p < WAVES_START) {
        return { source: targets.cluster, target: targets.cluster, t: 0 }
      }
      if (p < WAVES_END) {
        return { source: targets.cluster, target: targets.waves, t: smoothstep(WAVES_START, WAVES_END, p) }
      }
      if (p < BURST_START) {
        return { source: targets.waves, target: targets.waves, t: 0 }
      }
      if (p < BURST_END) {
        return { source: targets.waves, target: targets.burst, t: smoothstep(BURST_START, BURST_END, p) }
      }
      // Burst is the final particle target — it just holds while the login
      // form fades in over it.
      return { source: targets.burst, target: targets.burst, t: 0 }
    }

    function syncToProgress(p: number) {
      progressRef = p
      const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
      const arr = posAttr.array as Float32Array
      const { source, target, t } = pickPhase(p)
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3
        arr[i3]     = source[i3]     + (target[i3]     - source[i3])     * t
        arr[i3 + 1] = source[i3 + 1] + (target[i3 + 1] - source[i3 + 1]) * t
        arr[i3 + 2] = source[i3 + 2] + (target[i3 + 2] - source[i3 + 2]) * t
      }
      posAttr.needsUpdate = true
      material.uniforms.uProgress.value = p

      // Dot size profile:
      //   sections 1-2 (0..0.33)     → 1.0   (normal pinpricks)
      //   section 3   (0.33..0.50)   → 1.0 → 0.7 (sphere + dots shrink together)
      //   section 4   (0.50..0.66)   → 0.7 → 0.55 (sea waves with smaller dots)
      //   sections 5-6 (0.66..1)     → 0.55 (burst filaments + login overlay)
      let dotScale = 1.0
      if (p >= SHRINK_START && p < SHRINK_END) {
        dotScale = 1.0 - (1.0 - 0.7) * smoothstep(SHRINK_START, SHRINK_END, p)
      } else if (p >= SHRINK_END && p < WAVES_END) {
        dotScale = 0.7 - (0.7 - 0.55) * smoothstep(SHRINK_END, WAVES_END, p)
      } else if (p >= WAVES_END) {
        dotScale = 0.55
      }
      material.uniforms.uDotScale.value = dotScale
      innerMaterial.uniforms.uDotScale.value = dotScale

      // Tier contrast lives only on the (now-removed) neuron phase — keep
      // dots uniformly sized throughout the rest of the journey.
      material.uniforms.uTierMix.value = 0

      // Main mesh scale shrinks during section 3 to make the spheroid
      // visibly smaller. Bounces back to 1.0 from section 4 onward so the
      // waves + burst buffers display at their authored size.
      let meshScale = 1.0
      if (p >= SHRINK_START && p < SHRINK_END) {
        meshScale = 1.0 - (1.0 - MAIN_SHRINK) * smoothstep(SHRINK_START, SHRINK_END, p)
      } else if (p >= SHRINK_END && p < WAVES_START) {
        meshScale = MAIN_SHRINK
      }
      points.scale.setScalar(meshScale)
      innerPoints.scale.setScalar(meshScale)

      // Inner sphere visibility window — fades in during section 3, fades
      // back out as the waves start to break the main cluster apart.
      let innerAlpha = 0
      if (p >= SHRINK_START && p < SHRINK_END) {
        innerAlpha = smoothstep(SHRINK_START, SHRINK_START + 0.10, p)
      } else if (p >= SHRINK_END && p < WAVES_START + 0.05) {
        innerAlpha = 1
      } else if (p >= WAVES_START + 0.05 && p < WAVES_START + 0.12) {
        innerAlpha = 1 - smoothstep(WAVES_START + 0.05, WAVES_START + 0.12, p)
      }
      innerMaterial.uniforms.uAlpha.value = innerAlpha

      // Cluster recedes as login fades in.
      material.uniforms.uFade.value = 1 - smoothstep(LOGIN_START, 1.0, p) * 0.6
      // Accent dots stay more visible (only dip to ~0.55) so the brand
      // colour is still present behind the login card.
      accentMaterial.uniforms.uFade.value = 1 - smoothstep(LOGIN_START, 1.0, p) * 0.45
    }

    function frame() {
      if (!running) return
      const time = (performance.now() - startTime) / 1000
      material.uniforms.uTime.value = time
      innerMaterial.uniforms.uTime.value = time
      accentMaterial.uniforms.uTime.value = time

      camera.position.z = CAMERA_Z - progressRef * 0.4

      // Rotation: very gentle once the spheroid is formed — the cluster
      // should feel like it's hanging in space, not whirring around. We
      // back off during waves (the surface reads best face-on) and add a
      // touch back in once the burst filaments take over.
      const assembled = Math.min(1, Math.max(0, progressRef / ASSEMBLY_END))
      const wavesActive = smoothstep(WAVES_START - 0.05, WAVES_END, progressRef)
      const burstActive = smoothstep(BURST_START - 0.02, BURST_END, progressRef)
      const rotRate = 0.015
                    + assembled * 0.045 * (1 - wavesActive)
                    + 0.020 * burstActive
      points.rotation.y = time * rotRate + Math.sin(time * 0.35) * 0.03

      // Inner mesh counter-rotates so it reads as a distinct nested body.
      innerPoints.rotation.y = -time * (0.06 + assembled * 0.22)

      renderer.render(scene, camera)
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    syncToProgress(reducedMotion ? 1 : 0)

    const onResize = () => {
      setSize()
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    ;(canvas as HTMLCanvasElement & { __sync?: (p: number) => void }).__sync = syncToProgress

    return () => {
      running = false
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      geom.dispose()
      material.dispose()
      innerGeom.dispose()
      innerMaterial.dispose()
      accentGeom.dispose()
      accentMaterial.dispose()
      renderer.dispose()
    }
  }, [targets, reducedMotion])

  // ── Scroll listener ────────────────────────────────────────────────────
  useEffect(() => {
    if (reducedMotion) {
      setProgress(1)
      return
    }
    // Latest scroll progress, mirrored to a ref so the audio time-update
    // listener can read it without re-binding on every scroll event.
    const latestProgress = { current: 0 }

    // Smoothly nudge the audio's playbackRate toward sync without ever
    // seeking — every `audio.currentTime = …` flushes the MP3 decoder
    // buffer and produces an audible click ("creak"). Tiny rate changes
    // are inaudible (`preservesPitch` keeps the pitch identical).
    const reconcileAudio = () => {
      const audio = audioRef.current
      if (!audio || !audioStartedRef.current || audio.paused || audio.ended) return
      const target = latestProgress.current * AUDIO_DURATION
      const drift = target - audio.currentTime
      // Only seek for huge jumps (e.g., user smashes Page Down or End).
      // 3 s buys plenty of room for normal scrolling without seek clicks.
      if (Math.abs(drift) > 3) {
        audio.currentTime = target
        audio.playbackRate = 1
        return
      }
      // Glide: drift > 0 → audio is behind → speed up; drift < 0 → slow.
      // Clamp range is narrow enough that pitch-preservation keeps things
      // smooth and the rate never sounds obviously off.
      const rate = Math.max(0.85, Math.min(1.2, 1 + drift * 0.30))
      // Avoid trivial setter calls that some browsers treat as a state
      // change — only update if the delta is meaningful.
      if (Math.abs(audio.playbackRate - rate) > 0.005) audio.playbackRate = rate
    }

    // Try to start the audio. Browsers block autoplay until a user
    // gesture, so the *first* attempt is allowed to fail — subsequent
    // gesture handlers (click / touch / key) below will retry.
    const tryStartAudio = (scrollProgress: number) => {
      const audio = audioRef.current
      if (!audio || audioStartedRef.current) return
      audioStartedRef.current = true
      // Avoid pitch-shifted "chipmunk" sound during rate corrections.
      // Cast covers the WebKit-only `preservesPitch` prefix.
      const a = audio as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean }
      a.preservesPitch = true
      if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true
      if ('mozPreservesPitch' in a) a.mozPreservesPitch = true
      audio.currentTime = scrollProgress * AUDIO_DURATION
      audio.play().catch(err => {
        // Most common: NotAllowedError when the browser hasn't seen a
        // qualifying gesture yet. Clear the flag so the next gesture
        // handler retries.
        audioStartedRef.current = false
        console.warn('[landing] intro.mp3 autoplay blocked or failed:', err.name, err.message)
      })
    }

    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
        const p = Math.min(1, Math.max(0, window.scrollY / max))
        setProgress(p)
        latestProgress.current = p
        const canvas = canvasRef.current as (HTMLCanvasElement & { __sync?: (p: number) => void }) | null
        canvas?.__sync?.(p)

        const audio = audioRef.current
        if (audio) {
          if (!audioStartedRef.current && p > 0.005) {
            tryStartAudio(p)
          } else if (audioStartedRef.current) {
            reconcileAudio()
            // Pause once the user is parked at the bottom; resume if they
            // scroll back upward.
            if (p >= 0.999) {
              if (!audio.paused) audio.pause()
            } else if (audio.paused) {
              audio.play().catch(() => { /* ignore */ })
            }
          }
        }
      })
    }

    // Continuously nudge playbackRate as the audio plays, even while the
    // user is stationary — keeps the rate decaying back to 1.0 once drift
    // shrinks, instead of stranding it at the last scroll-event value.
    const onTimeUpdate = () => reconcileAudio()

    const audioEl = audioRef.current
    audioEl?.addEventListener('timeupdate', onTimeUpdate)

    // Fallback gesture listeners — Safari (and Chrome under some site-
    // engagement settings) won't count a passive scroll as a user
    // activation, but a pointerdown / keydown / touchstart always does.
    const gestureStart = () => {
      const p = Math.min(1, Math.max(0, window.scrollY
        / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)))
      tryStartAudio(Math.max(p, 0.005))
    }

    // Horizontal trackpad / wheel input → vertical scroll. Lets users
    // navigate the journey by swiping left/right on a trackpad, by
    // tilting a mouse-wheel sideways, or by holding Shift while
    // scrolling. We only redirect when the horizontal delta exceeds the
    // vertical one so normal up/down scrolling stays untouched.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 0.5) {
        window.scrollBy({ top: e.deltaX, behavior: 'auto' })
        e.preventDefault()
      }
    }

    // Keyboard navigation — Arrow Left / Right step ~half a section,
    // Home / End jump to the extremes. Skipped when the user is typing
    // in the login form so they can still tab around inside inputs.
    const onArrowKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
      const step = window.innerHeight * 0.5
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        window.scrollBy({ top: step, behavior: 'smooth' })
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        window.scrollBy({ top: -step, behavior: 'smooth' })
      } else if (e.key === 'Home') {
        e.preventDefault()
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } else if (e.key === 'End') {
        e.preventDefault()
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onArrowKey)
    window.addEventListener('pointerdown', gestureStart, { passive: true })
    window.addEventListener('touchstart', gestureStart, { passive: true })
    window.addEventListener('keydown', gestureStart)
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onArrowKey)
      window.removeEventListener('pointerdown', gestureStart)
      window.removeEventListener('touchstart', gestureStart)
      window.removeEventListener('keydown', gestureStart)
      audioEl?.removeEventListener('timeupdate', onTimeUpdate)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reducedMotion])

  // Per-section opacities — derived from scroll progress.
  const introOpacity     = Math.max(0, 1 - progress * 6)
  const headline1Opacity = smoothstep(0.18, 0.24, progress) * (1 - smoothstep(0.30, 0.34, progress))
  const labelOpacity     = smoothstep(0.36, 0.46, progress) * (1 - smoothstep(0.50, 0.58, progress))
  const wavesTextOpacity = smoothstep(0.54, 0.62, progress) * (1 - smoothstep(0.66, 0.72, progress))
  const loginOpacity     = smoothstep(LOGIN_START, 1.0, progress)

  return (
    <div className="landing-cursor-zone relative md:cursor-none" style={{ background: '#000' }}>
      {/* Restore a sensible native cursor on focusable form chrome —
          otherwise `cursor: none` from the wrapper would inherit and
          make text inputs feel broken even though the custom cursor
          still overlays its I-beam variant. Mobile (no md:) keeps the
          OS default cursor everywhere. */}
      <style>{`
        @media (min-width: 768px) {
          .landing-cursor-zone input,
          .landing-cursor-zone textarea,
          .landing-cursor-zone [contenteditable="true"] { cursor: text; }
          .landing-cursor-zone button,
          .landing-cursor-zone a,
          .landing-cursor-zone [role="button"] { cursor: pointer; }
        }
      `}</style>
      <InteractiveCursor />
      <audio
        ref={audioRef}
        src="/audio/intro.mp3"
        preload="auto"
        onError={e => {
          const el = e.currentTarget
          console.warn('[landing] intro.mp3 failed to load —',
            'networkState:', el.networkState,
            'error:', el.error?.code, el.error?.message)
        }}
      />

      {/* Fixed canvas — the particle journey lives here for the whole page */}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 w-full h-full z-0"
        style={{ background: '#000' }}
      />

      {/* Skip-to-sign-in escape hatch */}
      <button
        type="button"
        onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })}
        className="fixed top-6 right-6 z-50 text-[11px] font-semibold tracking-[0.25em] uppercase text-white/40 hover:text-white transition-colors"
      >
        Skip ↓
      </button>

      {/* Branding chip top-left */}
      <div className="fixed top-6 left-6 z-50 flex items-center gap-2 text-white/70">
        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/15 flex items-center justify-center text-white font-serif text-sm">N</div>
        <div>
          <p className="text-xs font-serif leading-none">Nerve</p>
          <p className="text-[10px] text-white/35 mt-0.5">Parul University</p>
        </div>
      </div>

      {/* Department labels — bigger font, positioned close to the spheroid's
          screen-centre edges. Visible only during the section-3 reveal. */}
      {([
        { label: 'Branding',       pos: 'top-[26%]    left-1/2 -translate-x-1/2'                          },
        { label: 'Outreach',       pos: 'top-1/2      right-[14%] -translate-y-1/2 text-right'           },
        { label: 'Content',        pos: 'bottom-[26%] left-1/2 -translate-x-1/2'                          },
        { label: 'Office of CEO',  pos: 'top-1/2      left-[12%]  -translate-y-1/2 text-left'            },
      ] as const).map(d => (
        <div
          key={d.label}
          style={{ opacity: labelOpacity }}
          className={`fixed ${d.pos} z-30 pointer-events-none transition-opacity duration-200`}
        >
          <p
            className="text-base md:text-xl uppercase tracking-[0.32em] text-white font-black"
            style={{ fontWeight: 900 }}
          >
            {d.label}
          </p>
        </div>
      ))}

      {/* Section 1 — assembly starts */}
      <section className="relative z-20 h-screen flex items-center justify-center text-center px-6 pointer-events-none">
        <div style={{ opacity: introOpacity }} className="transition-opacity duration-100">
          <p className="text-[10px] uppercase tracking-[0.4em] text-white/40 mb-4">Click and scroll</p>
          <h1
            className="text-white text-6xl md:text-8xl lg:text-9xl"
            style={{
              fontFamily: '"Orbitron", sans-serif',
              fontWeight: 900,
              letterSpacing: '0.18em',
              textShadow: '0 0 24px rgba(255,255,255,0.18)',
            }}
          >
            NERVE
          </h1>
        </div>
      </section>

      {/* Section 2 — assembly completes */}
      <section className="relative z-20 h-screen flex items-center justify-center text-center px-6 pointer-events-none">
        <div style={{ opacity: headline1Opacity }} className="transition-opacity duration-200">
          <h2 className="text-2xl md:text-4xl font-serif font-light text-white/90">Every report. Every signal.</h2>
        </div>
      </section>

      {/* Section 3 — spheroid shrinks, inner sphere reveals, dept labels */}
      <section className="relative z-20 h-screen pointer-events-none" />

      {/* Section 4 — spheroid breaks into waves */}
      <section className="relative z-20 h-screen flex items-center justify-center text-center px-6 pointer-events-none">
        <div style={{ opacity: wavesTextOpacity }} className="transition-opacity duration-200">
          <h2 className="text-2xl md:text-4xl font-serif font-light text-white/90 max-w-2xl">
            One living workspace for all scattered work.
          </h2>
        </div>
      </section>

      {/* Section 5 — sea resolves into the final radial filament burst */}
      <section className="relative z-20 h-screen pointer-events-none" />

      {/* Section 6 — login form fades in over the burst */}
      <section className="relative z-30 h-screen flex items-center justify-center px-4">
        <div
          style={{
            opacity: loginOpacity,
            transform: `translateY(${(1 - loginOpacity) * 16}px)`,
            pointerEvents: loginOpacity > 0.4 ? 'auto' : 'none',
          }}
          className="transition-opacity duration-200 w-full max-w-sm"
        >
          <div className="text-center mb-6">
            <h2
              className="text-3xl md:text-4xl font-serif font-bold text-[#ffe4f2]"
              style={{ textShadow: '0 0 32px rgba(255,228,242,0.65)' }}
            >
              Welcome to Nerve.
            </h2>
            <p className="text-xs font-bold text-[#ffe4f2]/90 mt-1.5 tracking-wider">Sign in to your workspace</p>
          </div>
          <LoginForm dark />
          <p className="text-center text-[11px] font-bold text-[#ffe4f2]/70 mt-6 tracking-wide">
            Access is granted by your Super Admin.
          </p>
        </div>
      </section>
    </div>
  )
}
