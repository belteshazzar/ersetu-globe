/**
 * The globe's surface, on the GPU.
 *
 * Everything here used to be done in JavaScript against a 2D canvas: each
 * triangle was its own filled path, colour was worked out per face because a
 * path can only take one uniform paint, and occlusion needed the faces sorted
 * back to front by hand. That is a software rasteriser with extra steps, and it
 * cost what software rasterisers cost.
 *
 * A vertex carries the two things that never change - the direction it sits in,
 * and its height above sea level - and the shaders do the rest. Exaggeration is
 * one multiply in the vertex shader, so the slider is free. Height interpolates
 * across each triangle on its way to the fragment shader, so colour is per
 * pixel rather than per face and the banding that came of averaging a whole
 * triangle to one tone is simply gone. Occlusion is the depth buffer.
 *
 * Because a vertex never changes, its buffer never changes either. The mesh is
 * uploaded once, in chunks, and a frame is three uniforms and one draw call per
 * chunk that survives culling - no vertex data crosses the bus at all. The
 * chunks share a single index buffer, since every one of them is the same
 * triangular grid over a different patch of sphere.
 */
import type { Camera } from './projection'
import { spanEast, type Field, type Overlay } from './overlay'

const EARTH_RADIUS_M = 6_371_000

const VERTEX_SOURCE = `
attribute vec3 aDirection;
attribute float aHeight;

uniform mat3 uRotation;
uniform float uLift;
uniform vec2 uCentre;
uniform float uRadius;
uniform vec2 uViewport;

varying float vHeight;
varying vec2 vDisc;
varying vec3 vDirection;

void main() {
  // The whole of the exaggeration control: the vertex holds the shape of the
  // ground, not the shape of this frame's globe.
  vec3 world = aDirection * (1.0 + aHeight * uLift);
  vec3 view = uRotation * world;

  // Orthographic, so there is no perspective divide - screen position is the
  // camera-space x and y scaled by the radius the globe is drawn at.
  vec2 pixel = uCentre + vec2(view.x, -view.y) * uRadius;

  vHeight = aHeight;
  // Where this lands on the disc, in globe radii, which is all the environment
  // gradient needs: it is fixed to the disc, not to the ground.
  vDisc = view.xy;
  // The undisplaced direction, for the overlay to turn back into a longitude
  // and a latitude. Undisplaced, so that raising the relief slider slides the
  // ground about beneath a map that stays put.
  vDirection = aDirection;
  gl_Position = vec4(
    pixel.x / uViewport.x * 2.0 - 1.0,
    1.0 - pixel.y / uViewport.y * 2.0,
    // Camera-space z runs to about +/-1 globe radius, and nearer is larger, so
    // this maps it into clip depth with nearer winning a LESS test.
    -view.z * 0.5,
    1.0
  );
}
`

/**
 * The same paint the bare sphere wears before any terrain arrives, so that the
 * moment the geometry takes over is a change of shape and not a change of
 * scene.
 *
 * The gradient is `paintSphere`'s, stop for stop: an environment fixed to the
 * disc rather than to the ground, which is what makes it read as a lit ball
 * rather than as paint. Keep the two in step; they are two renderings of one
 * look, and the handover is only invisible while they agree.
 *
 * The sea is that gradient outright. Land takes its grey from the same fill the
 * coastline polygons use, lightening with height so that the relief reads as
 * more than a silhouette, and is then put through the gradient's own falloff so
 * it sits in the same light as the water rather than floating flat on top of
 * it. Nothing here is a normal or a lamp: the ball is lit by where it is on the
 * disc, and the ground by how high it stands.
 */
