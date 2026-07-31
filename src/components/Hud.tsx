import { actions, MAX_EXAGGERATION, useAppStore } from '../store/appStore'
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
  const exaggeration = useAppStore((s) => s.exaggeration)
  const surface = useAppStore((s) => s.surface)
  const mesh = useAppStore((s) => s.mesh)
  const triangles = useAppStore((s) => s.meshTriangles)
  const detail = useAppStore((s) => s.detail)

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
      <div className="hud__field">
        <span className="hud__field-label">surface</span>
        <span className="hud__toggle">
          <button
            type="button"
            aria-pressed={surface === 'metal'}
            onClick={() => actions.setSurface('metal')}
          >
            metal
          </button>
          <button
            type="button"
            aria-pressed={surface === 'flat'}
            onClick={() => actions.setSurface('flat')}
          >
            flat
          </button>
        </span>
      </div>

      <div className="hud__field">
        <span className="hud__field-label">mesh</span>
        <span className="hud__toggle">
          <button
            type="button"
            aria-pressed={mesh === 'uniform'}
            onClick={() => actions.setMesh('uniform')}
          >
            uniform
          </button>
          <button
            type="button"
            aria-pressed={mesh === 'quadtree'}
            onClick={() => actions.setMesh('quadtree')}
          >
            quadtree
          </button>
        </span>
      </div>
      <div className="hud__field">
        <span className="hud__field-label">triangles</span>
        <span className="hud__field-value">{formatCount(triangles)}</span>
      </div>
      <div className="hud__field">
        <span className="hud__field-label">detail</span>
        <span className="hud__field-value">
          L{detail} &middot; {formatSpacing(detail)}
        </span>
      </div>

      <div className="hud__field">
        <label className="hud__field-label" htmlFor="relief">
          relief
        </label>
        <span className="hud__field-value">
          {exaggeration === 0 ? 'off' : `${exaggeration}×`}
        </span>
      </div>
      <input
        id="relief"
        className="hud__slider"
        type="range"
        min={0}
        max={MAX_EXAGGERATION}
        step={1}
        value={exaggeration}
        onChange={(event) => actions.setExaggeration(event.target.valueAsNumber)}
      />

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

/** Thousands separated, so a six-figure mesh reads at a glance. */
function formatCount(value: number) {
  return value.toLocaleString('en-US')
}

/** Ground covered by one sample of a pyramid level, at the equator. */
function formatSpacing(level: number) {
  const km = 40_075 / (512 * 2 ** level)
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`
}

function round1(value: number | null) {
  return value === null ? null : Math.round(value * 10) / 10
}

/** e.g. 51.5°N. Sign is carried by the hemisphere letter, not a minus. */
function format(value: number, positive: string, negative: string) {
  return `${Math.abs(value).toFixed(1)}°${value < 0 ? negative : positive}`
}
