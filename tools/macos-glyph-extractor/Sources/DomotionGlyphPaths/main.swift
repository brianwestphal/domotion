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
        // DM-1018: extract glyph-0 (.notdef) outlines too. Blink draws the
        // primary font's `.notdef` for codepoints nothing covers, and that
        // glyph is often inked (SF Compact's `.notdef` is the SignWriting
        // stripes frame). Fallback fonts are only ever picked when they HAVE
        // the glyph (id != 0), so only the primary reaches glyph 0 here; the
        // renderer suppresses emoji / PUA `.notdef` at a higher level (DM-334),
        // so emitting the outline is safe and matches Chrome's placeholder.
        let path = svgPath(forGlyph: g, in: font)
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

// DM-1018: extract a font's `.notdef` glyph (glyph 0) outline. Blink draws the
// `first_candidate_` (primary) font's `.notdef` for codepoints nothing covers
// (FontFallbackIterator kFirstCandidateForNotdefGlyph), and that glyph is
// often NOT an empty box — e.g. SF Compact's `.notdef` is the stacked-stripes
// frame Chrome paints for uncovered Sutton SignWriting cells. The normal
// `glyphs` query suppresses glyph-0 paths (`g == 0 ? ""`); this query returns it.
func runNotdefQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    guard let ref = query["fontRef"] as? String, let entry = fonts[ref] else {
        return ["type": "notdef", "error": "fontRef missing or unknown"]
    }
    let font = entry.font
    var advance = CGSize.zero
    var gg: CGGlyph = 0
    _ = CTFontGetAdvancesForGlyphs(font, .horizontal, &gg, &advance, 1)
    let path = svgPath(forGlyph: 0, in: font)
    return ["type": "notdef", "id": 0,
            "advance": NSDecimalNumber(string: formatNumber(advance.width)),
            "d": path]
}

// DM-1028: shape a string with CoreText (CTLine) and return the shaped glyph
// stream — ids, per-glyph advance / offset, source-cluster index, and outline.
// The naive per-codepoint helper `layout()` did NO shaping: one glyph per
// codepoint, every offset 0. That drops the dotted circle CoreText/HarfBuzz
// insert for an orphaned Brahmic combining mark (U+25CC), drops conjuncts /
// reordering, and ignores GPOS mark positioning. fontkit's Universal-Shaping
// engine is broken for these scripts (it mis-stacks the Javanese suku and
// throws `'syllable'` nulls), so CoreText's USE shaping — which matches
// Chrome's painted cluster for these blocks — is the source of truth here.
//
// Coordinates are in font design units (the font is opened at size=unitsPerEm
// by the caller), y-up, matching `svgPath` and fontkit's convention. Per glyph
// we decompose CTRun's absolute pen positions into fontkit-style
// {xAdvance, xOffset, yOffset}: xOffset = position.x − (running advance sum),
// so a mark that GPOS pulls back over its base carries a negative xOffset and
// the renderer can lay the cluster out from a single anchor. `cluster` is the
// UTF-16 source index (CTRunGetStringIndices) so the renderer can anchor each
// cluster at the captured per-character xOffset. Outlines come from each run's
// OWN font (CTRunGetAttributes) so a CoreText sub-substitution still draws the
// correct glyph.
func runShapeQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    guard let ref = query["fontRef"] as? String, let entry = fonts[ref] else {
        return ["type": "shape", "error": "fontRef missing or unknown", "glyphs": []]
    }
    guard let text = query["text"] as? String else {
        return ["type": "shape", "error": "text missing", "glyphs": []]
    }
    let attrs: [CFString: Any] = [kCTFontAttributeName: entry.font]
    guard let astr = CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary) else {
        return ["type": "shape", "error": "could not build attributed string", "glyphs": []]
    }
    let line = CTLineCreateWithAttributedString(astr)
    let runs = (CTLineGetGlyphRuns(line) as? [CTRun]) ?? []
    var out: [[String: Any]] = []
    // Pen advances accumulate across the whole line (visual order) so each
    // glyph's xOffset is measured from its own pen origin.
    var penX: CGFloat = 0
    for run in runs {
        let n = CTRunGetGlyphCount(run)
        if n == 0 { continue }
        // The font CoreText actually used for this run (may differ from the
        // requested one if CT substituted for an uncovered codepoint).
        let runAttrs = CTRunGetAttributes(run) as? [CFString: Any]
        let runFontAny = runAttrs?[kCTFontAttributeName]
        let runFont: CTFont = {
            if let f = runFontAny, CFGetTypeID(f as CFTypeRef) == CTFontGetTypeID() {
                return (f as! CTFont)
            }
            return entry.font
        }()
        var glyphs = [CGGlyph](repeating: 0, count: n)
        var positions = [CGPoint](repeating: .zero, count: n)
        var advances = [CGSize](repeating: .zero, count: n)
        var indices = [CFIndex](repeating: 0, count: n)
        CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: n), &positions)
        CTRunGetAdvances(run, CFRange(location: 0, length: n), &advances)
        CTRunGetStringIndices(run, CFRange(location: 0, length: n), &indices)
        for i in 0..<n {
            let g = glyphs[i]
            let xOffset = positions[i].x - penX
            let yOffset = positions[i].y
            let path = svgPath(forGlyph: g, in: runFont)
            out.append([
                "id": Int(g),
                "cluster": indices[i],
                "ax": NSDecimalNumber(string: formatNumber(advances[i].width)),
                "ay": NSDecimalNumber(string: formatNumber(advances[i].height)),
                "dx": NSDecimalNumber(string: formatNumber(xOffset)),
                "dy": NSDecimalNumber(string: formatNumber(yOffset)),
                "d": path
            ])
            penX += advances[i].width
        }
    }
    return ["type": "shape", "glyphs": out]
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

