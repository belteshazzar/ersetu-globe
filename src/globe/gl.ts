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
precision mediump float;

varying float vHeight;
varying vec2 vDisc;

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

  if (vHeight < 0.0) {
    // Bathymetry as brightness rather than hue, so the ridges, fracture zones
    // and abyssal plains all read without leaving the blue the gradient set.
    // Most of the sea floor lies between two and five kilometres down, which is
    // where this ramp spends its range.
    float deep = clamp(-vHeight / 6000.0, 0.0, 1.0);
    gl_FragColor = vec4(environment * mix(1.30, 0.45, deep), 1.0);
    return;
  }

  // The gradient again, as a light rather than a colour: bright under the
  // highlight, falling away to the limb on the same two stops.
  float shade = t < HORIZON_STOP
    ? mix(1.30, 0.92, t / HORIZON_STOP)
    : mix(0.92, 0.30, (t - HORIZON_STOP) / (1.0 - HORIZON_STOP));
  // Everest is the ceiling; most land sits near the bottom of this, so the
  // range is spent on the ground you actually see rather than on the peaks.
  vec3 tone = mix(LAND, LAND_HIGH, clamp(vHeight / 3500.0, 0.0, 1.0));
  gl_FragColor = vec4(tone * shade, 1.0);
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
}

let ready: Program | null = null

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
  }

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