const FRAGMENT_SOURCE = `
// The overlay takes an arc tangent and an arc cosine per pixel to find out
// where on the map it is. At medium precision those band visibly across a
// continent, so take the better float if the stage has one - almost all do, and
// the guard is for the few that do not.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying float vHeight;
varying vec2 vDisc;
varying vec3 vDirection;

/**
 * The scalar field either side of this moment, and the ramp both are coloured
 * through. Two frames rather than one so that time is a mix of measurements,
 * never a mix of colours - see the note in overlay.ts for why that matters.
 */
uniform sampler2D uField;
uniform sampler2D uFieldNext;
uniform float uMix;
uniform sampler2D uPalette;
/** How much of the overlay to show. Zero is off, and skips all of it. */
uniform float uOverlay;
/**
 * Where the field lies: the west edge and the width it spans, then the north
 * edge and the height, all as fractions of the globe.
 */
uniform vec4 uBounds;

// paintSphere's inner circle: offset up and left, so the highlight sits where a
// light would put it.
const vec2 FOCUS = vec2(-0.25, 0.35);
const float INNER = 0.05;

const vec3 SKY = vec3(0.431, 0.690, 1.000);
const vec3 HORIZON = vec3(0.118, 0.361, 0.745);
const vec3 GROUND = vec3(0.020, 0.071, 0.204);
const float HORIZON_STOP = 0.55;

const vec3 LAND = vec3(0.322, 0.345, 0.365);
const vec3 LAND_HIGH = vec3(0.860, 0.880, 0.900);

void main() {
  // Canvas interpolates between two circles, so the parameter at a point is how
  // far along the ray from the inner circle it lies - not the plain distance.
  // The ray leaves the outer circle, which is the unit disc, at "exit".
  vec2 offset = vDisc - FOCUS;
  float span = length(offset);
  vec2 ray = span > 0.0 ? offset / span : vec2(1.0, 0.0);
  float along = dot(FOCUS, ray);
  float exit = -along + sqrt(max(0.0, along * along + 1.0 - dot(FOCUS, FOCUS)));
  float t = clamp((span - INNER) / max(1e-4, exit - INNER), 0.0, 1.0);

  // One environment, lit once, and then two materials in it. Water takes the
  // gradient's colour, because that is what water does with a sky; rock takes
  // only its brightness, and keeps its own grey.
  vec3 environment = t < HORIZON_STOP
    ? mix(SKY, HORIZON, t / HORIZON_STOP)
    : mix(HORIZON, GROUND, (t - HORIZON_STOP) / (1.0 - HORIZON_STOP));

  vec3 colour;
  if (vHeight < 0.0) {
    // Bathymetry as brightness rather than hue, so the ridges, fracture zones
    // and abyssal plains all read without leaving the blue the gradient set.
    // Most of the sea floor lies between two and five kilometres down, which is
    // where this ramp spends its range.
    float deep = clamp(-vHeight / 6000.0, 0.0, 1.0);
    colour = environment * mix(1.30, 0.45, deep);
  } else {
    // The gradient again, as a light rather than a colour: bright under the
    // highlight, falling away to the limb on the same two stops.
    float shade = t < HORIZON_STOP
      ? mix(1.30, 0.92, t / HORIZON_STOP)
      : mix(0.92, 0.30, (t - HORIZON_STOP) / (1.0 - HORIZON_STOP));
    // Everest is the ceiling; most land sits near the bottom of this, so the
    // range is spent on the ground you actually see rather than on the peaks.
    vec3 tone = mix(LAND, LAND_HIGH, clamp(vHeight / 3500.0, 0.0, 1.0));
    colour = tone * shade;
  }

  if (uOverlay > 0.0) {
    // Worked out per pixel, not per vertex, and that is not an optimisation to
    // undo. Longitude runs from -pi to pi, so it jumps the whole way round at
    // the antimeridian; interpolate it across a triangle and every triangle
    // straddling that line smears the entire map through itself. Evaluated
    // here the jump lands between pixels, where it belongs.
    vec3 d = normalize(vDirection);
    float east = atan(d.x, d.z) * 0.1591549431 + 0.5;
    float south = acos(clamp(d.y, -1.0, 1.0)) * 0.3183098862;

    // Measured east from the field's own west edge and wrapped there, so a box
    // crossing the antimeridian needs no special case: fract always lands in
    // one turn, and anything beyond the field's width falls outside it.
    vec2 uv = vec2(
      fract(east - uBounds.x) / uBounds.y,
      (south - uBounds.z) / uBounds.w
    );

    // Outside its box a field says nothing, which is not the same as saying
    // zero: the ground is left exactly as it was.
    if (uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
      // The measurement, then the colour - never the other way about. Mixing
      // the two frames here, before the ramp, is what makes an in-between
      // moment mean something: mixing their colours afterwards would average a
      // blue and a red into a purple belonging to neither.
      float value = mix(texture2D(uField, uv).r, texture2D(uFieldNext, uv).r, uMix);
      vec4 tint = texture2D(uPalette, vec2(value, 0.5));
      colour = mix(colour, tint.rgb, tint.a * uOverlay);
    }
  }

  gl_FragColor = vec4(colour, 1.0);
}
`

