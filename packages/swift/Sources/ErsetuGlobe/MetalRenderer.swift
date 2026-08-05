//
//  The globe's surface renderer, ported from src/globe/gl.ts.
//
//  The mesh is uploaded once, in chunks, and a frame is one uniform write and
//  one draw call per chunk that survives culling - no vertex data crosses the
//  bus at all. The chunks share a single index buffer, since every one of them
//  is the same triangular grid over a different patch of sphere.
//

import Metal
import MetalKit
import simd

/// Must match the struct in Shaders.metal, field for field.
struct SurfaceUniforms {
    var rotation: simd_float3x3
    var bounds: SIMD4<Float>
    var centre: SIMD2<Float>
    var viewport: SIMD2<Float>
    var lift: Float
    var radius: Float
    var overlay: Float
    var mix: Float
}

struct ViewportSize {
    /// View points - the unit every camera term is in.
    var width: Double
    var height: Double
    /// Backing scale: device pixels per point.
    var scale: Double
}

final class MetalRenderer {
    let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let depthState: MTLDepthStencilState

    /// The one index buffer every chunk draws through, and how long it is.
    private var indexBuffer: MTLBuffer?
    private var indexCount = 0
    /// A vertex buffer per chunk, created the first time that chunk is filled.
    private var chunkBuffers: [MTLBuffer?]

    // Overlay state.
    private var overlayOpacity: Float = 0
    private var overlayMix: Float = 0
    private var overlayBounds = SIMD4<Float>(0, 1, 0, 1)
    private var frameTexture: MTLTexture?
    private var nextTexture: MTLTexture?
    private var paletteTexture: MTLTexture?
    private var paletteSource: [UInt8]?
    /// Every field that has been seen, against the texture holding it - keyed
    /// by identity, so a loop cycled over and over is uploaded once each.
    private var fields: [ObjectIdentifier: (texture: MTLTexture, used: Int)] = [:]
    private let fieldCacheLimit = 32
    private var fieldClock = 0
    /// Bound when there is no overlay, so every texture slot is always valid.
    private let blankTexture: MTLTexture

