import Foundation
import CoreText

let codepoints: [UInt32] = [0x270EF, 0x270F0, 0x270F1, 0x270F3, 0x270F4, 0x270F5]
let repeats = Int(CommandLine.arguments.dropFirst().first ?? "1") ?? 1

func scalarString(_ cp: UInt32) -> String { String(UnicodeScalar(cp)!) }
func jsonValue(_ value: Any?) -> Any {
  guard let value else { return NSNull() }
  if let url = value as? URL { return url.path }
  if let data = value as? Data { return data.base64EncodedString() }
  if let dict = value as? [AnyHashable: Any] {
    return Dictionary(uniqueKeysWithValues: dict.map { (String(describing: $0.key), jsonValue($0.value)) })
  }
  if let array = value as? [Any] { return array.map(jsonValue) }
  if value is String || value is NSNumber || value is NSNull { return value }
  return String(describing: value)
}

func glyphRecord(_ font: CTFont, _ cp: UInt32) -> [String: Any] {
  let units = Array(scalarString(cp).utf16)
  var glyphs = Array(repeating: CGGlyph(0), count: units.count)
  _ = CTFontGetGlyphsForCharacters(font, units, &glyphs, units.count)
  let glyph = glyphs.first(where: { $0 != 0 }) ?? 0
  var g = glyph
  var advance = CGSize.zero
  let bounds = CTFontGetBoundingRectsForGlyphs(font, .default, &g, nil, 1)
  _ = CTFontGetAdvancesForGlyphs(font, .default, &g, &advance, 1)
  return ["codepoint": cp, "hex": String(format: "U+%05X", cp), "glyph": glyph,
          "bounds": ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height],
          "advance": ["width": advance.width, "height": advance.height]]
}

func fontRecord(_ font: CTFont, _ arm: String) -> [String: Any] {
  let descriptor = CTFontCopyFontDescriptor(font)
  let attrs = CTFontDescriptorCopyAttributes(descriptor) as NSDictionary
  let matrix = CTFontGetMatrix(font)
  return [
    "arm": arm,
    "postscriptName": CTFontCopyPostScriptName(font),
    "familyName": CTFontCopyFamilyName(font),
    "displayName": CTFontCopyDisplayName(font),
    "url": jsonValue(CTFontCopyAttribute(font, kCTFontURLAttribute)),
    "ttcIndex": jsonValue(attrs["NSCTFontIndexAttribute"] ?? attrs["CTFontIndex"]),
    "descriptor": jsonValue(attrs),
    "variationAxes": jsonValue(CTFontCopyVariationAxes(font)),
    "variation": jsonValue(CTFontCopyVariation(font)),
    "unitsPerEm": CTFontGetUnitsPerEm(font),
    "matrix": [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty],
    "glyphs": codepoints.map { glyphRecord(font, $0) },
  ]
}

var samples: [[String: Any]] = []
for iteration in 0..<repeats {
  let base = CTFontCreateWithName("STHeitiSC-Light" as CFString, 32, nil)
  for cp in codepoints {
    let text = scalarString(cp)
    let live = CTFontCreateForString(base, text as CFString, CFRange(location: 0, length: text.utf16.count))
    let canonical = CTFontCreateWithName(CTFontCopyPostScriptName(live), 32, nil)
    let display = CTFontCreateWithName(CTFontCopyDisplayName(live), 32, nil)
    let weightedDescriptor = CTFontDescriptorCreateCopyWithAttributes(CTFontCopyFontDescriptor(live), [kCTFontTraitsAttribute: [kCTFontWeightTrait: 0.0]] as CFDictionary)
    let explicit400 = CTFontCreateWithFontDescriptor(weightedDescriptor, 32, nil)
    samples.append(["iteration": iteration, "queryCodepoint": cp, "arms": [
      fontRecord(live, "live-fallback"), fontRecord(canonical, "canonical-postscript"),
      fontRecord(display, "display-name"), fontRecord(explicit400, "explicit-wght-400")
    ]])
  }
}
let output: [String: Any] = ["base": "STHeitiSC-Light", "size": 32, "samples": samples]
let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0a]))