type Program = {
  gl: WebGLRenderingContext
  program: WebGLProgram
  aDirection: number
  aHeight: number
  uRotation: WebGLUniformLocation | null
  uLift: WebGLUniformLocation | null
  uCentre: WebGLUniformLocation | null
  uRadius: WebGLUniformLocation | null
  uViewport: WebGLUniformLocation | null
  uOverlay: WebGLUniformLocation | null
  uBounds: WebGLUniformLocation | null
  uMix: WebGLUniformLocation | null
}

let ready: Program | null = null

let paletteTexture: WebGLTexture | null = null
let paletteSource: Uint8Array | null = null
let overlayOpacity = 0
let overlayMix = 0
/** The two frames being drawn between, already uploaded. */
let frameTexture: WebGLTexture | null = null
let nextTexture: WebGLTexture | null = null
/** The field's box as the shader wants it: west, width, north, height. */
const overlayBounds = new Float32Array([0, 1, 0, 1])

/**
 * Every field that has been seen, against the texture holding it.
 *
 * Kept by identity, which is what makes a loop cheap: a sequence of frames
 * cycled over and over is uploaded once each and thereafter costs a map lookup
 * a frame. Uploading the two current frames every time round would be half a
 * megabyte a frame for a global field, to say nothing that was not already
 * said.
 *
 * Bounded, because a caller streaming a long forecast would otherwise hold
 * every hour of it on the card forever. The least recently wanted goes first,
 * which for anything cyclic never fires at all.
 */
const fields = new Map<Field, { texture: WebGLTexture; used: number }>()
const FIELD_CACHE = 32
let fieldClock = 0

/** The one index buffer every chunk draws through, and how long it is. */
let indexBuffer: WebGLBuffer | null = null
let indexCount = 0
/** A vertex buffer per chunk, created the first time that chunk is filled. */
const chunkBuffers: (WebGLBuffer | null)[] = []

export function initGl(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: true,
    premultipliedAlpha: true,
  })
  if (!gl) return false

  const program = link(gl, VERTEX_SOURCE, FRAGMENT_SOURCE)
  if (!program) return false

  ready = {
    gl,
    program,
    aDirection: gl.getAttribLocation(program, 'aDirection'),
    aHeight: gl.getAttribLocation(program, 'aHeight'),
    uRotation: gl.getUniformLocation(program, 'uRotation'),
    uLift: gl.getUniformLocation(program, 'uLift'),
    uCentre: gl.getUniformLocation(program, 'uCentre'),
    uRadius: gl.getUniformLocation(program, 'uRadius'),
    uViewport: gl.getUniformLocation(program, 'uViewport'),
    uOverlay: gl.getUniformLocation(program, 'uOverlay'),
    uBounds: gl.getUniformLocation(program, 'uBounds'),
    uMix: gl.getUniformLocation(program, 'uMix'),
  }

  // Which texture unit each sampler reads. Fixed for the life of the program,
  // so it is said once here rather than every frame.
  gl.useProgram(program)
  gl.uniform1i(gl.getUniformLocation(program, 'uField'), 0)
  gl.uniform1i(gl.getUniformLocation(program, 'uPalette'), 1)
  gl.uniform1i(gl.getUniformLocation(program, 'uFieldNext'), 2)

  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LESS)
  // The surface is a radial height field, so it is star-shaped about the centre
  // and anything turned away from the camera is covered by something in front
  // of it. Half the mesh, dropped before it is shaded.
  gl.enable(gl.CULL_FACE)
  gl.cullFace(gl.BACK)
  gl.frontFace(gl.CCW)
  return true
}

