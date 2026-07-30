import { actions, useAppStore } from '../store/appStore'
import './Hud.css'

const DEG = 180 / Math.PI

/**
 * Reads the store the React way. Each selector returns a rounded primitive,
 * so a re-render only happens when a displayed value actually changes rather
 * than on every animation frame.
 */
export function Hud() {
  const longitude = useAppStore((s) => Math.round(s.longitude * DEG))
  const latitude = useAppStore((s) => Math.round(s.latitude * DEG))
  const zoom = useAppStore((s) => s.zoom.toFixed(2))
  const autoRotate = useAppStore((s) => s.autoRotate)

  // Rounded inside the selector, so spinning the globe only re-renders when
  // the displayed figure actually changes.
  const hoverLon = useAppStore((s) => round1(s.hoverLongitude))
  const hoverLat = useAppStore((s) => round1(s.hoverLatitude))
  const overGlobe = hoverLat !== null && hoverLon !== null

  return (
    <div className="hud">
      <h1 className="hud__title">ersetu</h1>
      <dl className="hud__readout">
        <dt>lon</dt>
        <dd>{longitude}&deg;</dd>
        <dt>lat</dt>
        <dd>{latitude}&deg;</dd>
        <dt>zoom</dt>
        <dd>{zoom}&times;</dd>
      </dl>
      <div className="hud__cursor">
        <span className="hud__cursor-label">cursor</span>
        <span className="hud__cursor-value">
          {overGlobe ? `${format(hoverLat, 'N', 'S')}  ${format(hoverLon, 'E', 'W')}` : '—'}
        </span>
      </div>
      <div className="hud__controls">
        <button type="button" onClick={actions.toggleAutoRotate}>
          {autoRotate ? 'Pause' : 'Spin'}
        </button>
        <button type="button" onClick={actions.reset}>
          Reset
        </button>
      </div>
      <p className="hud__hint">Drag to rotate &middot; scroll to zoom</p>
    </div>
  )
}

function round1(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10
}

/** e.g. 51.5°N. Sign is carried by the hemisphere letter, not a minus. */
function format(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(1)}°${value < 0 ? negative : positive}`
}
