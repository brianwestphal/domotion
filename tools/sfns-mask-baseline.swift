import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// This helper is intentionally narrow: it opens the physical SFNS.ttf bytes,
// applies a complete variation dictionary, draws caller-supplied gids at
// caller-supplied quarter-pixel origins, and exposes the sibling CoreText path.
// It mirrors Chromium-pinned Skia 62efacd3 at the handoff being discriminated:
//
// - SkTypeface_mac_ct.cpp:1075-1174 builds a complete, clamped CoreText
//   variation dictionary; :1213-1217 applies it with CTFontCreateCopyWithAttributes.
// - SkScalerContext_mac_ct.cpp:229-238 leaves quantization to Skia but enables
//   CoreGraphics subpixel positioning; :290 calls CTFontDrawGlyphs.
// - The independent vector arm is the same API used by generatePath at :664,
//   CTFontCreatePathForGlyph.

struct PointInput: Codable {
    let x: Double
    let baselineY: Double
}

struct SampleInput: Codable {
    let id: String
    let text: String
    let pointSize: Double
    let width: Int
    let height: Int
    let axes: [String: Double]
    let glyphIds: [UInt16]
    let positions: [PointInput]
}

struct EnvelopeInput: Codable {
    let fontPath: String
    let repeatCount: Int
    let samples: [SampleInput]
}

struct RectOutput: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.size.width
        height = rect.size.height
    }
}

struct GlyphPathOutput: Codable {
    let gid: UInt16
    let svgPath: String
    let commandCount: Int
    let bounds: RectOutput
    let advance: Double
}

struct MetricsOutput: Codable {
    let pointSize: Double
    let unitsPerEm: UInt32
    let ascent: Double
    let descent: Double
    let leading: Double
    let capHeight: Double
    let xHeight: Double
    let boundingBox: RectOutput
}

struct SampleOutput: Codable {
    let id: String
    let maskPath: String
    let postscriptName: String
    let actualAxes: [String: Double]
    let mappedGlyphIds: [UInt16]
    let suppliedGlyphIds: [UInt16]
    let positions: [PointInput]
    let glyphPaths: [GlyphPathOutput]
    let metrics: MetricsOutput
}

struct IterationOutput: Codable {
    let iteration: Int
    let samples: [SampleOutput]
}

struct EnvelopeOutput: Codable {
    let iterations: [IterationOutput]
}

enum OracleError: Error, CustomStringConvertible {
    case usage
    case font(String)
    case input(String)
    case bitmap(String)
    case output(String)

    var description: String {
        switch self {
        case .usage: return "usage: sfns-mask-baseline <input.json> <output-directory>"
        case .font(let message), .input(let message), .bitmap(let message), .output(let message):
            return message
        }
    }
}

func fourCharTag(_ value: String) -> UInt32 {
    let bytes = Array(value.utf8)
    guard bytes.count == 4 else { return 0 }
    return (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16)
        | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
}