/** Whether there is a context to upload to yet. */
export function glReady(): boolean {
  return ready !== null
}

function link(gl: WebGLRenderingContext, vertex: string, fragment: string) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader failed to compile:', gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }

  const vs = compile(gl.VERTEX_SHADER, vertex)
  const fs = compile(gl.FRAGMENT_SHADER, fragment)
  if (!vs || !fs) return null

  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program failed to link:', gl.getProgramInfoLog(program))
    return null
  }
  return program
}

/**
 * Hand over the triangle list every chunk is drawn through.
 *
 * One buffer for the whole globe: the chunks are all the same triangular grid,
 * differing only in where their vertices sit, so they share their topology as
 * well as their shaders.
 */
export function setMeshIndices(indices: Uint16Array) {
  const it = ready
  if (!it) return
  const { gl } = it
  if (!indexBuffer) indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
  indexCount = indices.length
}

/**
 * Fill one chunk's vertex buffer: direction xyz then height in metres, four
 * floats a vertex.
 *
 * Called once per chunk as the mesh is built, and again only if a finer tile
 * lands under ground that had to settle for a coarse one. After that the buffer
 * sits on the GPU untouched for the rest of the session.
 */
export function setMeshChunk(id: number, vertices: Float32Array) {
  const it = ready
  if (!it) return
  const { gl } = it
  let buffer = chunkBuffers[id]
  if (!buffer) {
    buffer = gl.createBuffer()
    chunkBuffers[id] = buffer
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
}

/**
 * Upload a field, or hand back the texture already holding it.
 *
 * Not mipmapped, deliberately. Longitude wraps within a single quad at the
 * antimeridian, so the hardware sees an enormous rate of change there, picks
 * the coarsest level it has, and draws a blurred line down the Pacific. Fields
 * of weather are smooth enough at these sizes to go without.
 */
function textureFor(gl: WebGLRenderingContext, field: Field): WebGLTexture | null {
  const held = fields.get(field)
  if (held) {
    held.used = ++fieldClock
    return held.texture
  }

  if (fields.size >= FIELD_CACHE) {
    let oldest: Field | null = null
    let oldestUse = Infinity
    for (const [key, value] of fields) {
      if (value.used < oldestUse) {
        oldestUse = value.used
        oldest = key
      }
    }
    if (oldest) {
      gl.deleteTexture(fields.get(oldest)!.texture)
      fields.delete(oldest)
    }
  }

  const texture = gl.createTexture()
  if (!texture) return null
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.LUMINANCE,
    field.width,
    field.height,
    0,
    gl.LUMINANCE,
    gl.UNSIGNED_BYTE,
    field.samples,
  )
  // Only a field that goes the whole way round has an opposite edge worth
  // sampling. A regional one clamps, or the filter reaches across the box and
  // smears the far side of the domain into the near one.
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_S,
    spanEast(field.bounds) >= 360 ? gl.REPEAT : gl.CLAMP_TO_EDGE,
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Plain linear, both ways: the default minification filter wants mipmaps, and
  // a texture asked for one it does not have simply draws black.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  fields.set(field, { texture, used: ++fieldClock })
  return texture
}

/**
 * Hand over the overlay, or null to take it away.
 *
 * Uploads only what has not been seen before, so calling this every frame -
 * with a still frame, or with a loop coming round again - costs a map lookup
 * and an identity comparison.
 */