// DM-1018: resolve a CSS font-family name to a real installed font, the way
// Blink's FontFallbackList picks `first_candidate_` — the first family in the
// stack that actually loads. CTFontCreateWithName substitutes a default when
// the name is unknown, so we VERIFY the resolved font's family / PostScript
// name actually matches the request (case-insensitive) before reporting it
// found; otherwise the caller keeps walking the stack. Returns the resolved
// PostScript name + on-disk file URL so the renderer can open it.
func runFamilyQuery(_ query: [String: Any]) -> [String: Any] {
    guard let name = query["name"] as? String, !name.isEmpty else {
        return ["type": "family", "found": false]
    }
    let font = CTFontCreateWithName(name as CFString, 16.0, nil)
    let psName = (CTFontCopyPostScriptName(font) as String?) ?? ""
    let familyName = (CTFontCopyFamilyName(font) as String?) ?? ""
    let displayName = (CTFontCopyName(font, kCTFontFullNameKey) as String?) ?? ""
    let want = name.lowercased()
    let matches = familyName.lowercased() == want
        || psName.lowercased() == want
        || psName.lowercased() == want.replacingOccurrences(of: " ", with: "")
        || displayName.lowercased() == want
    if !matches || psName.isEmpty {
        return ["type": "family", "found": false]
    }
    var pathStr = ""
    if let url = CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL {
        pathStr = url.path
    }
    return ["type": "family", "found": true,
            "postscriptName": psName, "familyName": familyName, "path": pathStr]
}

// MARK: - System fallback resolution (CTFontCreateForString)

// Mirror Chrome-on-macOS's per-character font fallback. Blink's
// `font_cache_mac.mm::PlatformFallbackFontForCharacter` → `GetSubstituteFont`
// calls `CTFontCreateForString(baseFont, string, range)` to walk CoreText's
// system cascade and find the font that actually renders a character the
// primary font lacks; if the result is LastResort it returns null (Chrome then
// paints its own last-resort). We expose the same call so the renderer can
// resolve fallback fonts authoritatively instead of consulting a sampled
// per-block table. For each requested codepoint we return the resolved font's
// PostScript name + on-disk file URL (so the existing path-based open works),
// or null when CoreText falls through to LastResort.
func runFallbackQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    // Base font drives the cascade list + trait matching. Use the caller's
    // primary font when provided (matches Chrome, which starts from the
    // element's resolved primary), else a neutral system font at 16pt.
    let baseFont: CTFont
    if let ref = query["fontRef"] as? String, let entry = fonts[ref] {
        baseFont = entry.font
    } else {
        baseFont = CTFontCreateWithName("Helvetica" as CFString, 16.0, nil)
    }
    let cps = (query["cps"] as? [NSNumber])?.map { $0.uint32Value } ?? []

    // LastResort detection: CTFontCreateForString returns the LastResort font
    // for codepoints nothing in the cascade covers. Compare PostScript names.
    let lastResortName = "LastResort"

    var out: [[String: Any]] = []
    for cp in cps {
        guard let scalar = Unicode.Scalar(cp) else {
            out.append(["cp": Int(cp), "found": false]); continue
        }
        let s = String(scalar) as NSString
        let range = CFRangeMake(0, s.length)
        let substitute = CTFontCreateForString(baseFont, s as CFString, range)
        let psName = (CTFontCopyPostScriptName(substitute) as String?) ?? ""
        let familyName = (CTFontCopyFamilyName(substitute) as String?) ?? ""
        if psName == lastResortName || psName.isEmpty {
            out.append(["cp": Int(cp), "found": false])
            continue
        }
        // Resolve the on-disk file URL so the renderer can open it by path
        // through the same fontkit / helper machinery it uses elsewhere.
        var pathStr = ""
        if let urlAttr = CTFontCopyAttribute(substitute, kCTFontURLAttribute) as? URL {
            pathStr = urlAttr.path
        }
        out.append([
            "cp": Int(cp),
            "found": true,
            "postscriptName": psName,
            "familyName": familyName,
            "path": pathStr
        ])
    }
    return ["type": "fallback", "fonts": out]
}

