/**
 * Builds the sample 3D models, composed from boxes and cylinders.
 *
 * Run with: node scripts/build-models.mjs
 *
 * These are deliberately crude - a few dozen faces each. At the size a model
 * occupies on the globe there is no room for more, and every face costs a path
 * fill in the renderer.
 *
 * Model space is a unit-ish cube with +Y up and +Z forward. Anything meant to
 * stand on the ground is authored with its base at y = 0, so it can be dropped
 * straight onto the surface; anything that flies is centred on the origin.
 *
 * Faces wind counter-clockwise seen from outside. The renderer does not
 * actually depend on that - it sorts back to front and lights both sides - but
 * getting it right keeps the normals meaningful.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const HULL = [188, 198, 210]
const HULL_DARK = [128, 140, 154]
const PANEL = [38, 62, 116]
const PANEL_EDGE = [70, 96, 150]
const GOLD = [206, 170, 96]
const GLASS = [96, 130, 170]
const GLASS_DARK = [58, 84, 116]
const TYRE = [38, 42, 50]
const PAINT = [196, 88, 72]

/** A fresh, empty model. */
const model = () => ({ positions: [], faces: [], colors: [] })

/** An axis-aligned box, by centre and full size. */
function box(m, [cx, cy, cz], [sx, sy, sz], color) {
  const x = sx / 2
  const y = sy / 2
  const z = sz / 2
  const base = m.positions.length / 3

  for (const [dx, dy, dz] of [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ]) {
    m.positions.push(cx + dx * x, cy + dy * y, cz + dz * z)
  }

  const quads = [
    [4, 5, 6, 7], // +z
    [1, 0, 3, 2], // -z
    [5, 1, 2, 6], // +x
    [0, 4, 7, 3], // -x
    [7, 6, 2, 3], // +y
    [0, 1, 5, 4], // -y
  ]
  for (const [a, b, c, d] of quads) {
    m.faces.push(base + a, base + b, base + c, base + a, base + c, base + d)
    m.colors.push(...color, ...color)
  }
}

/** A cylinder along an axis, capped at both ends. */
function cylinder(m, [cx, cy, cz], radius, length, axis, sides, color) {
  const base = m.positions.length / 3
  const half = length / 2

  // Two rings of points, plus a centre for each cap.
  for (const end of [-half, half]) {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2
      const u = Math.cos(a) * radius
      const v = Math.sin(a) * radius
      if (axis === 'x') m.positions.push(cx + end, cy + u, cz + v)
      else if (axis === 'y') m.positions.push(cx + u, cy + end, cz + v)
      else m.positions.push(cx + u, cy + v, cz + end)
    }
  }
  const centreA = m.positions.length / 3
  if (axis === 'x') m.positions.push(cx - half, cy, cz)
  else if (axis === 'y') m.positions.push(cx, cy - half, cz)
  else m.positions.push(cx, cy, cz - half)
  const centreB = m.positions.length / 3
  if (axis === 'x') m.positions.push(cx + half, cy, cz)
  else if (axis === 'y') m.positions.push(cx, cy + half, cz)
  else m.positions.push(cx, cy, cz + half)

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    const a0 = base + i
    const a1 = base + j
    const b0 = base + sides + i
    const b1 = base + sides + j
    m.faces.push(a0, b0, b1, a0, b1, a1)
    m.colors.push(...color, ...color)
    m.faces.push(centreA, a1, a0)
    m.colors.push(...color)
    m.faces.push(centreB, b0, b1)
    m.colors.push(...color)
  }
}

// --- satellite ------------------------------------------------------------
// A bus with two wings and a dish looking down at the planet.
const satellite = model()
box(satellite, [0, 0, 0], [0.34, 0.3, 0.46], HULL)
box(satellite, [0, 0, -0.26], [0.16, 0.16, 0.08], HULL_DARK)
for (const side of [-1, 1]) {
  box(satellite, [side * 0.28, 0, 0], [0.22, 0.03, 0.05], HULL_DARK) // boom
  box(satellite, [side * 0.72, 0, 0], [0.66, 0.02, 0.44], PANEL)
  box(satellite, [side * 0.72, 0, 0], [0.68, 0.012, 0.46], PANEL_EDGE)
}
cylinder(satellite, [0, -0.24, 0], 0.13, 0.1, 'y', 10, GOLD)
box(satellite, [0, 0.26, 0], [0.02, 0.22, 0.02], HULL_DARK) // antenna

// --- station --------------------------------------------------------------
// A truss with four pairs of wings and a spine of modules across it.
const station = model()
box(station, [0, 0, 0], [1.9, 0.05, 0.05], HULL_DARK)
for (const at of [-0.78, -0.5, 0.5, 0.78]) {
  for (const side of [-1, 1]) {
    box(station, [at, side * 0.34, 0], [0.24, 0.6, 0.02], PANEL)
    box(station, [at, side * 0.34, 0], [0.26, 0.62, 0.012], PANEL_EDGE)
    box(station, [at, side * 0.06, 0], [0.03, 0.06, 0.03], HULL_DARK)
  }
}
cylinder(station, [0, 0, 0], 0.11, 0.9, 'z', 10, HULL)
cylinder(station, [-0.24, 0, 0.1], 0.08, 0.4, 'z', 8, HULL)
cylinder(station, [0.24, 0, 0.1], 0.08, 0.4, 'z', 8, HULL)
box(station, [0, 0.16, 0.34], [0.5, 0.02, 0.16], HULL_DARK) // radiator

// --- building -------------------------------------------------------------
// A tower with two setbacks, standing on y = 0.
const building = model()
box(building, [0, 0.42, 0], [0.44, 0.84, 0.44], GLASS)
box(building, [0, 0.845, 0], [0.46, 0.02, 0.46], GLASS_DARK)
box(building, [0, 1.08, 0], [0.3, 0.44, 0.3], GLASS)
box(building, [0, 1.31, 0], [0.32, 0.02, 0.32], GLASS_DARK)
box(building, [0, 1.44, 0], [0.16, 0.24, 0.16], GLASS)
box(building, [0, 1.72, 0], [0.03, 0.34, 0.03], HULL)

// --- car ------------------------------------------------------------------
// Body, cabin and four wheels, standing on y = 0.
const car = model()
box(car, [0, 0.2, 0], [0.92, 0.2, 0.42], PAINT)
box(car, [-0.04, 0.36, 0], [0.46, 0.16, 0.38], GLASS)
box(car, [0.42, 0.22, 0], [0.06, 0.1, 0.36], GLASS_DARK) // windscreen
for (const x of [-0.28, 0.3]) {
  for (const z of [-0.22, 0.22]) {
    cylinder(car, [x, 0.1, z], 0.1, 0.08, 'z', 8, TYRE)
  }
}

// --- write ----------------------------------------------------------------
const round = (n) => Number(n.toFixed(4))
const target = new URL('../src/globe/data/models/', import.meta.url)
await mkdir(target, { recursive: true })

for (const [name, m] of Object.entries({ satellite, station, building, car })) {
  const json = {
    name,
    positions: m.positions.map(round),
    faces: m.faces,
    colors: m.colors,
  }
  const text = JSON.stringify(json)
  await writeFile(new URL(`${name}.json`, target), text)
  console.log(
    `${name.padEnd(10)} ${String(m.positions.length / 3).padStart(4)} vertices  ` +
      `${String(m.faces.length / 3).padStart(4)} faces  ${(text.length / 1024).toFixed(1)} kB`,
  )
}
