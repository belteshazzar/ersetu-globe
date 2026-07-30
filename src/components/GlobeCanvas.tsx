import { useEffect, useRef } from 'react'
import { actions, appStore } from '../store/appStore'
import { globeCamera, renderGlobe, type Viewport } from '../globe/renderer'
import { unproject } from '../globe/projection'
import { DEMO_SHAPES } from '../globe/demoShapes'
import { DEMO_ORBITS, DEMO_TIME_SCALE } from '../globe/demoOrbits'
import { DEMO_LABELS } from '../globe/demoLabels'
import './GlobeCanvas.css'

const AUTO_ROTATE_SPEED = 0.0035 // radians per frame
const DRAG_SENSITIVITY = 0.005 // radians per CSS pixel

/**
 * Owns the <canvas>: sizing, the animation loop, and pointer input.
 *
 * Deliberately does NOT subscribe to the store via useAppStore. The render
 * loop reads state imperatively each frame, so store updates never trigger a
 * React re-render of this component.
 */
export function GlobeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Viewport>({ width: 0, height: 0, dpr: 1 })
  // Latest pointer position in CSS pixels, or null when it is off the canvas.
  const pointerRef = useRef<{ x: number; y: number } | null>(null)

  // Keep the backing store sized to the element and the display density.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = canvas.getBoundingClientRect()
      if (width === 0 || height === 0) return
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      viewportRef.current = { width, height, dpr }
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  // The animation loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let handle = 0
    let last = performance.now()

    const frame = (now: number) => {
      // Clamp the step so a backgrounded tab does not resume with a jump.
      const delta = Math.min(0.1, (now - last) / 1000)
      last = now

      const state = appStore.getState()
      if (state.autoRotate) actions.rotateBy(AUTO_ROTATE_SPEED, 0)
      actions.tick(delta)

      const viewport = viewportRef.current
      if (viewport.width > 0) {
        const next = appStore.getState()
        ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0)
        renderGlobe(ctx, viewport, next, {
          shapes: DEMO_SHAPES,
          orbits: DEMO_ORBITS,
          labels: DEMO_LABELS,
          time: next.elapsed * DEMO_TIME_SCALE,
        })

        // Resolved every frame rather than only on pointermove, so the
        // reading stays true while the globe turns under a still cursor.
        const pointer = pointerRef.current
        if (pointer) {
          const point = unproject(globeCamera(viewport, next), pointer.x, pointer.y)
          actions.setHover(point?.longitude ?? null, point?.latitude ?? null)
        }
      }
      handle = requestAnimationFrame(frame)
    }

    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [])

  // Drag to rotate, wheel to zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let dragging = false
    let lastX = 0
    let lastY = 0
    let resumeAutoRotate = false

    const onPointerDown = (event: PointerEvent) => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      resumeAutoRotate = appStore.getState().autoRotate
      actions.setAutoRotate(false)
      canvas.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.offsetX, y: event.offsetY }
      if (!dragging) return
      actions.rotateBy(
        (event.clientX - lastX) * -DRAG_SENSITIVITY,
        (event.clientY - lastY) * DRAG_SENSITIVITY,
      )
      lastX = event.clientX
      lastY = event.clientY
    }

    // Fires when the pointer moves onto the HUD as well as off the window.
    const onPointerLeave = () => {
      pointerRef.current = null
      actions.setHover(null, null)
    }

    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (resumeAutoRotate) actions.setAutoRotate(true)
      canvas.releasePointerCapture(event.pointerId)
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      actions.zoomBy(Math.exp(-event.deltaY * 0.001))
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [])

  return <canvas ref={canvasRef} className="globe-canvas" />
}