export function setOverlay(overlay: Overlay | null) {
  const it = ready
  if (!it) return
  const { gl } = it

  if (!overlay) {
    overlayOpacity = 0
    return
  }
  overlayOpacity = overlay.opacity

  // The box comes from the first frame; a sequence shares one domain.
  const box = overlay.field.bounds
  overlayBounds[0] = (box.west + 180) / 360
  overlayBounds[1] = spanEast(box) / 360
  overlayBounds[2] = (90 - box.north) / 180
  overlayBounds[3] = (box.north - box.south) / 180

  frameTexture = textureFor(gl, overlay.field)
  // With nothing to cross to, both samplers read the same frame and the mix is
  // moot - which costs one redundant fetch and keeps the shader branchless.
  nextTexture = overlay.next ? textureFor(gl, overlay.next) : frameTexture
  overlayMix = overlay.next ? (overlay.mix ?? 0) : 0

  if (overlay.palette !== paletteSource) {
    paletteSource = overlay.palette
    if (!paletteTexture) paletteTexture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      overlay.palette,
    )
    // Clamped, so the ends of the scale hold rather than wrapping round from
    // the hottest colour to the coldest.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  }
}

/**
 * Draw the chunks named in `visible`, in one pass.
 *
 * The camera is uniform state, so the whole frame's cost is a handful of
 * uniform writes and one `drawElements` per chunk. Nothing is uploaded.
 */
export function drawMesh(
  camera: Camera,
  viewport: { width: number; height: number; dpr: number },
  exaggeration: number,
  visible: Uint16Array,
  visibleCount: number,
) {
  const it = ready
  if (!it) return
  const { gl } = it

  const width = Math.round(viewport.width * viewport.dpr)
  const height = Math.round(viewport.height * viewport.dpr)
  if (gl.canvas.width !== width || gl.canvas.height !== height) {
    gl.canvas.width = width
    gl.canvas.height = height
  }
  gl.viewport(0, 0, width, height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  if (visibleCount === 0 || indexCount === 0) return

  gl.useProgram(it.program)

  // The camera rotation, as the shader wants it: longitude about the polar
  // axis, then latitude about the one across it.
  const { cosLon, sinLon, cosLat, sinLat } = camera
  // Column major, matching the transform the CPU used to do per vertex:
  //   x1 = x cosLon - z sinLon
  //   z1 = x sinLon + z cosLon
  //   y' = y cosLat - z1 sinLat
  //   z' = y sinLat + z1 cosLat
  gl.uniformMatrix3fv(it.uRotation, false, [
    cosLon, sinLon * -sinLat, sinLon * cosLat,
    0, cosLat, sinLat,
    -sinLon, cosLon * -sinLat, cosLon * cosLat,
  ])
  gl.uniform1f(it.uLift, exaggeration / EARTH_RADIUS_M)
  gl.uniform2f(it.uCentre, camera.cx * viewport.dpr, camera.cy * viewport.dpr)
  gl.uniform1f(it.uRadius, camera.radius * viewport.dpr)
  gl.uniform2f(it.uViewport, width, height)

  // Nothing to sample from means nothing to show, whatever the opacity says.
  const overlay = frameTexture && paletteTexture ? overlayOpacity : 0
  gl.uniform1f(it.uOverlay, overlay)
  if (overlay > 0) {
    gl.uniform4fv(it.uBounds, overlayBounds)
    gl.uniform1f(it.uMix, overlayMix)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, frameTexture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, nextTexture)
  }

  gl.enableVertexAttribArray(it.aDirection)
  gl.enableVertexAttribArray(it.aHeight)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)

  const stride = 4 * 4
  for (let i = 0; i < visibleCount; i++) {
    const buffer = chunkBuffers[visible[i]]
    if (!buffer) continue
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.vertexAttribPointer(it.aDirection, 3, gl.FLOAT, false, stride, 0)
    gl.vertexAttribPointer(it.aHeight, 1, gl.FLOAT, false, stride, 12)
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0)
  }
}
