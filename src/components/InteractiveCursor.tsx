/**
 * Interactive pearl-pink cursor used on the landing page.
 *
 *   • A small filled dot tracks the pointer exactly (no lag).
 *   • A larger ring trails behind with smooth easing, scales up over
 *     interactive elements (buttons / links), and squishes into an
 *     I-beam-ish bar over text inputs.
 *   • When the pointer stays still for >200 ms, a full-screen 2D canvas
 *     starts spawning small pearl-pink dots from random offsets around
 *     the still position and animating them inward. The dots accumulate
 *     for as long as the pointer remains stationary; the moment the
 *     pointer moves again, spawning halts and the in-flight particles
 *     finish their journey and fade out naturally.
 *
 * On touch devices the cursor never receives a mouse event, so all of
 * this stays off-screen — no need to feature-detect.
 */
import { useEffect, useRef, useState } from 'react'

type Variant = 'default' | 'hover' | 'text'

const COLOR = '#ffe4f2'
// Time the pointer must be still before dots start gathering.
const STILL_DELAY_MS = 200
// How often we spawn new particles while still (≈ 50 / sec).
const SPAWN_INTERVAL_MS = 20
// Max particles alive at once — keeps the canvas cheap.
const MAX_PARTICLES = 140

type Particle = {
  startX: number
  startY: number
  targetX: number
  targetY: number
  startTime: number
  duration: number
}