func tagString(_ value: UInt32) -> String {
    let bytes: [UInt8] = [
        UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
        UInt8((value >> 8) & 0xff), UInt8(value & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? String(value)
}

func number(_ value: CGFloat) -> String {
    if value == 0 { return "0" }
    var result = String(format: "%.6f", Double(value))
    while result.hasSuffix("0") { result.removeLast() }
    if result.hasSuffix(".") { result.removeLast() }
    return result
}

func svgPath(_ path: CGPath) -> (String, Int) {
    var parts: [String] = []
    var count = 0
    path.applyWithBlock { ptr in
        let element = ptr.pointee
        let points = element.points
        count += 1
        switch element.type {
        case .moveToPoint:
            parts.append("M\(number(points[0].x)) \(number(points[0].y))")
        case .addLineToPoint:
            parts.append("L\(number(points[0].x)) \(number(points[0].y))")
        case .addQuadCurveToPoint:
            parts.append("Q\(number(points[0].x)) \(number(points[0].y)) \(number(points[1].x)) \(number(points[1].y))")
        case .addCurveToPoint:
            parts.append("C\(number(points[0].x)) \(number(points[0].y)) \(number(points[1].x)) \(number(points[1].y)) \(number(points[2].x)) \(number(points[2].y))")
        case .closeSubpath:
            parts.append("Z")
        @unknown default:
            count -= 1
        }
    }
    return (parts.joined(separator: " "), count)
}

func openFont(path: String, pointSize: CGFloat, axes requested: [String: Double]) throws -> CTFont {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let provider = CGDataProvider(url: url), let graphics = CGFont(provider) else {
        throw OracleError.font("could not open physical font bytes at \(path)")
    }
    let base = CTFontCreateWithGraphicsFont(graphics, pointSize, nil, nil)
    var variations: [CFNumber: CFNumber] = [:]
    for (tag, value) in requested {
        let identifier = fourCharTag(tag)
        guard identifier != 0 else { throw OracleError.input("invalid axis tag \(tag)") }
        variations[NSNumber(value: identifier) as CFNumber] = NSNumber(value: value) as CFNumber
    }
    let attributes = [kCTFontVariationAttribute: variations as CFDictionary] as CFDictionary
    let descriptor = CTFontDescriptorCreateWithAttributes(attributes)
    return CTFontCreateCopyWithAttributes(base, pointSize, nil, descriptor)
}

func fullAxisState(_ font: CTFont) -> [String: Double] {
    var values: [String: Double] = [:]
    if let axes = CTFontCopyVariationAxes(font) as? [[String: Any]] {
        for axis in axes {
            guard let identifier = (axis[kCTFontVariationAxisIdentifierKey as String] as? NSNumber)?.uint32Value,
                  let defaultValue = (axis[kCTFontVariationAxisDefaultValueKey as String] as? NSNumber)?.doubleValue
            else { continue }
            values[tagString(identifier)] = defaultValue
        }
    }
    if let current = CTFontCopyVariation(font) as? [NSNumber: NSNumber] {
        for (identifier, value) in current {
            values[tagString(identifier.uint32Value)] = value.doubleValue
        }
    }
    return values
}

func mappedGlyphs(_ text: String, font: CTFont) -> [UInt16] {
    let units = Array(text.utf16)
    var characters = units
    var glyphs = Array(repeating: CGGlyph(0), count: units.count)
    _ = CTFontGetGlyphsForCharacters(font, &characters, &glyphs, glyphs.count)
    return glyphs.map { UInt16($0) }
}

func glyphPathOutputs(_ glyphIds: [UInt16], font: CTFont) -> [GlyphPathOutput] {
    glyphIds.map { value in
        var glyph = CGGlyph(value)
        var advance = CGSize.zero
        _ = CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
        let bounds = CTFontGetBoundingRectsForGlyphs(font, .horizontal, &glyph, nil, 1)
        // `SkScalerContext_Mac::generatePath` does not ask CoreText for the
        // ordinary point-size path when subpixel positioning is active. At an
        // axis-aligned horizontal baseline it requests the path at 4x in X,
        // preserving Y hinting, then scales X back (`kScaleForSubPixelPositionHinting`,
        // Skia 62efacd3, SkScalerContext_mac_ct.cpp:621-675). Mirror that exact
        // discriminator instead of treating a plain CoreText path as Skia's.
        var hintingScale = CGAffineTransform(scaleX: 4, y: 1)
        guard let hintedPath = CTFontCreatePathForGlyph(font, glyph, &hintingScale) else {
            return GlyphPathOutput(gid: value, svgPath: "", commandCount: 0,
                                   bounds: RectOutput(bounds), advance: advance.width)
        }
        var inverseScale = CGAffineTransform(scaleX: 0.25, y: 1)
        guard let path = hintedPath.copy(using: &inverseScale) else {
            return GlyphPathOutput(gid: value, svgPath: "", commandCount: 0,
                                   bounds: RectOutput(bounds), advance: advance.width)
        }
        let serialized = svgPath(path)
        return GlyphPathOutput(gid: value, svgPath: serialized.0,
                               commandCount: serialized.1,
                               bounds: RectOutput(bounds), advance: advance.width)
    }
}

func writeMask(font: CTFont, glyphIds: [UInt16], positions: [PointInput],
               width: Int, height: Int, output: URL) throws {
    guard glyphIds.count == positions.count else {
        throw OracleError.input("glyph/position length mismatch")
    }
    let space = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(data: nil, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw OracleError.bitmap("could not create CoreGraphics bitmap") }

    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setAllowsFontSubpixelQuantization(false)
    context.setShouldSubpixelQuantizeFonts(false)
    context.setAllowsFontSubpixelPositioning(true)
    context.setShouldSubpixelPositionFonts(true)
    context.setShouldAntialias(true)
    context.setShouldSmoothFonts(true)
    context.setTextDrawingMode(.fill)
    context.textMatrix = .identity
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))

    let glyphs = glyphIds.map { CGGlyph($0) }
    let nativePositions = positions.map { CGPoint(x: $0.x, y: Double(height) - $0.baselineY) }
    glyphs.withUnsafeBufferPointer { glyphBuffer in
        nativePositions.withUnsafeBufferPointer { positionBuffer in
            if let glyphBase = glyphBuffer.baseAddress, let positionBase = positionBuffer.baseAddress {
                CTFontDrawGlyphs(font, glyphBase, positionBase, glyphs.count, context)
            }
        }
    }
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
            output as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw OracleError.output("could not create PNG destination \(output.path)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw OracleError.output("could not finalize PNG \(output.path)")
    }
}

