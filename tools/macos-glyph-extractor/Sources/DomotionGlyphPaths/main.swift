import Foundation
import CoreText
import CoreGraphics
// DM-1920: `NSFontManager.availableMembersOfFontFamily` is the candidate list
// Blink enumerates for a declared family. AppKit only; there is no CoreText
// equivalent that returns the same set (the descriptor enumeration is
// named-instance-expanded, which is a different and larger list).
import AppKit

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

// MARK: - system-ui matching (Blink MatchSystemUIFont)

// blink/renderer/platform/fonts/font_selection_types.h — kNormalWeightValue 400,
// kNormalWidthValue 100, kBoldThreshold 600, kNormalSlopeValue 0.
let kNormalWeightValue = 400.0
let kNormalWidthValue = 100.0
let kBoldThreshold = 600.0
let kNormalSlopeValue = 0.0

/// Clamp `weight` / `width` to the ranges the font's own variation axes accept.
///
/// Transcribed from `ClampVariationValuesToFontAcceptableRange`
/// (font_matcher_mac.mm:483-538). Note Blink only clamps an axis when the value
/// differs from that axis's normal — a normal value is left alone even if the
/// font's range excludes it.
func clampVariationValuesToFontAcceptableRange(_ font: CTFont,
                                               _ weight: inout Double,
                                               _ width: inout Double) {
    guard let axes = CTFontCopyVariationAxes(font) as? [[String: Any]] else { return }
    let weightTag = fourCharTag("wght")
    let widthTag = fourCharTag("wdth")
    for axis in axes {
        guard let axisId = (axis[kCTFontVariationAxisIdentifierKey as String] as? NSNumber)?.uint32Value,
              let axisMin = (axis[kCTFontVariationAxisMinimumValueKey as String] as? NSNumber)?.doubleValue,
              let axisMax = (axis[kCTFontVariationAxisMaximumValueKey as String] as? NSNumber)?.doubleValue
        else { continue }
        if axisId == weightTag && weight != kNormalWeightValue {
            weight = min(max(weight, axisMin), axisMax)
        }
        if axisId == widthTag && width != kNormalWidthValue {
            width = min(max(width, axisMin), axisMax)
        }
    }
}

/// The CSS description a `systemUI` spec resolves to.
///
/// One function, used by BOTH `openFont` (to build the face) and `fontCacheKey`
/// (to key it). That sharing is the point rather than a convenience: the cache
/// key must be a function of exactly the inputs the face is derived from, and
/// the previous bug in this file was the two drifting apart — the key omitted
/// the `system-ui` CSS values entirely, so one cached base answered for every
/// weight at a given size and the winner was whichever spec asked first.
///
/// `slant` in particular has TWO sources: an explicit `cssSlant`, or the older
/// boolean `italic`. Keying on the raw fields would have to know that; keying
/// on the resolved value cannot get it wrong.
struct SystemUICSS: Equatable {
    let weight: Double
    let slant: Double
    let width: Double
}

func systemUICSS(from spec: [String: Any]) -> SystemUICSS {
    // CSS values, not booleans: Blink derives the traits from the numbers, so
    // the thresholds have to live on this side to match it.
    SystemUICSS(
        weight: (spec["cssWeight"] as? NSNumber)?.doubleValue ?? kNormalWeightValue,
        slant: (spec["cssSlant"] as? NSNumber)?.doubleValue
            ?? (((spec["italic"] as? NSNumber)?.boolValue == true) ? 1.0 : kNormalSlopeValue),
        width: (spec["cssWidth"] as? NSNumber)?.doubleValue ?? kNormalWidthValue,
    )
}

/// The `system-ui` primary, as Blink builds it.
///
/// Transcribed from `MatchSystemUIFont` (font_matcher_mac.mm:540-588). The
/// `size` is load-bearing twice over: CoreText picks the Text vs Display optical
/// cut from it (measured switch at exactly 20px), and it is carried into both
/// copy calls.
func matchSystemUIFont(weight: Double, slant: Double, width: Double, size: CGFloat) -> CTFont? {
    guard var ctFont = CTFontCreateUIFontForLanguage(.system, size, nil) else { return nil }

    var desiredTraits: CTFontSymbolicTraits = []
    if slant != kNormalSlopeValue { desiredTraits.insert(.traitItalic) }
    if weight >= kBoldThreshold { desiredTraits.insert(.traitBold) }

    if !desiredTraits.isEmpty {
        // Blink does `ct_font.reset(...)` unconditionally, so a copy CoreText
        // declines makes the whole match null rather than falling back to the
        // untraited font. Mirror that.
        guard let copy = CTFontCreateCopyWithSymbolicTraits(
            ctFont, size, nil, desiredTraits, desiredTraits) else { return nil }
        ctFont = copy
    }

    if weight == kNormalWeightValue && width == kNormalWidthValue {
        return ctFont
    }

    var w = weight
    var wd = width
    clampVariationValuesToFontAcceptableRange(ctFont, &w, &wd)

    var variations: [CFNumber: CFNumber] = [:]
    if w != kNormalWeightValue {
        variations[NSNumber(value: fourCharTag("wght")) as CFNumber] = NSNumber(value: w) as CFNumber
    }
    if wd != kNormalWidthValue {
        variations[NSNumber(value: fourCharTag("wdth")) as CFNumber] = NSNumber(value: wd) as CFNumber
    }

    let attributes = [kCTFontVariationAttribute: variations as CFDictionary] as CFDictionary
    let varFontDesc = CTFontDescriptorCreateWithAttributes(attributes)
    return CTFontCreateCopyWithAttributes(ctFont, size, nil, varFontDesc)
}

