import Foundation
import CoreText
import CoreGraphics

// Reads a single JSON request envelope from stdin (default) or `--input <path>`,
// extracts per-glyph SVG outlines and/or font metadata using CoreText, and writes
// the JSON response to stdout. See docs/16-coretext-glyph-extraction.md.

// MARK: - Helpers

func die(_ message: String) -> Never {
    let err = ["error": message]
    if let data = try? JSONSerialization.data(withJSONObject: err, options: []),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data(str.utf8))
        FileHandle.standardError.write(Data("\n".utf8))
    } else {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
    exit(1)
}

func fourCharTag(_ s: String) -> UInt32 {
    let bytes = Array(s.utf8)
    guard bytes.count == 4 else { return 0 }
    return (UInt32(bytes[0]) << 24)
        | (UInt32(bytes[1]) << 16)
        | (UInt32(bytes[2]) << 8)
        | UInt32(bytes[3])
}

// Round to 3 decimal places, drop trailing zeros so dedup keys match across runs.
func formatNumber(_ value: CGFloat) -> String {
    if value == 0 { return "0" }
    let rounded = (value * 1000).rounded() / 1000
    if rounded == rounded.rounded() {
        return String(Int(rounded))
    }
    var s = String(format: "%.3f", rounded)
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
    return s
}

// MARK: - Font open

struct FontEntry {
    let ref: String
    let font: CTFont
    let pointSize: CGFloat
    let unitsPerEm: Int
}

func openFont(spec: [String: Any]) throws -> FontEntry {
    guard let ref = spec["ref"] as? String else {
        throw NSError(domain: "domotion", code: 1, userInfo: [NSLocalizedDescriptionKey: "font.ref missing"])
    }
    let postscriptName = spec["postscriptName"] as? String
    let fontPath = spec["fontPath"] as? String
    let size = (spec["size"] as? NSNumber)?.doubleValue ?? 16.0

    var baseFont: CTFont?
    var pickedNameMatch = false
    if let path = fontPath {
        let url = URL(fileURLWithPath: path) as CFURL
        // CTFontManagerCreateFontDescriptorsFromURL returns every face in the file
        // (e.g. all 32 subfonts for PingFang.ttc). Pick the one matching postscriptName,
        // or the first if no name was supplied.
        if let array = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor] {
            var picked: CTFontDescriptor? = nil
            if let want = postscriptName {
                for d in array {
                    if let name = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String,
                       name == want {
                        picked = d
                        pickedNameMatch = true
                        break
                    }
                }
            }
            if picked == nil { picked = array.first }
            if let d = picked {
                baseFont = CTFontCreateWithFontDescriptor(d, CGFloat(size), nil)
            }
        }
    }
    // DM-1015: when a postscriptName was requested AND the file lookup didn't
    // match it (we silently fell back to the file's first face), try a
    // system-wide CTFontCreateWithName resolution as a second chance. macOS
    // installs the same family in multiple places: /System/Library/Fonts is
    // a stripped-down stub (`/System/Library/Fonts/SFCompact.ttf` is 1.8 MB
    // with only `.SFCompact-Black`), while `/Library/Fonts/SF-Compact.ttf`
    // is the 19 MB Apple-developer-distributed full font that carries the
    // SignWriting / extended-script coverage. CoreText's by-name resolution
    // sees both and picks the richest match — falling back here recovers the
    // glyphs we'd otherwise miss when our recorded font path points at the
    // /System stub but the caller asked for a regular-weight face that only
    // exists in /Library.
    if !pickedNameMatch, let name = postscriptName {
        let byName = CTFontCreateWithName(name as CFString, CGFloat(size), nil)
        // Verify the by-name lookup found a face whose postscript name actually
        // matches what we asked for — CTFontCreateWithName falls back to the
        // system default if no match, and we don't want to silently swap a
        // generic font in for a missing face.
        let resolvedName = CTFontCopyPostScriptName(byName) as String
        if resolvedName == name {
            baseFont = byName
        }
    }
    if baseFont == nil, let name = postscriptName {
        baseFont = CTFontCreateWithName(name as CFString, CGFloat(size), nil)
    }
    guard var font = baseFont else {
        throw NSError(domain: "domotion", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not open font \(postscriptName ?? "<none>") at \(fontPath ?? "<no path>")"])
    }

    if let variations = spec["variations"] as? [String: Any], !variations.isEmpty {
        var axisDict: [CFNumber: CFNumber] = [:]
        for (axisName, value) in variations {
            let tag = fourCharTag(axisName)
            guard tag != 0, let dv = (value as? NSNumber)?.doubleValue else { continue }
            let key = NSNumber(value: tag) as CFNumber
            let val = NSNumber(value: dv) as CFNumber
            axisDict[key] = val
        }
        if !axisDict.isEmpty {
            let descriptor = CTFontCopyFontDescriptor(font)
            let varCFDict = axisDict as CFDictionary
            let attrs = [kCTFontVariationAttribute: varCFDict] as CFDictionary
            let newDescriptor = CTFontDescriptorCreateCopyWithAttributes(descriptor, attrs)
            font = CTFontCreateWithFontDescriptor(newDescriptor, CGFloat(size), nil)
        }
    }

    let upem = Int(CTFontGetUnitsPerEm(font))
    return FontEntry(ref: ref, font: font, pointSize: CGFloat(size), unitsPerEm: upem)
}

