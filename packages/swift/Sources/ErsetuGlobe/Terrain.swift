//
//  Streaming terrain, ported from src/globe/tiles.ts.
//
//  The web client fetches the pyramid over HTTP with range requests; here the
//  three shipped levels are files in the bundle, so a "fetch" is a read and the
//  coalescing machinery is unnecessary. What is kept is the ladder: level 0 is
//  decoded before the globe has a shape at all, and each finer level is only
//  opened once the mesh has finished with the one below it, so the globe
//  sharpens rung by rung exactly as the web version does.
//
//  Tiles are 128 interior samples plus a one-sample border, stored as int16
//  metres, delta-predicted and deflate-compressed each on its own.
//

import Compression
import Foundation

private let MAGIC = "ERSETILE"
private let VERSION = 2
private let HEADER_BYTES = 32
private let INDEX_ENTRY_BYTES = 16

let EARTH_RADIUS_M = 6_371_000.0

/// Levels to hold in full - the ones that ship in the bundle.
let RESIDENT_LEVELS = 2

private struct Header {
    var tileSize: Int
    var border: Int
    var levels: Int
    var level: Int
    var indexBytes: Int
    var dataOffset: Int
    var tileCount: Int
    var peak: Int
}

private struct LevelFile {
    var dataOffset: Int
    var offsets: [Int]
    var lengths: [Int]
    var whole: Data
}

private enum LevelStatus {
    case absent, opening, ready, missing
}

/// All mutable state lives on the main thread; decoding happens on a
/// background queue and publishes its tiles back to the main thread.
final class Terrain {
    static let shared = Terrain()

    private(set) var levels = 0
    private(set) var tileSize = 0
    private(set) var border = 0
    private(set) var stored = 0
    /// Whether enough has arrived for the globe to have a shape.
    private(set) var ready = false
    /// Largest lift anywhere, in globe radii, from the finest level's peak.
    private(set) var maxLift = 0.0
    /// Tiles decoded and held - the mesh builder's "resident" stamp.
    private(set) var resident = 0

    private var status: [LevelStatus] = []
    private var levelBase: [Int] = []
    private var tiles: [Int: [Int16]] = [:]

    /// Which level actually answered the last `height` call.
    private(set) var sampledLevel = 0

    private func tilesAcross(_ z: Int) -> Int { 4 << z }
    private func tilesDown(_ z: Int) -> Int { 2 << z }

    private func tileId(_ z: Int, _ x: Int, _ y: Int) -> Int {
        levelBase[z] + y * tilesAcross(z) + x
    }

    /// Read level 0 whole and decode its eight tiles - the point at which the
    /// globe can be drawn at all.
    func open() throws {
        guard let url = Bundle.module.url(forResource: "terrain-0", withExtension: "bin") else {
            throw TerrainError.missing("terrain-0.bin")
        }
        let body = try Data(contentsOf: url)
        let head = try readHeader(body)
        if head.level != 0 { throw TerrainError.malformed("expected level 0") }

        levels = head.levels
        tileSize = head.tileSize
        border = head.border
        stored = head.tileSize + 2 * head.border
        // Taken from the finest level at build time, so even level 0 knows how
        // far terrain can stand off the sphere.
        maxLift = Double(head.peak) / EARTH_RADIUS_M

        levelBase = [Int](repeating: 0, count: head.levels + 1)
        var at = 0
        for z in 0..<head.levels {
            levelBase[z] = at
            at += tilesAcross(z) * tilesDown(z)
        }
        levelBase[head.levels] = at

        status = [LevelStatus](repeating: .absent, count: head.levels)

        let file = readIndex(body, head)
        for i in 0..<head.tileCount {
            let from = file.dataOffset + file.offsets[i]
            let packed = body.subdata(in: from..<(from + file.lengths[i]))
            tiles[i] = decode(packed, stored: stored)
        }
        status[0] = .ready
        resident = tiles.count
        ready = true
    }

    /// Ask for everything up to `throughLevel`, one rung at a time. The caller
    /// earns each level by finishing the one below it, so the globe arrives as
    /// a ladder rather than a jump from bare sphere to full relief.
    func prefetchResident(through throughLevel: Int) {
        guard ready, levels > 0 else { return }
        var earned = throughLevel
        var z = 1
        while z <= min(RESIDENT_LEVELS, levels - 1) {
            if status[z] == .missing {
                earned += 1
                z += 1
                continue
            }
            if z > earned { break }
            if status[z] == .absent { openLevel(z) }
            z += 1
        }
    }

    /// Decode a whole level off the main thread and publish it in one go.
    private func openLevel(_ z: Int) {
        status[z] = .opening
        let stored = self.stored

        DispatchQueue.global(qos: .userInitiated).async {
            guard let url = Bundle.module.url(forResource: "terrain-\(z)", withExtension: "bin"),
                let body = try? Data(contentsOf: url),
                let head = try? readHeader(body), head.level == z
            else {
                DispatchQueue.main.async { self.status[z] = .missing }
                return
            }

            let file = readIndex(body, head)
            var decoded: [Int: [Int16]] = [:]
            for i in 0..<head.tileCount {
                let from = file.dataOffset + file.offsets[i]
                let packed = body.subdata(in: from..<(from + file.lengths[i]))
                decoded[i] = decode(packed, stored: stored)
            }

            DispatchQueue.main.async {
                let base = self.levelBase[z]
                for (local, samples) in decoded { self.tiles[base + local] = samples }
                self.status[z] = .ready
                self.resident = self.tiles.count
            }
        }
    }

    // MARK: - Sampling