export default function InteractiveCursor() {
  const dotRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [variant, setVariant] = useState<Variant>('default')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let raf = 0
    // Off-screen until the first mousemove so the cursor doesn't flash
    // at (0,0) on page load.
    let mx = -100, my = -100
    let rx = -100, ry = -100

    const setDot = () => {
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${mx}px, ${my}px, 0) translate(-50%, -50%)`
      }
    }
    const setRing = () => {
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`
      }
    }

    const tick = () => {
      raf = 0
      rx += (mx - rx) * 0.22
      ry += (my - ry) * 0.22
      setRing()
      if (Math.abs(mx - rx) > 0.3 || Math.abs(my - ry) > 0.3) {
        raf = requestAnimationFrame(tick)
      }
    }

    // ── Gather-on-hover particle system ────────────────────────────────
    let stillTimer: number | undefined
    let stillPos: { x: number; y: number } | null = null
    const particles: Particle[] = []
    let lastSpawn = 0
    const canvas = canvasRef.current

    const sizeCanvas = () => {
      if (!canvas) return
      const dpr = Math.min(window.devicePixelRatio, 2)
      canvas.width = Math.floor(window.innerWidth * dpr)
      canvas.height = Math.floor(window.innerHeight * dpr)
      canvas.style.width = window.innerWidth + 'px'
      canvas.style.height = window.innerHeight + 'px'
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    sizeCanvas()
    window.addEventListener('resize', sizeCanvas)

    let drawRaf = 0
    const drawParticles = () => {
      drawRaf = 0
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return

      const now = performance.now()
      // Clear in CSS pixels (transform already baked in via setTransform).
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

      // Spawn new particles while the pointer has been still long enough.
      if (stillPos && now - lastSpawn > SPAWN_INTERVAL_MS && particles.length < MAX_PARTICLES) {
        lastSpawn = now
        const angle = Math.random() * Math.PI * 2
        // Random distance — most spawn close, a few from far away for variety.
        const dist = 90 + Math.pow(Math.random(), 0.6) * 240
        particles.push({
          startX: stillPos.x + Math.cos(angle) * dist,
          startY: stillPos.y + Math.sin(angle) * dist,
          targetX: stillPos.x,
          targetY: stillPos.y,
          startTime: now,
          duration: 700 + Math.random() * 450,
        })
      }

      // Draw + update.
      ctx.globalCompositeOperation = 'lighter'
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        const t = Math.min(1, (now - p.startTime) / p.duration)
        if (t >= 1) {
          particles.splice(i, 1)
          continue
        }
        // easeOutCubic — slow approach right before the gather point.
        const eased = 1 - Math.pow(1 - t, 3)
        const x = p.startX + (p.targetX - p.startX) * eased
        const y = p.startY + (p.targetY - p.startY) * eased
        // Fade in 0..0.15, hold 0.15..0.80, fade out 0.80..1.
        let alpha: number
        if (t < 0.15) alpha = t / 0.15
        else if (t > 0.80) alpha = (1 - t) / 0.20
        else alpha = 1
        // Slight size growth as it nears the target.
        const radius = 1.4 + eased * 1.0
        // Outer soft halo.
        ctx.fillStyle = `rgba(255,228,242,${alpha * 0.20})`
        ctx.beginPath()
        ctx.arc(x, y, radius * 4, 0, Math.PI * 2)
        ctx.fill()
        // Crisp core.
        ctx.fillStyle = `rgba(255,228,242,${alpha})`
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // Keep ticking while particles are still alive OR we're still
      // accumulating new ones — otherwise the canvas stays idle.
      if (particles.length > 0 || stillPos) {
        drawRaf = requestAnimationFrame(drawParticles)
      }
    }

    const startDrawIfNeeded = () => {
      if (!drawRaf) drawRaf = requestAnimationFrame(drawParticles)
    }

    // ── Mouse handlers ─────────────────────────────────────────────────
    const onMove = (e: MouseEvent) => {
      if (!visible) setVisible(true)
      mx = e.clientX
      my = e.clientY
      setDot()
      if (!raf) raf = requestAnimationFrame(tick)

      // The pointer moved — clear the "still" state and arm a new timer.
      // Particles already in flight finish their journey naturally; new
      // ones simply stop spawning until the pointer parks again.
      if (stillTimer) window.clearTimeout(stillTimer)
      stillPos = null
      stillTimer = window.setTimeout(() => {
        stillPos = { x: mx, y: my }
        lastSpawn = 0
        startDrawIfNeeded()
      }, STILL_DELAY_MS)
    }

    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target?.closest) return
      if (target.closest('input, textarea')) setVariant('text')
      else if (target.closest('a, button, [role="button"], label, [data-cursor-hover]')) setVariant('hover')
      else setVariant('default')
    }

    const onLeave = () => {
      setVisible(false)
      if (stillTimer) window.clearTimeout(stillTimer)
      stillPos = null
    }
    const onEnter = () => setVisible(true)

    // Scroll suspends gathering — even when the pointer is stationary in
    // screen space, the world *behind* the cursor is moving, so a fixed
    // gather point reads as a glitch. We treat every scroll event like
    // a pointer movement: clear stillPos, clear the timer, and re-arm
    // it (so the effect resumes after the user pauses scrolling).
    const onScroll = () => {
      if (stillTimer) window.clearTimeout(stillTimer)
      stillPos = null
      stillTimer = window.setTimeout(() => {
        stillPos = { x: mx, y: my }
        lastSpawn = 0
        startDrawIfNeeded()
      }, STILL_DELAY_MS)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', onScroll, { passive: true })
    document.addEventListener('mouseover', onOver)
    document.documentElement.addEventListener('mouseleave', onLeave)
    document.documentElement.addEventListener('mouseenter', onEnter)

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('wheel', onScroll)
      document.removeEventListener('mouseover', onOver)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      document.documentElement.removeEventListener('mouseenter', onEnter)
      window.removeEventListener('resize', sizeCanvas)
      if (raf) cancelAnimationFrame(raf)
      if (drawRaf) cancelAnimationFrame(drawRaf)
      if (stillTimer) window.clearTimeout(stillTimer)
    }
  }, [visible])

  // Per-variant ring geometry.
  const ringStyle = (() => {
    switch (variant) {
      case 'hover': return { width: 64, height: 64, borderRadius: '50%' }
      case 'text':  return { width: 4,  height: 28, borderRadius: 2 }
      default:      return { width: 34, height: 34, borderRadius: '50%' }
    }
  })()

  const wrapperOpacity = visible ? 1 : 0

  return (
    <>
      {/* Gather canvas — sits between the page background and the cursor
          dot/ring. Pointer-events disabled so it never blocks clicks. */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="fixed inset-0 pointer-events-none z-[98] hidden md:block"
      />
      <div
        ref={dotRef}
        aria-hidden
        className="fixed top-0 left-0 pointer-events-none z-[100] will-change-transform hidden md:block"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: COLOR,
          boxShadow: `0 0 10px ${COLOR}`,
          opacity: wrapperOpacity,
          transition: 'opacity 200ms ease',
        }}
      />
      <div
        ref={ringRef}
        aria-hidden
        className="fixed top-0 left-0 pointer-events-none z-[99] will-change-transform hidden md:block transition-[width,height,border-radius,background-color,opacity] duration-200 ease-out"
        style={{
          ...ringStyle,
          border: `1.5px solid ${COLOR}`,
          background: variant === 'hover' ? 'rgba(255,228,242,0.12)' : 'transparent',
          boxShadow: '0 0 14px rgba(255,228,242,0.35)',
          opacity: wrapperOpacity * (variant === 'text' ? 0.95 : 0.6),
        }}
      />
    </>
  )
}