// MARK: - Font open

/// How `openFont` arrived at the CTFont it returns.
///
/// Reported verbatim on the `meta` query so a caller can tell "we loaded exactly
/// the face you named" apart from "we loaded something and hoped". Before this
/// existed, both looked identical from the outside, and a reported face index of
/// 0 was twice mistaken for evidence of which member had been opened.
enum FontResolution: String {
    /// `systemUI: true` — resolved through CTFontCreateUIFontForLanguage.
    case systemUI
    /// A descriptor in the requested file carried exactly the requested PostScript name.
    case nameMatchedInFile
    /// No PostScript name was requested, so the file's first face IS the request.
    case firstFaceNoNameRequested
    /// The file lookup missed, but a system-wide by-name resolution returned a
    /// face whose PostScript name equals the request (verified).
    case byNameVerified
    /// No file was supplied; resolved by name alone, WITHOUT verifying that
    /// CoreText returned the requested face (it substitutes a default when the
    /// name is unknown). The one route whose face is not guaranteed.
    case byNameUnverified
}

struct FontEntry {
    let ref: String
    let font: CTFont
    /// The design-unit (glyph-space) view of `font`, held here so it is built once
    /// per open rather than once per query. Advances are read from it — see
    /// `untrackedAdvances`.
    let cgFont: CGFont
    let pointSize: CGFloat
    let unitsPerEm: Int
    /// True when the returned face is guaranteed to be the requested PostScript
    /// name (or no name was requested). False only for `byNameUnverified`.
    let nameMatched: Bool
    let resolution: FontResolution
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

    // `systemUI: true` — the CSS `system-ui` / `-apple-system` primary.
    //
    // Blink does not resolve this through family matching. `CreateFontPlatformData`
    // routes it to `MatchSystemUIFont` (font_cache_mac.mm:409-412), transcribed
    // below from font_matcher_mac.mm:540-588. Chromium rev 7d859f27, 2026-06-27.
    //
    // This is NOT reproducible by opening the SF font file. Measured: with
    // `/System/Library/Fonts/SFNS.ttf` as the base, CoreText's cascade answers
    // U+6F22 with PingFangSC-Regular at every size, while Chrome answers
    // `.PingFangUITextSC-Regular` at 13px and `.PingFangUIDisplaySC-Regular` at
    // 20px. The UI font carries its own cascade list — the one that reaches
    // Apple's `.…UI` variants — and only this API returns it. Blink's own
    // comment notes the same effect for emoji: the system API "might also return
    // '.Apple Color Emoji UI' when starting from system-ui" (font_cache_mac.mm:156-159).
    if (spec["systemUI"] as? NSNumber)?.boolValue == true {
        let css = systemUICSS(from: spec)
        let cssWeight = css.weight, cssSlant = css.slant, cssWidth = css.width
        guard let f = matchSystemUIFont(weight: cssWeight, slant: cssSlant,
                                        width: cssWidth, size: CGFloat(size)) else {
            // Blink propagates this null: `CreateFontPlatformData` sees a null
            // `matched_font` and returns nullptr, i.e. the family is unavailable.
            // Say so rather than silently substituting a different base — a
            // wrong base answers a different question than the one asked, and
            // the caller would have no way to tell (same rule as `runFallbackQuery`).
            throw NSError(domain: "domotion", code: 3, userInfo: [
                NSLocalizedDescriptionKey:
                    "system-ui font unavailable at size \(size) weight \(cssWeight) width \(cssWidth) slant \(cssSlant)",
            ])
        }
        return FontEntry(ref: ref, font: f, cgFont: CTFontCopyGraphicsFont(f, nil),
                         pointSize: CGFloat(size),
                         unitsPerEm: Int(CTFontGetUnitsPerEm(f)),
                         nameMatched: true, resolution: .systemUI)
    }

    var resolution: FontResolution = .byNameUnverified
    // Set when a file WAS supplied, a name WAS requested, and no descriptor in
    // the file carried it. Nothing in the file can answer the request, so member
    // zero must not stand in for it (see the throw below).
    var nameAbsentFromFile = false