    private func tileIndexX(_ z: Int, _ u: Double) -> Int {
        let across = tilesAcross(z)
        // Longitude wraps, and the seam fix upstream can carry u past 1.
        var x = Int(((u - u.rounded(.down)) * Double(across)).rounded(.down))
        if x < 0 { x = 0 } else if x >= across { x = across - 1 }
        return x
    }

    private func tileIndexY(_ z: Int, _ v: Double) -> Int {
        let down = tilesDown(z)
        var y = Int((v * Double(down)).rounded(.down))
        if y < 0 { y = 0 } else if y >= down { y = down - 1 }
        return y
    }

    private func levelWidth(_ z: Int) -> Int { 512 << z }

    /// Height in metres at a normalised position - longitude fraction from the
    /// antimeridian, latitude fraction from the north pole - from the finest
    /// level available at or above `level`. `sampledLevel` says which answered.
    func height(u: Double, v: Double, level: Int) -> Double {
        guard levels > 0 else { return 0 }

        var z = min(level, levels - 1)
        while z >= 0 {
            let x = tileIndexX(z, u)
            let y = tileIndexY(z, v)
            guard let tile = tiles[tileId(z, x, y)] else {
                z -= 1
                continue
            }
            sampledLevel = z

            // Position within the tile's stored block, border included.
            // Samples sit at cell centres, and the border is what lets the
            // four taps never need a neighbouring tile.
            let width = Double(levelWidth(z))
            let height = width / 2
            let wrapped = u - u.rounded(.down)
            let fx = wrapped * width - 0.5 - Double(x * tileSize) + Double(border)
            let fy = v * height - 0.5 - Double(y * tileSize) + Double(border)

            let x0 = Int(fx.rounded(.down))
            let y0 = Int(fy.rounded(.down))
            let tx = fx - Double(x0)
            let ty = fy - Double(y0)
            let rowA = y0 * stored
            let rowB = rowA + stored
            let h00 = Double(tile[rowA + x0])
            let h10 = Double(tile[rowA + x0 + 1])
            let h01 = Double(tile[rowB + x0])
            let h11 = Double(tile[rowB + x0 + 1])
            let top = h00 + (h10 - h00) * tx
            let bottom = h01 + (h11 - h01) * tx
            return top + (bottom - top) * ty
        }
        sampledLevel = -1
        return 0
    }
}

enum TerrainError: Error {
    case missing(String)
    case malformed(String)
}

private func readHeader(_ bytes: Data) throws -> Header {
    guard bytes.count >= HEADER_BYTES else { throw TerrainError.malformed("short header") }
    let magic = String(bytes: bytes.prefix(8), encoding: .ascii)
    guard magic == MAGIC else { throw TerrainError.malformed("wrong magic") }
    let version = Int(readUint16(bytes, 8))
    guard version == VERSION else { throw TerrainError.malformed("version \(version)") }
    return Header(
        tileSize: Int(readUint16(bytes, 10)),
        border: Int(bytes[bytes.startIndex + 12]),
        levels: Int(bytes[bytes.startIndex + 13]),
        level: Int(bytes[bytes.startIndex + 14]),
        indexBytes: Int(readUint32(bytes, 16)),
        dataOffset: Int(readUint32(bytes, 20)),
        tileCount: Int(readUint32(bytes, 24)),
        peak: Int(Int16(bitPattern: readUint16(bytes, 28)))
    )
}

private func readIndex(_ body: Data, _ head: Header) -> LevelFile {
    var offsets = [Int](repeating: 0, count: head.tileCount)
    var lengths = [Int](repeating: 0, count: head.tileCount)
    for i in 0..<head.tileCount {
        let at = HEADER_BYTES + i * INDEX_ENTRY_BYTES
        offsets[i] = Int(readUint32(body, at))
        lengths[i] = Int(readUint32(body, at + 4))
    }
    return LevelFile(dataOffset: head.dataOffset, offsets: offsets, lengths: lengths, whole: body)
}

private func readUint16(_ data: Data, _ offset: Int) -> UInt16 {
    let i = data.startIndex + offset
    return UInt16(data[i]) | (UInt16(data[i + 1]) << 8)
}

private func readUint32(_ data: Data, _ offset: Int) -> UInt32 {
    let i = data.startIndex + offset
    return UInt32(data[i]) | (UInt32(data[i + 1]) << 8) | (UInt32(data[i + 2]) << 16)
        | (UInt32(data[i + 3]) << 24)
}

/// Inflate a tile and undo the predictor.
///
/// The payload is zlib-wrapped deflate (node's `deflateSync`); Apple's
/// Compression framework wants the raw stream, so the two-byte zlib header is
/// skipped and the Adler-32 trailer left unread.
private func decode(_ packed: Data, stored: Int) -> [Int16] {
    let sampleCount = stored * stored
    let rawSize = sampleCount * 2
    var samples = [Int16](repeating: 0, count: sampleCount)

    let raw = packed.dropFirst(2)
    raw.withUnsafeBytes { (source: UnsafeRawBufferPointer) in
        samples.withUnsafeMutableBytes { (destination: UnsafeMutableRawBufferPointer) in
            _ = compression_decode_buffer(
                destination.baseAddress!.assumingMemoryBound(to: UInt8.self), rawSize,
                source.baseAddress!.assumingMemoryBound(to: UInt8.self), source.count,
                nil, COMPRESSION_ZLIB
            )
        }
    }

    // Each sample was stored as the difference from the one to its left, and
    // the first of each row as the difference from the row above. Int16 wraps
    // on overflow, the same modular arithmetic the encoder relied on.
    for y in 0..<stored {
        let row = y * stored
        if y > 0 { samples[row] = samples[row] &+ samples[row - stored] }
        for x in 1..<stored {
            samples[row + x] = samples[row + x] &+ samples[row + x - 1]
        }
    }
    return samples
}