func metrics(_ font: CTFont) -> MetricsOutput {
    MetricsOutput(
        pointSize: CTFontGetSize(font),
        unitsPerEm: CTFontGetUnitsPerEm(font),
        ascent: CTFontGetAscent(font),
        descent: CTFontGetDescent(font),
        leading: CTFontGetLeading(font),
        capHeight: CTFontGetCapHeight(font),
        xHeight: CTFontGetXHeight(font),
        boundingBox: RectOutput(CTFontGetBoundingBox(font))
    )
}

func safeName(_ value: String) -> String {
    value.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" }.reduce("") { $0 + String($1) }
}

do {
    guard CommandLine.arguments.count == 3 else { throw OracleError.usage }
    let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    let input = try JSONDecoder().decode(EnvelopeInput.self, from: Data(contentsOf: inputURL))
    guard input.repeatCount > 0 else { throw OracleError.input("repeatCount must be positive") }

    var iterations: [IterationOutput] = []
    for iteration in 0..<input.repeatCount {
        var rows: [SampleOutput] = []
        for sample in input.samples {
            let font = try openFont(path: input.fontPath, pointSize: sample.pointSize, axes: sample.axes)
            let maskURL = outputDirectory.appendingPathComponent("\(safeName(sample.id))-\(iteration)-ct-mask.png")
            try writeMask(font: font, glyphIds: sample.glyphIds, positions: sample.positions,
                          width: sample.width, height: sample.height, output: maskURL)
            rows.append(SampleOutput(
                id: sample.id,
                maskPath: maskURL.path,
                postscriptName: CTFontCopyPostScriptName(font) as String,
                actualAxes: fullAxisState(font),
                mappedGlyphIds: mappedGlyphs(sample.text, font: font),
                suppliedGlyphIds: sample.glyphIds,
                positions: sample.positions,
                glyphPaths: glyphPathOutputs(sample.glyphIds, font: font),
                metrics: metrics(font)
            ))
        }
        iterations.append(IterationOutput(iteration: iteration, samples: rows))
    }
    let data = try JSONEncoder().encode(EnvelopeOutput(iterations: iterations))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
} catch {
    FileHandle.standardError.write(Data("SFNS mask helper: \(error)\n".utf8))
    exit(1)
}