// MARK: - Path walking

// Path coords are emitted in CT's native y-up convention (positive y above
// baseline), matching what fontkit returns for fonts it can read. The Domotion
// renderer flips y to SVG y-down at draw time via `transform="scale(sc, -sc)"`,
// so emitting y-up here keeps the helper interchangeable with fontkit's
// `glyph.path.commands` output and avoids a double-flip.
func svgPath(forGlyph glyph: CGGlyph, in font: CTFont) -> String {
    guard let cgPath = CTFontCreatePathForGlyph(font, glyph, nil) else { return "" }
    var parts: [String] = []
    cgPath.applyWithBlock { ptr in
        let element = ptr.pointee
        let pts = element.points
        switch element.type {
        case .moveToPoint:
            let p = pts[0]
            parts.append("M \(formatNumber(p.x)) \(formatNumber(p.y))")
        case .addLineToPoint:
            let p = pts[0]
            parts.append("L \(formatNumber(p.x)) \(formatNumber(p.y))")
        case .addQuadCurveToPoint:
            let c = pts[0]
            let p = pts[1]
            parts.append("Q \(formatNumber(c.x)) \(formatNumber(c.y)) \(formatNumber(p.x)) \(formatNumber(p.y))")
        case .addCurveToPoint:
            let c1 = pts[0]
            let c2 = pts[1]
            let p = pts[2]
            parts.append("C \(formatNumber(c1.x)) \(formatNumber(c1.y)) \(formatNumber(c2.x)) \(formatNumber(c2.y)) \(formatNumber(p.x)) \(formatNumber(p.y))")
        case .closeSubpath:
            parts.append("Z")
        @unknown default:
            break
        }
    }
    return parts.joined(separator: " ")
}

// MARK: - Queries

func runGlyphsQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    guard let ref = query["fontRef"] as? String, let entry = fonts[ref] else {
        return ["type": "glyphs", "error": "fontRef missing or unknown", "glyphs": []]
    }
    let font = entry.font
    let inputs = query["glyphs"] as? [[String: Any]] ?? []

    // Resolve glyph ids (some inputs come as codepoints).
    var glyphs: [CGGlyph] = []
    glyphs.reserveCapacity(inputs.count)
    for entryDict in inputs {
        if let id = (entryDict["id"] as? NSNumber)?.intValue {
            glyphs.append(CGGlyph(id))
        } else if let cp = (entryDict["cp"] as? NSNumber)?.intValue {
            // Encode as UTF-16; surrogate-pair codepoints (>0xFFFF) take two UniChars.
            let scalar = Unicode.Scalar(cp) ?? Unicode.Scalar(0)!
            var utf16: [UniChar] = []
            for u in String(scalar).utf16 { utf16.append(u) }
            var resolved: [CGGlyph] = Array(repeating: 0, count: utf16.count)
            _ = CTFontGetGlyphsForCharacters(font, utf16, &resolved, utf16.count)
            // For BMP codepoints resolved.count == 1. For non-BMP, two glyph slots
            // are written but the leading surrogate's slot is the actual glyph; the
            // trailing one is 0. Pick the first non-zero.
            var picked: CGGlyph = 0
            for g in resolved where g != 0 { picked = g; break }
            glyphs.append(picked)
        } else {
            glyphs.append(0)
        }
    }

    // Advances.
    var advances: [CGSize] = Array(repeating: .zero, count: glyphs.count)
    if !glyphs.isEmpty {
        glyphs.withUnsafeBufferPointer { gbuf in
            advances.withUnsafeMutableBufferPointer { abuf in
                _ = CTFontGetAdvancesForGlyphs(font, .horizontal, gbuf.baseAddress!, abuf.baseAddress!, glyphs.count)
            }
        }
    }

    // Bounding rects.
    var bboxes: [CGRect] = Array(repeating: .zero, count: glyphs.count)
    if !glyphs.isEmpty {
        glyphs.withUnsafeBufferPointer { gbuf in
            bboxes.withUnsafeMutableBufferPointer { bbuf in
                _ = CTFontGetBoundingRectsForGlyphs(font, .horizontal, gbuf.baseAddress!, bbuf.baseAddress!, glyphs.count)
            }
        }
    }

    var out: [[String: Any]] = []
    for i in 0..<glyphs.count {
        let g = glyphs[i]
        let advance = advances[i].width
        let bbox = bboxes[i]
        let path = g == 0 ? "" : svgPath(forGlyph: g, in: font)
        // bbox stays in CT's y-up coords to match the path emission convention.
        // origin.y is the bottom of the glyph (often negative for descenders);
        // origin.y + height is the top.
        let bboxDict: [String: Any] = [
            "x": NSDecimalNumber(string: formatNumber(bbox.origin.x)),
            "y": NSDecimalNumber(string: formatNumber(bbox.origin.y)),
            "w": NSDecimalNumber(string: formatNumber(bbox.size.width)),
            "h": NSDecimalNumber(string: formatNumber(bbox.size.height))
        ]
        out.append([
            "id": Int(g),
            "advance": NSDecimalNumber(string: formatNumber(advance)),
            "bbox": bboxDict,
            "d": path
        ])
    }

    return ["type": "glyphs", "glyphs": out]
}