// MARK: - Main

// DM-1031: stable cache key for an opened font, so `--serve` mode reuses the
// CTFont across requests instead of re-opening (font open + CoreText init is
// ~16 ms, the dominant per-spawn cost).
func fontCacheKey(_ spec: [String: Any]) -> String {
    let ps = spec["postscriptName"] as? String ?? ""
    let fp = spec["fontPath"] as? String ?? ""
    let sz = (spec["size"] as? NSNumber)?.stringValue ?? "16"
    var varKey = ""
    if let v = spec["variations"] as? [String: Any] {
        varKey = v.keys.sorted().map { "\($0)=\((v[$0] as? NSNumber)?.stringValue ?? "")" }.joined(separator: ",")
    }
    return "\(ps)|\(fp)|\(sz)|\(varKey)"
}

// Process one request envelope into a response, opening (or reusing, via
// `fontCache`) the declared fonts and running each query.
func handleEnvelope(_ envelope: [String: Any], fontCache: inout [String: FontEntry]) -> [String: Any] {
    let fontSpecs = envelope["fonts"] as? [[String: Any]] ?? []
    let queries = envelope["queries"] as? [[String: Any]] ?? []

    var fonts: [String: FontEntry] = [:]
    for spec in fontSpecs {
        guard let ref = spec["ref"] as? String else { continue }
        let key = fontCacheKey(spec)
        if let cached = fontCache[key] {
            fonts[ref] = cached
        } else if let entry = try? openFont(spec: spec) {
            fontCache[key] = entry
            fonts[ref] = entry
        }
        // On open failure the ref is simply absent; queries referencing it
        // report "fontRef missing or unknown" rather than aborting the batch.
    }

    var results: [[String: Any]] = []
    for query in queries {
        let type = (query["type"] as? String) ?? ""
        switch type {
        case "glyphs": results.append(runGlyphsQuery(query, fonts: fonts))
        case "meta": results.append(runMetaQuery(query, fonts: fonts))
        case "fallback": results.append(runFallbackQuery(query, fonts: fonts))
        case "notdef": results.append(runNotdefQuery(query, fonts: fonts))
        case "shape": results.append(runShapeQuery(query, fonts: fonts))
        case "family": results.append(runFamilyQuery(query))
        default: results.append(["type": type, "error": "unknown query type"])
        }
    }
    return ["results": results]
}

func writeResponse(_ response: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: response, options: []) else {
        die("could not encode response")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// Parse args.
var inputPath: String? = nil
var serve = false
let cliArgs = CommandLine.arguments
var ai = 1
while ai < cliArgs.count {
    switch cliArgs[ai] {
    case "--version":
        print("domotion-glyph-paths 0.1.0")
        exit(0)
    case "--help", "-h":
        print("Usage: domotion-glyph-paths [--input <path>] [--serve]")
        print("Reads a JSON request envelope from stdin (default) or --input <path>; writes a JSON response.")
        print("--serve: persistent mode — read one request envelope per line on stdin, write one response per")
        print("         line on stdout, looping until EOF, reusing opened fonts across requests (DM-1031).")
        exit(0)
    case "--serve":
        serve = true
    case "--input":
        ai += 1
        if ai >= cliArgs.count { die("--input requires a path") }
        inputPath = cliArgs[ai]
    default:
        die("unknown argument: \(cliArgs[ai])")
    }
    ai += 1
}

if serve {
    // DM-1031: persistent server. One request envelope per line in, one
    // response per line out. Fonts opened once are reused for the lifetime of
    // the process via `fontCache`. A malformed line yields an error response
    // but does not stop the loop; EOF (the parent closing stdin) ends it.
    var fontCache: [String: FontEntry] = [:]
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            writeResponse(["results": [], "error": "invalid JSON on input line"])
            continue
        }
        writeResponse(handleEnvelope(envelope, fontCache: &fontCache))
    }
    exit(0)
}

// One-shot mode (the fallback path / the original CLI contract).
let requestData: Data
if let path = inputPath {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        die("could not read --input file: \(path)")
    }
    requestData = data
} else {
    requestData = FileHandle.standardInput.readDataToEndOfFile()
}
guard let envelope = try? JSONSerialization.jsonObject(with: requestData, options: []) as? [String: Any] else {
    die("invalid JSON on input")
}
var oneShotFontCache: [String: FontEntry] = [:]
writeResponse(handleEnvelope(envelope, fontCache: &oneShotFontCache))
