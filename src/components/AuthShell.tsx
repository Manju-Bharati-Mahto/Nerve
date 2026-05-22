/**
 * Shared chrome for all standalone auth routes (/login, /reset-password,
 * /verify-email). Renders the same dark backdrop the landing page ends
 * on — a static radial-filament burst of particles + drifting pearl-pink
 * accent dots + the interactive cursor — and centres the page's actual
 * form content on top via the `children` slot.
 *
 * NB: this is a *snapshot* of the landing-page ending. It doesn't run the
 * scroll-driven morph or play the intro audio — those belong to the
 * landing page proper.
 */
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import InteractiveCursor from './InteractiveCursor'

// ── Tunables ─────────────────────────────────────────────────────────────
const PARTICLE_COUNT = 60_000
const CAMERA_Z = 6

const ACCENT_COUNT = 220
const ACCENT_COLOR = new THREE.Color(0xffe4f2)
const ACCENT_X_HALF = 8.0
const ACCENT_Y_HALF = 4.8
const ACCENT_Z_HALF = 2.5

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

// Same radial-filament burst the landing page settles into at the end.
// Bright dense core + hundreds of curling tendrils + sparse halo.
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

  for (let i = 0; i < CORE_COUNT; i++) {
    randomDirection(dir)
    const r = CORE_R * Math.pow(Math.random(), 0.55)
    arr[idx * 3]     = dir.x * r
    arr[idx * 3 + 1] = dir.y * r
    arr[idx * 3 + 2] = dir.z * r * 0.55
    idx++
  }

  for (let f = 0; f < FILAMENTS && idx < PARTICLE_COUNT - AMBIENT_COUNT; f++) {
    randomDirection(dir)
    const ux = dir.x
    const uy = dir.y
    const uz = dir.z * 0.4
    const inv = 1 / Math.max(1e-4, Math.hypot(ux, uy, uz))
    const nx = ux * inv, ny = uy * inv, nz = uz * inv

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

// ── Component ────────────────────────────────────────────────────────────

export interface AuthShellProps {
  /** Centered form / card content. */
  children: React.ReactNode
  /** Main heading rendered above the form. Defaults to "Welcome to Nerve." */
  heading?: string
  /** Smaller line under the heading. */
  subheading?: string
  /** Footer line below the form. */
  footer?: string
}

export default function AuthShell({
  children,
  heading = 'Welcome to Nerve.',
  subheading = 'Sign in to your workspace',
  footer = 'Access is granted by your Super Admin.',
}: AuthShellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const burstPositions = useMemo(() => buildBurstTargets(), [])

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

    // ── Burst particle mesh (static — same shape as the landing page's
    // final scroll state). Per-particle twinkle phases via aSeed/aSize.
    const positions = new Float32Array(burstPositions)
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    const seeds = new Float32Array(PARTICLE_COUNT)
    const sizes = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      seeds[i] = Math.random()
      sizes[i] = 0.7 + Math.pow(Math.random(), 4) * 1.1
    }
    geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:       { value: 0 },
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
          float t = uTime * 0.4 + aSeed * 6.2831;
          pos.x += sin(t) * 0.025;
          pos.y += cos(t * 1.21) * 0.025;
          pos.z += sin(t * 0.87) * 0.018;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          vTwinkle = 0.55 + 0.45 * sin(uTime * 1.6 + aSeed * 17.0);
          // 0.495 = base 0.55 * progress mix (0.9 at p=1).
          gl_PointSize = 0.495 * aSize * uPixelRatio * (14.0 / -mv.z);
        }
      `,
      fragmentShader: `
        varying float vTwinkle;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float edge = 1.0 - smoothstep(0.40, 0.50, d);
          // 0.4 fade matches the landing-page login overlay state.
          gl_FragColor = vec4(vec3(1.0), vTwinkle * edge * 0.4);
        }
      `,
    })
    const points = new THREE.Points(geom, material)
    scene.add(points)

    // ── Accent dots — same pearl-pink twinklers as the landing page.
    const accentPositions = new Float32Array(ACCENT_COUNT * 3)
    const accentSeeds     = new Float32Array(ACCENT_COUNT)
    const accentSizes     = new Float32Array(ACCENT_COUNT)
    for (let i = 0; i < ACCENT_COUNT; i++) {
      accentPositions[i * 3]     = (Math.random() - 0.5) * 2 * ACCENT_X_HALF
      accentPositions[i * 3 + 1] = (Math.random() - 0.5) * 2 * ACCENT_Y_HALF
      accentPositions[i * 3 + 2] = (Math.random() - 0.5) * 2 * ACCENT_Z_HALF
      accentSeeds[i] = Math.random()
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
          float t = uTime * 0.28 + aSeed * 6.2831;
          pos.x += sin(t)         * 0.10;
          pos.y += cos(t * 1.13)  * 0.10;
          pos.z += sin(t * 0.87)  * 0.07;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          vTwinkle = 0.45 + 0.55 * sin(uTime * 1.15 + aSeed * 11.0);
          gl_PointSize = aSize * uPixelRatio * (26.0 / -mv.z);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vTwinkle;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float glow = exp(-d * d * 16.0);
          gl_FragColor = vec4(uColor, glow * vTwinkle * 0.55);
        }
      `,
    })
    const accentPoints = new THREE.Points(accentGeom, accentMaterial)
    scene.add(accentPoints)

    // ── Animation loop — gentle constant rotation, no scroll.
    let rafId = 0
    let running = true
    const startTime = performance.now()

    const frame = () => {
      if (!running) return
      const time = (performance.now() - startTime) / 1000
      material.uniforms.uTime.value = time
      accentMaterial.uniforms.uTime.value = time
      // Very slow drift so the burst doesn't feel completely frozen.
      points.rotation.y = time * 0.020 + Math.sin(time * 0.35) * 0.03
      renderer.render(scene, camera)
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    const onResize = () => {
      setSize()
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    return () => {
      running = false
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      geom.dispose()
      material.dispose()
      accentGeom.dispose()
      accentMaterial.dispose()
      renderer.dispose()
    }
  }, [burstPositions])

  return (
    <div
      className="landing-cursor-zone relative min-h-screen flex items-center justify-center px-4 md:cursor-none"
      style={{ background: '#000' }}
    >
      {/* Restore native cursor on focusable form chrome — the custom
          cursor still overlays its I-beam / pointer variants on top. */}
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

      <canvas
        ref={canvasRef}
        className="fixed inset-0 w-full h-full z-0"
        style={{ background: '#000' }}
      />

      {/* Branding chip top-left — mirrors the landing page. */}
      <div className="fixed top-6 left-6 z-50 flex items-center gap-2 text-white/70">
        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/15 flex items-center justify-center text-white font-serif text-sm">N</div>
        <div>
          <p className="text-xs font-serif leading-none">Nerve</p>
          <p className="text-[10px] text-white/35 mt-0.5">Parul University</p>
        </div>
      </div>

      <div className="relative z-20 w-full max-w-sm">
        <div className="text-center mb-6">
          <h2
            className="text-3xl md:text-4xl font-serif font-bold text-[#ffe4f2]"
            style={{ textShadow: '0 0 32px rgba(255,228,242,0.65)' }}
          >
            {heading}
          </h2>
          {subheading && (
            <p className="text-xs font-bold text-[#ffe4f2]/90 mt-1.5 tracking-wider">{subheading}</p>
          )}
        </div>
        {children}
        {footer && (
          <p className="text-center text-[11px] font-bold text-[#ffe4f2]/70 mt-6 tracking-wide">
            {footer}
          </p>
        )}
      </div>
    </div>
  )
}