// Read Int16 (big-endian) from a Data slice at offset.
func readI16BE(_ data: Data, _ offset: Int) -> Int16? {
    guard offset + 2 <= data.count else { return nil }
    let hi = data[data.startIndex + offset]
    let lo = data[data.startIndex + offset + 1]
    let u = (UInt16(hi) << 8) | UInt16(lo)
    return Int16(bitPattern: u)
}

func runMetaQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    guard let ref = query["fontRef"] as? String, let entry = fonts[ref] else {
        return ["type": "meta", "error": "fontRef missing or unknown"]
    }
    let font = entry.font
    let upem = entry.unitsPerEm
    let pointSize = entry.pointSize

    // Ascent / descent: CT returns points at the requested size. Convert to design units.
    let scale = pointSize > 0 ? Double(upem) / Double(pointSize) : 0
    let ascentUnits = Int((Double(CTFontGetAscent(font)) * scale).rounded())
    let descentUnits = -Int((Double(CTFontGetDescent(font)) * scale).rounded())

    // Underline / strikeout: read from `post` and `OS/2` tables in design units.
    var underlinePos: Int? = nil
    var underlineThick: Int? = nil
    var strikeoutPos: Int? = nil
    var strikeoutThick: Int? = nil

    let postTag = CTFontTableTag(fourCharTag("post"))
    if let post = CTFontCopyTable(font, postTag, []) as Data? {
        // post format >= 1: header is fixed first 32 bytes.
        // version (4) + italicAngle (4) + underlinePosition (2) + underlineThickness (2)
        underlinePos = readI16BE(post, 8).map { Int($0) }
        underlineThick = readI16BE(post, 10).map { Int($0) }
    }
    let os2Tag = CTFontTableTag(fourCharTag("OS/2"))
    if let os2 = CTFontCopyTable(font, os2Tag, []) as Data? {
        // yStrikeoutSize at offset 26, yStrikeoutPosition at offset 28.
        strikeoutThick = readI16BE(os2, 26).map { Int($0) }
        strikeoutPos = readI16BE(os2, 28).map { Int($0) }
    }

    var result: [String: Any] = [
        "type": "meta",
        "unitsPerEm": upem,
        "ascent": ascentUnits,
        "descent": descentUnits
    ]
    if let v = underlinePos { result["underlinePosition"] = v }
    if let v = underlineThick { result["underlineThickness"] = v }
    if let v = strikeoutPos { result["strikeoutPosition"] = v }
    if let v = strikeoutThick { result["strikeoutThickness"] = v }
    return result
}

// MARK: - Main

func readRequest() -> Data {
    var inputPath: String? = nil
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        let a = args[i]
        switch a {
        case "--version":
            print("domotion-glyph-paths 0.1.0")
            exit(0)
        case "--help", "-h":
            print("Usage: domotion-glyph-paths [--input <path>]")
            print("Reads a JSON request envelope from stdin (default) or the given file.")
            print("Writes a JSON response to stdout.")
            exit(0)
        case "--input":
            i += 1
            if i >= args.count { die("--input requires a path") }
            inputPath = args[i]
        default:
            die("unknown argument: \(a)")
        }
        i += 1
    }

    if let path = inputPath {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            die("could not read --input file: \(path)")
        }
        return data
    }
    return FileHandle.standardInput.readDataToEndOfFile()
}

let requestData = readRequest()

guard let envelope = try? JSONSerialization.jsonObject(with: requestData, options: []) as? [String: Any] else {
    die("invalid JSON on input")
}

let fontSpecs = envelope["fonts"] as? [[String: Any]] ?? []
let queries = envelope["queries"] as? [[String: Any]] ?? []

var fonts: [String: FontEntry] = [:]
for spec in fontSpecs {
    do {
        let entry = try openFont(spec: spec)
        fonts[entry.ref] = entry
    } catch {
        die("font open failed: \(error.localizedDescription)")
    }
}

var results: [[String: Any]] = []
for query in queries {
    let type = (query["type"] as? String) ?? ""
    switch type {
    case "glyphs":
        results.append(runGlyphsQuery(query, fonts: fonts))
    case "meta":
        results.append(runMetaQuery(query, fonts: fonts))
    default:
        results.append(["type": type, "error": "unknown query type"])
    }
}

let response: [String: Any] = ["results": results]
do {
    let data = try JSONSerialization.data(withJSONObject: response, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    die("could not encode response: \(error.localizedDescription)")
}