    init?(chunkCount: Int) {
        // SwiftPM copies the .metal file into the bundle rather than
        // compiling it, so the library is built from source at launch - a few
        // milliseconds, once.
        guard let device = MTLCreateSystemDefaultDevice(),
            let queue = device.makeCommandQueue(),
            let shaderUrl = Bundle.module.url(forResource: "Shaders", withExtension: "metal"),
            let source = try? String(contentsOf: shaderUrl, encoding: .utf8),
            let library = try? device.makeLibrary(source: source, options: nil),
            let vertexFunction = library.makeFunction(name: "globeVertex"),
            let fragmentFunction = library.makeFunction(name: "globeFragment")
        else { return nil }

        self.device = device
        self.queue = queue
        self.chunkBuffers = [MTLBuffer?](repeating: nil, count: chunkCount)

        // Direction xyz then height in metres, four floats a vertex.
        let vertexDescriptor = MTLVertexDescriptor()
        vertexDescriptor.attributes[0].format = .float3
        vertexDescriptor.attributes[0].offset = 0
        vertexDescriptor.attributes[0].bufferIndex = 0
        vertexDescriptor.attributes[1].format = .float
        vertexDescriptor.attributes[1].offset = 12
        vertexDescriptor.attributes[1].bufferIndex = 0
        vertexDescriptor.layouts[0].stride = 16

        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertexFunction
        descriptor.fragmentFunction = fragmentFunction
        descriptor.vertexDescriptor = vertexDescriptor
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        descriptor.depthAttachmentPixelFormat = .depth32Float
        descriptor.rasterSampleCount = 4

        guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor)
        else { return nil }
        self.pipeline = pipeline

        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less
        depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor)
        else { return nil }
        self.depthState = depthState

        let blankDescriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r8Unorm, width: 1, height: 1, mipmapped: false)
        guard let blank = device.makeTexture(descriptor: blankDescriptor) else { return nil }
        var zero: UInt8 = 0
        blank.replace(
            region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &zero, bytesPerRow: 1)
        self.blankTexture = blank
    }

    /// Hand over the triangle list every chunk is drawn through.
    func setMeshIndices(_ indices: [UInt16]) {
        indexBuffer = device.makeBuffer(
            bytes: indices, length: indices.count * MemoryLayout<UInt16>.stride)
        indexCount = indices.count
    }

    /// Fill one chunk's vertex buffer. Called once per chunk as the mesh is
    /// built, and again only if a finer tile lands under ground that had to
    /// settle for a coarse one; after that the buffer sits untouched.
    func setMeshChunk(_ id: Int, _ vertices: [Float]) {
        chunkBuffers[id] = device.makeBuffer(
            bytes: vertices, length: vertices.count * MemoryLayout<Float>.stride)
    }

    /// Upload a field, or hand back the texture already holding it.
    ///
    /// Not mipmapped, deliberately: longitude wraps within a single quad at
    /// the antimeridian, and the coarsest mip level draws a blurred line down
    /// the Pacific. Fields of weather are smooth enough to go without.
    private func textureFor(_ field: Field) -> MTLTexture? {
        let key = ObjectIdentifier(field)
        if let held = fields[key] {
            fieldClock += 1
            fields[key] = (held.texture, fieldClock)
            return held.texture
        }

        if fields.count >= fieldCacheLimit {
            if let oldest = fields.min(by: { $0.value.used < $1.value.used }) {
                fields.removeValue(forKey: oldest.key)
            }
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r8Unorm, width: field.width, height: field.height, mipmapped: false)
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        field.samples.withUnsafeBytes { bytes in
            texture.replace(
                region: MTLRegionMake2D(0, 0, field.width, field.height), mipmapLevel: 0,
                withBytes: bytes.baseAddress!, bytesPerRow: field.width)
        }
        fieldClock += 1
        fields[key] = (texture, fieldClock)
        return texture
    }

    /// Hand over the overlay, or nil to take it away. Uploads only what has
    /// not been seen before, so calling this every frame costs a lookup.
    func setOverlay(_ overlay: Overlay?) {
        guard let overlay else {
            overlayOpacity = 0
            return
        }
        overlayOpacity = Float(overlay.opacity)

        let box = overlay.field.bounds
        overlayBounds = SIMD4<Float>(
            Float((box.west + 180) / 360),
            Float(spanEast(box) / 360),
            Float((90 - box.north) / 180),
            Float((box.north - box.south) / 180))

        frameTexture = textureFor(overlay.field)
        // With nothing to cross to, both samplers read the same frame and the
        // mix is moot - which keeps the shader branchless.
        nextTexture = overlay.next.flatMap { textureFor($0) } ?? frameTexture
        overlayMix = overlay.next != nil ? Float(overlay.mix) : 0

        if overlay.palette != paletteSource {
            paletteSource = overlay.palette
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(
                pixelFormat: .rgba8Unorm, width: 256, height: 1, mipmapped: false)
            paletteTexture = device.makeTexture(descriptor: descriptor)
            overlay.palette.withUnsafeBytes { bytes in
                paletteTexture?.replace(
                    region: MTLRegionMake2D(0, 0, 256, 1), mipmapLevel: 0,
                    withBytes: bytes.baseAddress!, bytesPerRow: 256 * 4)
            }
        }
    }

    /// Draw the chunks named in `visible`, in one pass. The camera is uniform
    /// state, so the whole frame is a handful of uniform bytes and one indexed
    /// draw per chunk. Nothing is uploaded.
    func draw(
        in view: MTKView,
        camera: Camera,
        viewport: ViewportSize,
        exaggeration: Double,
        visible: [Int]
    ) {
        guard let descriptor = view.currentRenderPassDescriptor,
            let drawable = view.currentDrawable,
            let commandBuffer = queue.makeCommandBuffer(),
            let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
        else { return }

        encode(
            encoder, camera: camera, viewport: viewport, exaggeration: exaggeration,
            visible: visible)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func encode(
        _ encoder: MTLRenderCommandEncoder,
        camera: Camera,
        viewport: ViewportSize,
        exaggeration: Double,
        visible: [Int]
    ) {
        if visible.isEmpty || indexCount == 0 || indexBuffer == nil { return }

        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(depthState)
        // The surface is a radial height field, star-shaped about the centre:
        // anything turned away is covered by something in front of it, so half
        // the mesh is dropped before it is shaded.
        encoder.setCullMode(.back)
        // The mesh is wound counter-clockwise seen from outside, exactly as
        // the WebGL renderer has it - the vertex shader produces the same
        // clip-space output, so the winding convention carries over unchanged.
        encoder.setFrontFacing(.counterClockwise)

        // The camera rotation, matching the transform the CPU does per point:
        //   x1 = x cosLon - z sinLon
        //   z1 = x sinLon + z cosLon
        //   y' = y cosLat - z1 sinLat
        //   z' = y sinLat + z1 cosLat
        let cosLon = Float(camera.cosLon)
        let sinLon = Float(camera.sinLon)
        let cosLat = Float(camera.cosLat)
        let sinLat = Float(camera.sinLat)
        let rotation = simd_float3x3(columns: (
            SIMD3<Float>(cosLon, sinLon * -sinLat, sinLon * cosLat),
            SIMD3<Float>(0, cosLat, sinLat),
            SIMD3<Float>(-sinLon, cosLon * -sinLat, cosLon * cosLat)
        ))

        let width = Float(viewport.width * viewport.scale)
        let height = Float(viewport.height * viewport.scale)

        // Nothing to sample from means nothing to show, whatever the opacity.
        let overlay = (frameTexture != nil && paletteTexture != nil) ? overlayOpacity : 0

        var uniforms = SurfaceUniforms(
            rotation: rotation,
            bounds: overlayBounds,
            centre: SIMD2<Float>(
                Float(camera.cx * viewport.scale), Float(camera.cy * viewport.scale)),
            viewport: SIMD2<Float>(width, height),
            lift: Float(exaggeration / EARTH_RADIUS_M),
            radius: Float(camera.radius * viewport.scale),
            overlay: overlay,
            mix: overlayMix)

        encoder.setVertexBytes(&uniforms, length: MemoryLayout<SurfaceUniforms>.stride, index: 1)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<SurfaceUniforms>.stride, index: 0)

        encoder.setFragmentTexture(overlay > 0 ? frameTexture : blankTexture, index: 0)
        encoder.setFragmentTexture(overlay > 0 ? paletteTexture : blankTexture, index: 1)
        encoder.setFragmentTexture(overlay > 0 ? nextTexture : blankTexture, index: 2)

        for id in visible {
            guard let buffer = chunkBuffers[id] else { continue }
            encoder.setVertexBuffer(buffer, offset: 0, index: 0)
            encoder.drawIndexedPrimitives(
                type: .triangle, indexCount: indexCount, indexType: .uint16,
                indexBuffer: indexBuffer!, indexBufferOffset: 0)
        }
    }

    /// Render the surface into an offscreen texture and hand it back as a
    /// CGImage - the self-snapshot path, since a CAMetalLayer's contents are
    /// invisible to `cacheDisplay` and window capture needs permissions a
    /// command-line run does not have.
    func snapshot(
        camera: Camera, viewport: ViewportSize, exaggeration: Double, visible: [Int]
    ) -> CGImage? {
        let width = Int((viewport.width * viewport.scale).rounded())
        let height = Int((viewport.height * viewport.scale).rounded())
        if width <= 0 || height <= 0 { return nil }

        let colorDescriptor = MTLTextureDescriptor()
        colorDescriptor.textureType = .type2DMultisample
        colorDescriptor.pixelFormat = .bgra8Unorm
        colorDescriptor.width = width
        colorDescriptor.height = height
        colorDescriptor.sampleCount = 4
        colorDescriptor.usage = .renderTarget
        colorDescriptor.storageMode = .private

        let resolveDescriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        resolveDescriptor.usage = .renderTarget

        let depthDescriptor = MTLTextureDescriptor()
        depthDescriptor.textureType = .type2DMultisample
        depthDescriptor.pixelFormat = .depth32Float
        depthDescriptor.width = width
        depthDescriptor.height = height
        depthDescriptor.sampleCount = 4
        depthDescriptor.usage = .renderTarget
        depthDescriptor.storageMode = .private

        guard let color = device.makeTexture(descriptor: colorDescriptor),
            let resolve = device.makeTexture(descriptor: resolveDescriptor),
            let depth = device.makeTexture(descriptor: depthDescriptor),
            let commandBuffer = queue.makeCommandBuffer()
        else { return nil }

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = color
        pass.colorAttachments[0].resolveTexture = resolve
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .multisampleResolve
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.depthAttachment.texture = depth
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth = 1

        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass)
        else { return nil }
        encode(
            encoder, camera: camera, viewport: viewport, exaggeration: exaggeration,
            visible: visible)
        encoder.endEncoding()
        // The resolve texture is in managed storage: on a discrete GPU its
        // contents have to be synchronized back before the CPU can read them.
        if let blit = commandBuffer.makeBlitCommandEncoder() {
            blit.synchronize(resource: resolve)
            blit.endEncoding()
        }
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()

        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            resolve.getBytes(
                buffer.baseAddress!, bytesPerRow: width * 4,
                from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        }

        let bitmapInfo = CGBitmapInfo(
            rawValue: CGBitmapInfo.byteOrder32Little.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
            let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: space, bitmapInfo: bitmapInfo,
            provider: provider, decode: nil, shouldInterpolate: false,
            intent: .defaultIntent)
    }
}