    if let path = fontPath {
        let url = URL(fileURLWithPath: path) as CFURL
        // CTFontManagerCreateFontDescriptorsFromURL returns every face in the file.
        // Note it reports CoreText's NAMED-INSTANCE-EXPANDED list, not the file's
        // physical sfnt members: SFIndia.ttc has 9 physical members but reports 81
        // descriptors (9 scripts x 9 named weights), and PingFangUI.ttc reports 268
        // for 32 members. So this loop's index is NOT a TTC member index and must
        // never be handed to a collection-indexing API (hb_face_create and
        // FT_New_Face take the physical index; the Node side resolves that
        // separately through fontkit). That is why no face index is reported here.
        if let array = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor] {
            var picked: CTFontDescriptor? = nil
            if let want = postscriptName {
                for d in array {
                    if let name = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String,
                       name == want {
                        picked = d
                        pickedNameMatch = true
                        resolution = .nameMatchedInFile
                        break
                    }
                }
                if picked == nil { nameAbsentFromFile = true }
            } else {
                // No name was requested, so the file's first face IS what was
                // asked for — not a fallback.
                picked = array.first
                resolution = .firstFaceNoNameRequested
            }
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
            pickedNameMatch = true
            resolution = .byNameVerified
            nameAbsentFromFile = false
        }
    }

    // A named request that the file could not answer and by-name could not verify
    // has no correct answer available. Report it unavailable rather than
    // substituting the file's first face.
    //
    // This used to fall back to `array.first` above, which is a different face
    // entirely: for a requested `.SFDevanagari-Regular` that the descriptor walk
    // missed, member zero of SFIndia.ttc is `.SFBangla-Ultralight` — Bangla
    // outlines, at ultralight, painted for Devanagari text. Nor can the by-name
    // second chance rescue that class of name: CoreText refuses to resolve
    // dot-prefixed system font names by name and returns TimesNewRomanPSMT
    // (measured), which the verification above correctly rejects. So the choice
    // is between a silently wrong face and an honest failure.
    //
    // Blink makes the same choice. `MatchUniqueFont` asks CoreText by name,
    // compares the result's PostScript / full name against the request, and
    // returns nullptr when they differ — "it's not the exact match that is
    // required" (font_matcher_mac.mm:451-481, Chromium 7d859f27). The systemUI
    // branch above already mirrors that; this makes the by-path branch agree.
    //
    // The caller sees a graceful failure, not a crash: `handleEnvelope` uses
    // `try?`, so the font ref is simply absent and queries naming it report
    // "fontRef missing or unknown", which routes the Node side to fontkit.
    if nameAbsentFromFile, let name = postscriptName {
        throw NSError(domain: "domotion", code: 4, userInfo: [
            NSLocalizedDescriptionKey:
                "requested PostScript name \"\(name)\" is not a face in \(fontPath ?? "<no path>") "
                + "and did not verify by name; refusing to substitute the file's first face",
        ])
    }

    if baseFont == nil, let name = postscriptName {
        // No file was supplied (or it yielded no descriptors) — a name-only
        // request, where CoreText's substitution is all there is. Recorded as
        // unverified so the caller knows the face is not guaranteed.
        baseFont = CTFontCreateWithName(name as CFString, CGFloat(size), nil)
        resolution = .byNameUnverified
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
    return FontEntry(ref: ref, font: font, cgFont: CTFontCopyGraphicsFont(font, nil),
                     pointSize: CGFloat(size), unitsPerEm: upem,
                     nameMatched: pickedNameMatch || postscriptName == nil,
                     resolution: resolution)
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

// MARK: - Advances

/// Horizontal advances for `glyphs`, in the same units `CTFontGetAdvancesForGlyphs`
/// reports (points at the font's point size) but WITHOUT AAT tracking.
///
/// `CTFontGetAdvancesForGlyphs` returns a *typesetting* advance: the glyph's design
/// advance PLUS the `trak` table's spacing adjustment interpolated at the CTFont's
/// point size. That is the right answer for laying out a run at that size, and it is
/// the wrong answer here, because the Node side opens every face at
/// `size = unitsPerEm` in order to read metrics in DESIGN units. A point size of
/// 1000 (or 2048) runs off the end of `trak`'s size table, so CoreText clamps to the
/// largest-size tracking value and adds it to every advance — a constant offset that
/// has nothing to do with the design and is not the tracking any real run wants.
///
/// Measured on `/System/Library/Fonts/SFIndia.ttc` member `.SFDevanagari-Regular`
/// (upem 1000), whose `trak` normal track is `[38, 20, 0, -10]` at sizes
/// `[12, 17, 28, 34]`: every glyph, at every `opsz` instance, came back exactly 10
/// design units short of the value an independent reader of `hmtx` + `HVAR` gets.
/// The same constant appears on every installed face carrying both `trak` and
/// `STAT` and a non-zero largest-size tracking value (126 faces on a stock install:
/// the SF Indic / Compact / Camera families, New York, and Apple Color Emoji).
/// `STAT` is load-bearing — measured, CoreText applies `trak` only when the face
/// also carries `STAT`, matching HarfBuzz's own gate
/// (`plan.apply_trak = hb_aat_layout_has_tracking (face) && face->table.STAT->has_data ()`,
/// `hb-ot-shape.cc:218`, HarfBuzz 4de187d) — so Hoefler Text, Skia and Apple
/// Chancery carry a non-zero `trak` and are untouched.
///
/// Tracking belongs at the run's point size, applied once, downstream: Chrome sets
/// it via `hb_font_set_ptem(unscaled_font, specified_size)`
/// (`third_party/blink/renderer/platform/fonts/shaping/harfbuzz_face.cc:645-648`,
/// Chromium 7d859f27), and the Node side mirrors that by routing `trak` + `STAT`
/// faces' shaping through HarfBuzz. Baking a size-1000 tracking value into the
/// design-unit advance both double-counts it and uses the wrong size.
///
/// The replacement reads the advance from the CTFont's CGFont, which is a
/// design-unit (glyph-space) object with no point size and therefore no tracking.
/// It carries the variation coordinates through, so the `opsz` instance the caller
/// asked for is still the one measured. Verified against fontkit across the
/// `trak` + `STAT` faces: the CGFont advance equals fontkit's `hmtx` + `HVAR`
/// advance rounded to the nearest design unit at every sample, and the residual
/// rounding is HarfBuzz's own (`advance + roundf (var_table->get_advance_delta_unscaled (…))`,
/// `hb-ot-hmtx-table.hh:369-375`) — a variable font's advances are integers in
/// every consumer that matters.
func untrackedAdvances(_ entry: FontEntry, glyphs: [CGGlyph]) -> [CGFloat]? {
    if glyphs.isEmpty { return [] }
    let upem = CGFloat(entry.unitsPerEm)
    guard upem > 0 else { return nil }
    let cgFont = entry.cgFont
    var designUnits = [Int32](repeating: 0, count: glyphs.count)
    let ok = glyphs.withUnsafeBufferPointer { gbuf in
        designUnits.withUnsafeMutableBufferPointer { abuf in
            cgFont.getGlyphAdvances(glyphs: gbuf.baseAddress!, count: glyphs.count,
                                    advances: abuf.baseAddress!)
        }
    }
    guard ok else { return nil }
    let scale = entry.pointSize / upem
    return designUnits.map { CGFloat($0) * scale }
}

/// `untrackedAdvances`, degrading to CoreText's tracked advance when the CGFont
/// route is unavailable. A tracked advance is wrong by a constant, but it is closer
/// than zero, and the caller has no way to signal "no advance".
func advances(for entry: FontEntry, glyphs: [CGGlyph]) -> [CGFloat] {
    if let untracked = untrackedAdvances(entry, glyphs: glyphs) {
        return untracked
    }
    var tracked: [CGSize] = Array(repeating: .zero, count: glyphs.count)
    if !glyphs.isEmpty {
        glyphs.withUnsafeBufferPointer { gbuf in
            tracked.withUnsafeMutableBufferPointer { abuf in
                _ = CTFontGetAdvancesForGlyphs(entry.font, .horizontal, gbuf.baseAddress!,
                                               abuf.baseAddress!, glyphs.count)
            }
        }
    }
    return tracked.map { $0.width }
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

    // Advances, design-unit (no AAT tracking) — see `untrackedAdvances`.
    let glyphAdvances = advances(for: entry, glyphs: glyphs)

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
        let advance = glyphAdvances[i]
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
    // Design-unit advance (no AAT tracking) — see `untrackedAdvances`.
    let advance = advances(for: entry, glyphs: [0])[0]
    let path = svgPath(forGlyph: 0, in: font)
    return ["type": "notdef", "id": 0,
            "advance": NSDecimalNumber(string: formatNumber(advance)),
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
        // Deliberately NOT routed through `untrackedAdvances`: a run advance is a
        // typeset advance, carrying kerning and GPOS as well as AAT tracking, and
        // no design-unit API reproduces those. So this one keeps CoreText's
        // tracking-at-the-open-size, which for a face opened at size = unitsPerEm
        // is the wrong size. That is exactly why the Node side routes shaping for
        // `trak` + `STAT` faces through HarfBuzz — which applies tracking once, at
        // the run's real point size, the way Blink does — instead of through this
        // query. The `glyphs` query above has no such excuse and must not track.
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
        "descent": descentUnits,
        // How the face was arrived at. `nameMatched: false` means the returned
        // outlines are NOT guaranteed to be the requested PostScript name, so a
        // caller must not read them as evidence of which face was loaded.
        // Deliberately no face index: this helper's descriptor enumeration is
        // CoreText's named-instance-expanded list, not the file's physical sfnt
        // member order, so any index from here would be wrong for hb_face_create.
        "nameMatched": entry.nameMatched,
        "resolution": entry.resolution.rawValue,
        "postscriptName": (CTFontCopyPostScriptName(font) as String?) ?? "",
        // DM-1880: CoreText's own symbolic traits. Blink's macOS synthetic-bold
        // rule is `Weight() > 500 && !(traits & kCTFontTraitBold)`
        // (`mac/font_cache_mac.mm:424-427`) — it asks the TRAIT, not a numeric
        // weight, and the two disagree. Standing in `usWeightClass >= 600` for
        // the trait measurably regressed a fixture, so the trait itself has to
        // travel. Italic ships alongside because the sibling rule at `:432-435`
        // reads `kCTFontTraitItalic` the same way.
        "traitBold": (CTFontGetSymbolicTraits(font).rawValue & CTFontSymbolicTraits.traitBold.rawValue) != 0,
        "traitItalic": (CTFontGetSymbolicTraits(font).rawValue & CTFontSymbolicTraits.traitItalic.rawValue) != 0
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

// MARK: - Declared-family style matching (font_matcher_mac.mm)

// CoreText weight trait (-1.0 … 1.0) → CSS weight. Transcribed verbatim from
// `ToCSSFontWeight`, font_matcher_mac.mm:845-860 (Chromium 7d859f27), whose own
// ranges come from `GetFontWeightFromCTFont` in ui/gfx/platform_font_mac.mm.
//
// This is the INVERSE direction from `toCTFontWeight` above, and both are needed:
// the fallback path asks CoreText for a weight, this one reads a candidate's
// declared weight back out so it can be compared in CSS units.
func toCSSFontWeight(_ ctWeight: Float) -> Int {
    let ranges: [(Float, Float, Int)] = [
        (-1.00, -0.70, 100), (-0.70, -0.45, 200), (-0.45, -0.10, 300),
        (-0.10,  0.10, 400), ( 0.10,  0.27, 500), ( 0.27,  0.35, 600),
        ( 0.35,  0.50, 700), ( 0.50,  0.60, 800), ( 0.60,  1.00, 900),
    ]
    for (lo, hi, css) in ranges where ctWeight >= lo && ctWeight < hi { return css }
    return ctWeight < -1.0 ? 100 : 900
}

// AppKit's own reported weight → CSS weight. Transcribed verbatim from
// `AppKitToCSSFontWeight`, font_matcher_mac.mm:892-902 (Chromium 7d859f27).
// `kThinWeightValue` 100 / `kBlackWeightValue` 900 (font_selection_types.h).
func appKitToCSSFontWeight(_ appKitWeight: Int) -> Int {
    if appKitWeight < 0 { return 400 }
    if appKitWeight < 7 { return max((appKitWeight - 1) * 100, 100) }
    return min((appKitWeight - 2) * 100, 900)
}

// Transcribed from `BetterChoiceCT`, font_matcher_mac.mm:172-220 at Chromium
// refs/tags/147.0.7727.15 — the tag of the Chrome build Playwright pins
// (playwright-core browsers.json: chromium 147.0.7727.15), which is the
// browser every capture and every conformance measurement runs against.
//
// The local `external/chromium` checkout (rev 7d859f27, 2026-06-27) carries a
// NEWER version of this comparator: a directional `BetterWeightMatch` (its
// :100-139; below CSS 400 prefer any candidate at or below the desired weight,
// above 500 any at or above) with the bold trait deliberately dropped from the
// mask list (its :225-229). That rewrite landed after the 147 branch point and
// is NOT in the binary we target. Measured over CDP against the shipping build
// on a 20-family x 41-weight sweep (760 scored cases), this 147 transcription
// agrees 760/760 where the directional port agreed 567/760 — the disagreement
// bands (e.g. Helvetica 305-399 and 501-599 both painting plain Helvetica)
// are exactly the intermediate weights the directional search decides
// differently. When the pinned Chromium moves to a build that contains the
// directional rewrite, this function is what must be re-transcribed.
func betterChoiceCT(_ desiredTraits: CTFontSymbolicTraits, _ desiredWeight: Int,
                    _ chosenTraits: CTFontSymbolicTraits, _ chosenWeight: Int,
                    _ candidateTraits: CTFontSymbolicTraits, _ candidateWeight: Int) -> Bool {
    // Worst-to-best mismatch order, and the ORDER IS LOAD-BEARING: the loop
    // returns on the first mask that discriminates. Source order at 147 is
    // condensed, expanded, italic, bold (`:181-183`) — bold IS in the list,
    // and it is what turns the heavy end "directional": at a desired weight
    // >= 600 the bold trait becomes desired, so every non-bold face loses on
    // traits before weight distance is ever compared (Avenir at 600 takes
    // Heavy over the nearer Medium for this reason alone).
    let masks: [CTFontSymbolicTraits] = [.traitCondensed, .traitExpanded, .traitItalic, .traitBold]
    for mask in masks {
        // `:186-196`: CoreText reports a bold trait for some faces Blink maps
        // below its 600 bold threshold (HiraginoSans-W5, AppKit weight 6 ->
        // CSS 500), which would keep an exact-weight candidate from ever
        // winning. So on the bold mask, an exact-weight candidate beats an
        // inexact chosen regardless of the trait bit.
        if mask == .traitBold && candidateWeight == desiredWeight && chosenWeight != desiredWeight {
            return true
        }
        let desired = !desiredTraits.intersection(mask).isEmpty
        let chosenUnwanted = desired != !chosenTraits.intersection(mask).isEmpty
        let candidateUnwanted = desired != !candidateTraits.intersection(mask).isEmpty
        if !candidateUnwanted && chosenUnwanted { return true }
        if !chosenUnwanted && candidateUnwanted { return false }
    }
    // `:209-219`: nearest CSS weight; on a tie prefer the candidate further
    // from medium (500). The tie is what selects Helvetica-Light (CSS 200 via
    // AppKit weight 3) over plain Helvetica (400) at exactly CSS 300, while
    // every weight 305-399 is strictly nearer to 400 and takes the regular.
    let chosenDelta = abs(chosenWeight - desiredWeight)
    let candidateDelta = abs(candidateWeight - desiredWeight)
    if chosenDelta == candidateDelta {
        return abs(candidateWeight - 500) > abs(chosenWeight - 500)
    }
    return candidateDelta < chosenDelta
}

// Best member of a DECLARED family for a CSS weight + traits.
//
// Mirrors `BestStyleMatchForFamilyNS`, font_matcher_mac.mm:231-277 at Chromium
// refs/tags/147.0.7727.15 — the tag of the Chrome build Playwright pins, which
// is the path shipping Chrome takes (`FontFamilyStyleMatchingCTMigration`
// carries no `status:` in runtime_enabled_features.json5 at that tag, so it is
// off by default and `MatchFontFamily` at :548-552 dispatches here). Faithful
// to :244-269:
//   - candidates come from AppKit `availableMembersOfFontFamily`, in
//     enumeration order (order matters — ties keep the first scanned);
//   - candidate weight is `AppKitToCSSFontWeight(font_info[2])` (:245-249) —
//     the APPKIT weight, which collapses some distinct faces onto one CSS
//     value (PingFang Thin and Light are both AppKit 3 -> CSS 200, and
//     Helvetica-Light is AppKit 3 -> CSS 200, not 300);
//   - candidate traits are `font_info[3] & kImportantTraitsMask` (:251-255).
//     AppKit's NSFontTraitMask and CTFontSymbolicTraits agree on all four
//     masked bits (italic 1<<0, bold 1<<1, expanded 1<<5, condensed 1<<6),
//     which is what lets Blink mask AppKit bits with a CT constant;
//   - the desired bold trait derives from the weight: `ComputeDesiredTraits`
//     (:134-151) sets it iff desired_weight >= 600 (kBoldThreshold). With the
//     bold mask back in `betterChoiceCT`'s loop this is load-bearing: it is
//     what sends every >= 600 request to a bold-flagged face when one exists;
//   - the first member is unconditionally chosen (:257 has no
//     `AcceptableChoice` gate), and the early break on an exact weight+traits
//     match (:264-268) is a pure optimization — no later candidate can
//     displace an exact match — so this port omits it.
//
// The CoreText descriptor's weight is still read and reported as
// `descriptorWeight` for diagnostics, but it does NOT participate in the
// choice: an earlier version of this port preferred it, which gave PingFang SC
// six distinct weights and picked Light at CSS 300 where Chrome paints Thin.
func runFamilyMatchQuery(_ query: [String: Any]) -> [String: Any] {
    guard let family = query["family"] as? String, !family.isEmpty else {
        return ["type": "familyMatch", "found": false, "error": "family required"]
    }
    let desiredWeight = (query["cssWeight"] as? NSNumber)?.intValue ?? 400
    // Transcribed from `ComputeDesiredTraits`, font_matcher_mac.mm:185-202
    // (Chromium 7d859f27). `kNormalWidthValue` is 100 (font_selection_types.h:233),
    // and the width comparison is strict on both sides — a family's condensed cut
    // is asked for at ANY width below 100%, its expanded cut at any width above,
    // and 100% asks for neither.
    //
    // The width half was missing until now, and `BetterChoiceCT` compares
    // condensed FIRST of its three masks (font_matcher_mac.mm:234-235), so its
    // absence was not a rounding error: a `font-stretch: 50%` run scored every
    // candidate as though the author had asked for normal width, and a family
    // shipping a condensed cut (Papyrus does) resolved to its normal one.
    let desiredWidth = (query["cssWidth"] as? NSNumber)?.doubleValue ?? 100
    var desiredTraits: CTFontSymbolicTraits = []
    if (query["italic"] as? NSNumber)?.boolValue == true { desiredTraits.insert(.traitItalic) }
    if (query["bold"] as? NSNumber)?.boolValue == true { desiredTraits.insert(.traitBold) }
    // `ComputeDesiredTraits` sets all three from the description in one pass —
    // bold from the WEIGHT (not a separate request), then expanded/condensed
    // from the WIDTH, each comparison strict against `kNormalWidthValue` = 100
    // (`font_selection_types.h:233`). Transcribed from
    // `font_matcher_mac.mm:185-202`; the same body appears at Chromium tag
    // 147.0.7727.15 (the build Playwright pins) and at checkout rev 7d859f27,
    // so this function is one of the parts that did NOT drift between them.
    if desiredWeight >= 600 { desiredTraits.insert(.traitBold) }
    if desiredWidth > 100 { desiredTraits.insert(.traitExpanded) }
    if desiredWidth < 100 { desiredTraits.insert(.traitCondensed) }

    let members = NSFontManager.shared.availableMembers(ofFontFamily: family) ?? []
    if members.isEmpty {
        // Blink falls back to the CoreText enumeration here (`:284-286`). Report
        // rather than guess: the caller keeps its existing selection, and a
        // silent wrong answer is the failure mode this whole area is removing.
        return ["type": "familyMatch", "found": false, "reason": "no AppKit members"]
    }

    var matchedName: String? = nil
    var chosenTraits: CTFontSymbolicTraits = []
    var chosenWeight = 400
    var candidates: [[String: Any]] = []
    for info in members {
        guard let candidateName = info.first as? String else { continue }
        let appKitWeight = (info.count > 2 ? (info[2] as? NSNumber)?.intValue : nil) ?? -1
        let appKitTraits = (info.count > 3 ? (info[3] as? NSNumber)?.intValue : nil) ?? -1

        // AppKit's reported weight, NOT the CoreText descriptor's — Blink reads
        // `font_info[2]` (:245-249) and defaults to kNormalWeightValue (400)
        // when AppKit reports none, which `appKitToCSSFontWeight(-1)` mirrors.
        let candidateWeight = appKitToCSSFontWeight(appKitWeight)
        // Traits are AppKit's `font_info[3]` masked to the four important
        // bits, exactly as Blink does at :251-255 — NSFontTraitMask and
        // CTFontSymbolicTraits agree on those bit positions (italic 1<<0,
        // bold 1<<1, expanded 1<<5, condensed 1<<6).
        let candidateTraits = appKitTraits >= 0
            ? CTFontSymbolicTraits(rawValue: UInt32(truncatingIfNeeded: appKitTraits)).intersection(kTraitsMask)
            : []
        // The descriptor weight is reported for diagnostics only.
        let desc = CTFontDescriptorCreateWithNameAndSize(candidateName as CFString, 0)
        var descriptorCSSWeight = -1
        if let traits = CTFontDescriptorCopyAttribute(desc, kCTFontTraitsAttribute) as? [CFString: Any],
           let w = traits[kCTFontWeightTrait] as? NSNumber {
            descriptorCSSWeight = toCSSFontWeight(w.floatValue)
        }
        candidates.append(["name": candidateName, "weight": candidateWeight,
                           "descriptorWeight": descriptorCSSWeight,
                           "traits": candidateTraits.rawValue,
                           "appKitWeight": appKitWeight, "appKitTraits": appKitTraits])
        if matchedName == nil || betterChoiceCT(desiredTraits, desiredWeight,
                                                chosenTraits, chosenWeight,
                                                candidateTraits, candidateWeight) {
            matchedName = candidateName
            chosenTraits = candidateTraits
            chosenWeight = candidateWeight
        }
    }
    guard let name = matchedName else {
        return ["type": "familyMatch", "found": false, "reason": "no candidate chosen"]
    }
    return ["type": "familyMatch", "found": true, "postscriptName": name,
            "weight": chosenWeight, "candidates": candidates]
}

// MARK: - System fallback resolution (CTFontCreateForString)

// The CoreText weight trait of a font, defaulting to CoreText's "normal" (0.0)
// when the font declares none. Transcribed from the `get_ct_font_weight` lambda
// in `GetAlternateFontPlatformData`, font_cache_mac.mm:214-226 (Chromium
// 7d859f27).
let kCTNormalWeightValue: Float = 0.0

func ctFontWeightTrait(_ font: CTFont) -> Float {
    guard let traits = CTFontCopyTraits(font) as? [CFString: Any],
          let n = traits[kCTFontWeightTrait] as? NSNumber else {
        return kCTNormalWeightValue
    }
    return n.floatValue
}

// CSS weight → CoreText weight trait. Transcribed verbatim from
// `ToCTFontWeight`, font_matcher_mac.mm:871-887 (Chromium 7d859f27), whose own
// ranges come from `GetFontWeightFromCTFont` in ui/gfx/platform_font_mac.mm.
func toCTFontWeight(_ cssWeight: Int) -> Float {
    if cssWeight <= 50 || cssWeight >= 950 { return 0.0 }
    let weights: [Float] = [
        -0.80,  // Thin (Hairline)
        -0.60,  // Extra Light (Ultra Light)
        -0.40,  // Light
        0.0,    // Normal (Regular)
        0.23,   // Medium
        0.30,   // Semi Bold (Demi Bold)
        0.40,   // Bold
        0.56,   // Extra Bold (Ultra Bold)
        0.62,   // Black (Heavy)
    ]
    return weights[(cssWeight - 50) / 100]
}

// Only the typeface bits matter; some fonts carry appearance information in the
// upper 16 bits (Times Roman = 1 << 28, Helvetica = 1 << 30). Transcribed from
// `TraitsMask` / `TraitsMismatch`, font_cache_mac.mm:71-72 and 195-198.
let kTraitsMask: CTFontSymbolicTraits = [.traitItalic, .traitBold, .traitCondensed, .traitExpanded]

func traitsMismatch(_ desired: CTFontSymbolicTraits, _ found: CTFontSymbolicTraits) -> Bool {
    return desired.intersection(kTraitsMask) != found.intersection(kTraitsMask)
}

// Find the face WITHIN the substitute's own family that best matches the
// requested symbolic traits + weight. Transcribed from
// `CreateCopyWithTraitsAndWeightFromFont`, font_cache_mac.mm:74-109. Blink uses
// `CTFontCreateWithFontDescriptor` rather than `CTFontCreateCopyWithAttributes`
// because the latter hands back the same face instead of the better style match.
func createCopyWithTraitsAndWeightFromFont(
    _ font: CTFont, _ traits: CTFontSymbolicTraits, _ weight: Float, _ size: CGFloat
) -> CTFont? {
    // Broken fonts may lack a family name (name ID 1); Blink bails out there.
    guard let familyName = CTFontCopyFamilyName(font) as String? else { return nil }
    let traitsDict: [CFString: Any] = [
        kCTFontSymbolicTrait: NSNumber(value: traits.rawValue),
        kCTFontWeightTrait: NSNumber(value: weight),
    ]
    let attributes: [CFString: Any] = [
        kCTFontFamilyNameAttribute: familyName,
        kCTFontTraitsAttribute: traitsDict,
    ]
    let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
    return CTFontCreateWithFontDescriptor(descriptor, size, nil)
}

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
//
// CTFontCreateForString is only the FIRST half of what Blink does. The cascade
// answers with one nominated face per family — Songti SC Light for Han, Euphemia
// UCAS Regular for Canadian Aboriginal — regardless of the weight the CSS asked
// for. `GetAlternateFontPlatformData` (font_cache_mac.mm:200-280) then re-selects
// within that family at the requested traits + weight, which is why Chrome paints
// STSongti-SC-Regular at weight 400 and STSongti-SC-Black at 900 for the same
// character. Omitting that step pinned every fallback family to whichever cut
// CoreText happened to nominate. The `cssWeight` / `bold` / `italic` query fields
// carry the CSS description in; without them the query behaves as before.
func runFallbackQuery(_ query: [String: Any], fonts: [String: FontEntry]) -> [String: Any] {
    // Base font drives the cascade list + trait matching. Use the caller's
    // primary font when provided (matches Chrome, which starts from the
    // element's resolved primary), else a neutral system font at 16pt.
    // A caller that NAMES a base and doesn't get it must hear about it. Falling
    // back to Helvetica here would answer a different question than the one
    // asked — CoreText's cascade depends on the font you ask FROM — and the
    // caller would have no way to tell.
    let baseFont: CTFont
    if let ref = query["fontRef"] as? String {
        guard let entry = fonts[ref] else {
            return ["type": "fallback", "error": "fontRef missing or unknown: \(ref)"]
        }
        baseFont = entry.font
    } else {
        baseFont = CTFontCreateWithName("Helvetica" as CFString, 16.0, nil)
    }
    let cps = (query["cps"] as? [NSNumber])?.map { $0.uint32Value } ?? []
    let size = CTFontGetSize(baseFont)

    // The CSS description drives the in-family re-selection below. `cssWeight`
    // absent → no re-selection (the pre-DM-1854 behavior), so an older caller
    // keeps working.
    let cssWeight = (query["cssWeight"] as? NSNumber)?.intValue
    // Blink starts from the traits of the run's CURRENT font and ORs in the
    // synthetic ones the platform data carries (font_cache_mac.mm:230-240):
    // a bold request satisfied by faux-bold still asks the fallback family for
    // its bold cut. Our base font stands in for the run primary at its regular
    // cut, so the requested bold / italic arrive as those synthetic flags.
    var desiredTraits = CTFontGetSymbolicTraits(baseFont)
    if (query["bold"] as? NSNumber)?.boolValue == true { desiredTraits.insert(.traitBold) }
    if (query["italic"] as? NSNumber)?.boolValue == true { desiredTraits.insert(.traitItalic) }

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
        var substitute = CTFontCreateForString(baseFont, s as CFString, range)
        var psName = (CTFontCopyPostScriptName(substitute) as String?) ?? ""
        if psName == lastResortName || psName.isEmpty {
            out.append(["cp": Int(cp), "found": false])
            continue
        }
        // In-family weight / traits re-selection — `GetAlternateFontPlatformData`,
        // font_cache_mac.mm:242-267. Blink's `|| !ct_font` disjuncts only fire for
        // FreeType-backed web fonts, which never reach this helper, so they are
        // omitted rather than transcribed as dead branches.
        if let cssWeight {
            let desiredWeight = toCTFontWeight(cssWeight)
            let substituteTraits = CTFontGetSymbolicTraits(substitute)
            let substituteWeight = ctFontWeightTrait(substitute)
            if traitsMismatch(desiredTraits, substituteTraits) || desiredWeight != substituteWeight {
                if let best = createCopyWithTraitsAndWeightFromFont(substitute, desiredTraits, desiredWeight, size) {
                    let bestTraits = CTFontGetSymbolicTraits(best)
                    let bestWeight = ctFontWeightTrait(best)
                    // Only adopt a face that actually moved AND still covers the
                    // character — a family's bold cut can have a narrower cmap
                    // than the regular one CoreText nominated.
                    if bestTraits != substituteTraits || bestWeight != substituteWeight {
                        let charSet = CTFontCopyCharacterSet(best)
                        if CFCharacterSetIsLongCharacterMember(charSet, UTF32Char(cp)) {
                            substitute = best
                            psName = (CTFontCopyPostScriptName(substitute) as String?) ?? psName
                        }
                    }
                }
            }
        }
        let familyName = (CTFontCopyFamilyName(substitute) as String?) ?? ""
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
    // The `system-ui` CSS parameters decide WHICH face this spec resolves to
    // (`matchSystemUIFont` applies bold/italic symbolic traits and a `wght`
    // variation from them), so leaving them out of the key made the cache
    // answer a different question than the one asked. Measured: at one size,
    // whichever WEIGHT asked first won, and every later weight at that size got
    // that face — so `system-ui` CJK at 13px resolved to the Text cut or the
    // Display cut purely according to sweep order.
    var uiKey = ""
    if (spec["systemUI"] as? NSNumber)?.boolValue == true {
        // Keyed on the RESOLVED values, from the same function `openFont` uses,
        // so the key cannot drift from the derivation. Keying on the raw fields
        // would miss that `slant` also comes from the older boolean `italic`.
        let css = systemUICSS(from: spec)
        uiKey = "|ui:\(css.weight),\(css.slant),\(css.width)"
    }
    return "\(ps)|\(fp)|\(sz)|\(varKey)\(uiKey)"
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
        case "familyMatch": results.append(runFamilyMatchQuery(query))
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
