// Proposal-side SFNS terminal-mask collector. This source is copied into and
// compiled against the exact Skia revision below. It is never production code.
#include "include/core/SkData.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontArguments.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontParameters.h"
#include "include/core/SkFontTypes.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkStream.h"
#include "include/core/SkSurfaceProps.h"
#include "include/core/SkTypeface.h"
#include "include/ports/SkFontMgr_mac_ct.h"
#include "include/ports/SkTypeface_mac.h"
#include "src/core/SkArenaAlloc.h"
#include "src/core/SkDescriptor.h"
#include "src/core/SkGlyph.h"
#include "src/core/SkMaskGamma.h"
#include "src/core/SkScalerContext.h"
#include "src/ports/SkTypeface_mac_ct.h"
#include "src/utils/mac/SkCTFont.h"
#include "src/utils/mac/SkCTFontCreateExactCopy.h"

#include "hb-ot.h"
#include "hb.h"

#include <CommonCrypto/CommonDigest.h>
#include <CoreText/CoreText.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {
constexpr char kChromiumRevision[] = "7d859f271cbda744098ac69f44978d4edfa62be3";
constexpr char kSkiaRevision[] = "62efacd37737505732dbe3d8daa62abd679626a1";
constexpr char kFontSha256[] = "44890958f3e0b997028121ed7c7a789f3f5cce227c7a93ce8f86ec0db26da571";
constexpr size_t kFontByteLength = 7872432;
constexpr char kDecodedFontSha256[] =
    "e2165f571fe3a383b57123a1a91234b2b2a2859f0510af2b97e3ef129a352226";
constexpr size_t kDecodedFontByteLength = 7867744;
constexpr char kCollectorAbi[] = "domotion-sfns-pinned-skia-mask-v2";

struct Options {
    std::string caseId, kind, scenario, controlId, observationId, lifecycle;
    std::string outputDirectory, sourceFontPath, decodedFontPath, text;
    float fontSize = 26, wdth = 100, opsz = 17, grad = 400, wght = 700;
    float sourceStartX = 0, sourceStartY = 0, deviceBaseline = 43;
    float textContrast = 0, textGamma = 0;
    uint32_t surfaceFlags = 0, scalerContextFlags = 3;
    std::array<float, 9> deviceMatrix = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    int ordinal = 1, warmups = 0;
    SkPixelGeometry pixelGeometry = kRGB_H_SkPixelGeometry;
    SkFont::Edging edging = SkFont::Edging::kSubpixelAntiAlias;
    SkFontHinting hinting = SkFontHinting::kNormal;
    std::vector<SkGlyphID> glyphIds;
};

[[noreturn]] void fail(const std::string& message) {
    std::cerr << "SFNS pinned-Skia collector: " << message << '\n';
    std::exit(2);
}

std::string escape(std::string_view value) {
    std::ostringstream out;
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20) out << "\\u" << std::hex << std::setw(4)
                                  << std::setfill('0') << static_cast<int>(c) << std::dec;
                else out << c;
        }
    }
    return out.str();
}
std::string q(std::string_view value) { return "\"" + escape(value) + "\""; }
std::string num(double value) {
    if (!std::isfinite(value)) fail("non-finite numeric evidence");
    std::ostringstream out; out << std::setprecision(17) << value; return out.str();
}
std::string sha(const void* bytes, size_t size) {
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256(bytes, static_cast<CC_LONG>(size), digest.data());
    std::ostringstream out;
    for (unsigned char byte : digest) out << std::hex << std::setw(2)
                                         << std::setfill('0') << static_cast<int>(byte);
    return out.str();
}
std::string b64(const void* raw, size_t size) {
    constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto* bytes = static_cast<const uint8_t*>(raw);
    std::string out; out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3) {
        uint32_t v = static_cast<uint32_t>(bytes[i]) << 16;
        if (i + 1 < size) v |= static_cast<uint32_t>(bytes[i + 1]) << 8;
        if (i + 2 < size) v |= bytes[i + 2];
        out += alphabet[(v >> 18) & 63]; out += alphabet[(v >> 12) & 63];
        out += i + 1 < size ? alphabet[(v >> 6) & 63] : '=';
        out += i + 2 < size ? alphabet[v & 63] : '=';
    }
    return out;
}
std::vector<std::string> split(std::string_view input, char delimiter) {
    std::vector<std::string> result;
    for (size_t start = 0; start <= input.size();) {
        size_t end = input.find(delimiter, start);
        if (end == std::string_view::npos) end = input.size();
        result.emplace_back(input.substr(start, end - start));
        start = end + 1;
    }
    return result;
}
float asFloat(const std::string& input, const char* name) {
    char* end = nullptr; errno = 0; float value = std::strtof(input.c_str(), &end);
    if (errno || end == input.c_str() || *end || !std::isfinite(value))
        fail(std::string("invalid ") + name + ": " + input);
    return value;
}
int asInt(const std::string& input, const char* name) {
    char* end = nullptr; errno = 0; long value = std::strtol(input.c_str(), &end, 10);
    if (errno || end == input.c_str() || *end) fail(std::string("invalid ") + name);
    return static_cast<int>(value);
}
uint32_t asUint32(const std::string& input, const char* name) {
    char* end = nullptr; errno = 0; unsigned long value = std::strtoul(input.c_str(), &end, 10);
    if (errno || end == input.c_str() || *end || value > UINT32_MAX)
        fail(std::string("invalid ") + name);
    return static_cast<uint32_t>(value);
}

Options parseOptions(int argc, char** argv) {
    std::map<std::string, std::string> values;
    for (int i = 1; i < argc; i += 2) {
        if (i + 1 >= argc || std::string_view(argv[i]).substr(0, 2) != "--")
            fail("arguments must be --name value pairs");
        values.emplace(std::string(argv[i]).substr(2), argv[i + 1]);
    }
    auto req = [&](const char* name) {
        auto it = values.find(name);
        if (it == values.end() || it->second.empty()) fail(std::string("missing --") + name);
        return it->second;
    };
    Options o;
    o.caseId = req("case-id"); o.kind = req("kind");
    o.scenario = req("scenario"); o.controlId = req("control-id");
    if (o.controlId == "-") o.controlId.clear();
    o.observationId = req("observation-id");
    o.lifecycle = req("lifecycle"); o.outputDirectory = req("output-directory");
    o.sourceFontPath = req("source-font"); o.decodedFontPath = req("decoded-font");
    o.text = req("text");
    o.fontSize = asFloat(req("font-size"), "font-size");
    o.wdth = asFloat(req("wdth"), "wdth"); o.opsz = asFloat(req("opsz"), "opsz");
    o.grad = asFloat(req("grad"), "grad"); o.wght = asFloat(req("wght"), "wght");
    const auto start = split(req("source-start"), ',');
    if (start.size() != 2) fail("source-start must have two elements");
    o.sourceStartX = asFloat(start[0], "source-start-x");
    o.sourceStartY = asFloat(start[1], "source-start-y");
    o.deviceBaseline = asFloat(req("device-baseline"), "device-baseline");
    const auto matrix = split(req("device-matrix"), ',');
    if (matrix.size() != 9) fail("device-matrix must have nine elements");
    for (size_t i = 0; i < matrix.size(); ++i) {
        o.deviceMatrix[i] = asFloat(matrix[i], "device-matrix");
    }
    o.surfaceFlags = asUint32(req("surface-flags"), "surface-flags");
    o.textContrast = asFloat(req("text-contrast"), "text-contrast");
    o.textGamma = asFloat(req("text-gamma"), "text-gamma");
    o.scalerContextFlags = asUint32(req("scaler-context-flags"), "scaler-context-flags");
    o.ordinal = asInt(req("ordinal"), "ordinal"); o.warmups = asInt(req("warmups"), "warmups");
    for (const auto& v : split(req("glyph-ids"), ',')) {
        int gid = asInt(v, "glyph-id");
        if (gid < 0 || gid > 65535) fail("glyph id outside uint16");
        o.glyphIds.push_back(static_cast<SkGlyphID>(gid));
    }
    const std::string geometry = req("pixel-geometry");
    if (geometry == "unknown") o.pixelGeometry = kUnknown_SkPixelGeometry;
    else if (geometry == "rgb-h") o.pixelGeometry = kRGB_H_SkPixelGeometry;
    else if (geometry == "bgr-h") o.pixelGeometry = kBGR_H_SkPixelGeometry;
    else if (geometry == "rgb-v") o.pixelGeometry = kRGB_V_SkPixelGeometry;
    else if (geometry == "bgr-v") o.pixelGeometry = kBGR_V_SkPixelGeometry;
    else fail("unknown pixel geometry");
    const std::string edging = req("edging");
    if (edging == "alias") o.edging = SkFont::Edging::kAlias;
    else if (edging == "aa") o.edging = SkFont::Edging::kAntiAlias;
    else if (edging == "subpixel") o.edging = SkFont::Edging::kSubpixelAntiAlias;
    else fail("unknown edging");
    const std::string hinting = req("hinting");
    if (hinting == "none") o.hinting = SkFontHinting::kNone;
    else if (hinting == "slight") o.hinting = SkFontHinting::kSlight;
    else if (hinting == "normal") o.hinting = SkFontHinting::kNormal;
    else if (hinting == "full") o.hinting = SkFontHinting::kFull;
    else fail("unknown hinting");
    if (o.glyphIds.empty()) fail("empty glyph corpus");
    if ((o.kind != "scenario" && o.kind != "control")
        || (o.kind == "scenario" && !o.controlId.empty())
        || (o.kind == "control" && o.controlId.empty())) fail("invalid case identity");
    if ((o.lifecycle != "cold" && o.lifecycle != "warm") || o.ordinal < 1 || o.ordinal > 2)
        fail("invalid lifecycle/ordinal");
    if ((o.lifecycle == "cold" && o.warmups != 0) ||
        (o.lifecycle == "warm" && o.warmups < 1)) fail("invalid warmup contract");
    if (o.deviceMatrix[6] != 0 || o.deviceMatrix[7] != 0 || o.deviceMatrix[8] != 1)
        fail("perspective device matrix is forbidden");
    return o;
}

std::string tagName(SkFourByteTag tag) {
    std::string s(4, '\0');
    s[0] = static_cast<char>(tag >> 24); s[1] = static_cast<char>(tag >> 16);
    s[2] = static_cast<char>(tag >> 8); s[3] = static_cast<char>(tag);
    return s;
}
SkFourByteTag tag(const char (&s)[5]) { return SkSetFourByteTag(s[0], s[1], s[2], s[3]); }
const char* formatName(SkMask::Format f) {
    switch (f) {
        case SkMask::kBW_Format: return "BW"; case SkMask::kA8_Format: return "A8";
        case SkMask::k3D_Format: return "3D"; case SkMask::kARGB32_Format: return "ARGB32";
        case SkMask::kLCD16_Format: return "LCD16"; case SkMask::kSDF_Format: return "SDF";
    } return "unknown";
}
const char* hintName(SkFontHinting h) {
    switch (h) {
        case SkFontHinting::kNone: return "none"; case SkFontHinting::kSlight: return "slight";
        case SkFontHinting::kNormal: return "normal"; case SkFontHinting::kFull: return "full";
    } return "unknown";
}
const char* edgeName(SkFont::Edging e) {
    switch (e) {
        case SkFont::Edging::kAlias: return "alias"; case SkFont::Edging::kAntiAlias: return "aa";
        case SkFont::Edging::kSubpixelAntiAlias: return "subpixel";
    } return "unknown";
}
const char* geometryName(SkPixelGeometry g) {
    switch (g) {
        case kUnknown_SkPixelGeometry: return "unknown"; case kRGB_H_SkPixelGeometry: return "rgb-h";
        case kBGR_H_SkPixelGeometry: return "bgr-h"; case kRGB_V_SkPixelGeometry: return "rgb-v";
        case kBGR_V_SkPixelGeometry: return "bgr-v";
    } return "unknown";
}
const char* smoothName(SkCTFontSmoothBehavior b) {
    switch (b) {
        case SkCTFontSmoothBehavior::none: return "none";
        case SkCTFontSmoothBehavior::some: return "some";
        case SkCTFontSmoothBehavior::subpixel: return "subpixel";
    } return "unknown";
}
std::string matrixJson(const SkMatrix& m) {
    std::ostringstream out; out << '[';
    for (int i = 0; i < 9; ++i) { if (i) out << ','; out << num(m[i]); }
    return out.str() + "]";
}
std::string recJson(const SkScalerContextRec& r) {
    std::ostringstream out;
    out << "{\"byteLength\":" << sizeof(r) << ",\"bytesBase64\":" << q(b64(&r, sizeof(r)))
        << ",\"sha256\":" << q(sha(&r, sizeof(r))) << ",\"dump\":" << q(r.dump().c_str())
        << ",\"textSize\":" << num(r.fTextSize) << ",\"maskFormat\":" << q(formatName(r.fMaskFormat))
        << ",\"flags\":" << r.fFlags << ",\"hinting\":" << q(hintName(r.getHinting()))
        << ",\"luminanceColor\":" << r.getLuminanceColor()
        << ",\"singleMatrix\":" << matrixJson(r.getSingleMatrix()) << '}';
    return out.str();
}

struct TypefaceBundle {
    sk_sp<SkData> sourceData;
    sk_sp<SkData> decodedData;
    sk_sp<SkTypeface> typeface;
    std::vector<SkFontParameters::Variation::Axis> parameters;
    std::vector<SkFontArguments::VariationPosition::Coordinate> requested, actual;
};

TypefaceBundle makeTypeface(const Options& o) {
    TypefaceBundle b;
    b.sourceData = SkData::MakeFromFileName(o.sourceFontPath.c_str());
    b.decodedData = SkData::MakeFromFileName(o.decodedFontPath.c_str());
    if (!b.sourceData || !b.decodedData) fail("could not read source/decoded SFNS bytes");
    const std::string sourceDigest = sha(b.sourceData->data(), b.sourceData->size());
    const std::string decodedDigest = sha(b.decodedData->data(), b.decodedData->size());
    if (b.sourceData->size() != kFontByteLength || sourceDigest != kFontSha256)
        fail("source SFNS identity mismatch: " + sourceDigest);
    if (b.decodedData->size() != kDecodedFontByteLength || decodedDigest != kDecodedFontSha256)
        fail("independent OTS-decoded SFNS identity mismatch: " + decodedDigest);
    sk_sp<SkFontMgr> manager = SkFontMgr_New_CoreText(nullptr);
    if (!manager) fail("CoreText font manager unavailable");
    sk_sp<SkTypeface> base = manager->makeFromData(b.decodedData, 0);
    if (!base) fail("data-backed base typeface unavailable");
    int count = base->getVariationDesignParameters({});
    if (count <= 0) fail("variation parameters unavailable");
    b.parameters.resize(count);
    if (base->getVariationDesignParameters(
            SkSpan<SkFontParameters::Variation::Axis>(b.parameters.data(), b.parameters.size()))
        != count) fail("variation parameter count changed");
    const std::map<SkFourByteTag, float> overrides = {
        {tag("wdth"), o.wdth}, {tag("opsz"), o.opsz},
        {tag("GRAD"), o.grad}, {tag("wght"), o.wght},
    };
    for (const auto& axis : b.parameters) {
        auto it = overrides.find(axis.tag);
        b.requested.push_back({axis.tag, it == overrides.end() ? axis.def : it->second});
    }
    for (const auto& overrideEntry : overrides) {
        const SkFourByteTag required = overrideEntry.first;
        if (std::none_of(b.parameters.begin(), b.parameters.end(),
                         [&](const auto& axis) { return axis.tag == required; }))
            fail("required SFNS axis missing: " + tagName(required));
    }
    // Blink's custom-font route: the web-font factory creates the base face with
    // makeFromData (web_font_typeface_factory.cc:47-53), then
    // FontCustomPlatformData clones it with wght, wdth, slnt from font
    // selection followed by the font-variation-settings in CSS order
    // (font_custom_platform_data.cc:134-233). Skia resolves duplicate tags by
    // taking the last one, so the selection coordinates are superseded here;
    // they are kept so the clone takes the same onMakeClone path, including its
    // equal-opsz workaround (SkTypeface_mac_ct.cpp:1180-1217), which
    // MakeFromStream does not have.
    const std::vector<SkFontArguments::VariationPosition::Coordinate> blinkCoordinates = {
        {tag("wght"), o.wght}, {tag("wdth"), o.wdth}, {tag("slnt"), 0},
        {tag("wdth"), o.wdth}, {tag("opsz"), o.opsz},
        {tag("GRAD"), o.grad}, {tag("wght"), o.wght},
    };
    SkFontArguments args;
    args.setVariationDesignPosition(
        {blinkCoordinates.data(), static_cast<int>(blinkCoordinates.size())});
    b.typeface = base->makeClone(args);
    if (!b.typeface) fail("varied data-backed typeface unavailable");
    count = b.typeface->getVariationDesignPosition({});
    if (count != static_cast<int>(b.parameters.size())) fail("incomplete actual axis tuple");
    b.actual.resize(count);
    if (b.typeface->getVariationDesignPosition(
            SkSpan<SkFontArguments::VariationPosition::Coordinate>(b.actual.data(), b.actual.size()))
        != count) fail("actual axis tuple unavailable");
    return b;
}

std::string axesJson(const TypefaceBundle& b) {
    std::ostringstream out; out << '[';
    for (size_t i = 0; i < b.parameters.size(); ++i) {
        if (i) out << ',';
        const auto& axis = b.parameters[i];
        auto actual = std::find_if(b.actual.begin(), b.actual.end(),
            [&](const auto& coordinate) { return coordinate.axis == axis.tag; });
        if (actual == b.actual.end()) fail("actual axis missing");
        out << "{\"tag\":" << q(tagName(axis.tag)) << ",\"min\":" << num(axis.min)
            << ",\"default\":" << num(axis.def) << ",\"max\":" << num(axis.max)
            << ",\"hidden\":" << (axis.isHidden() ? "true" : "false")
            << ",\"requested\":" << num(b.requested[i].value)
            << ",\"actual\":" << num(actual->value) << '}';
    }
    return out.str() + "]";
}

struct ContextBundle {
    SkFont font;
    SkPaint paint;
    SkSurfaceProps props;
    SkMatrix deviceMatrix;
    SkScalerContextRec rawRec;
    SkScalerContextEffects effects;
    std::unique_ptr<SkScalerContext> context;

    ContextBundle(const Options& o, sk_sp<SkTypeface> face)
        : font(std::move(face), o.fontSize)
        , props(o.surfaceFlags, o.pixelGeometry, o.textContrast, o.textGamma) {
        font.setEdging(o.edging); font.setHinting(o.hinting);
        font.setSubpixel(true); font.setLinearMetrics(true); font.setEmbeddedBitmaps(false);
        paint.setColor(SK_ColorWHITE); paint.setStyle(SkPaint::kFill_Style);
        deviceMatrix.setAll(
            o.deviceMatrix[0], o.deviceMatrix[1], o.deviceMatrix[2],
            o.deviceMatrix[3], o.deviceMatrix[4], o.deviceMatrix[5],
            o.deviceMatrix[6], o.deviceMatrix[7], o.deviceMatrix[8]);
        SkScalerContext::MakeRecAndEffects(
            font, paint, props, static_cast<SkScalerContextFlags>(o.scalerContextFlags),
            deviceMatrix, &rawRec, &effects);
        SkAutoDescriptor descriptor;
        SkScalerContext::AutoDescriptorGivenRecAndEffects(rawRec, effects, &descriptor);
        context = font.getTypeface()->createScalerContext(effects, descriptor.getDesc());
        if (!context) fail("private scaler context unavailable");
    }
};

std::string pointJson(const SkPoint& point) {
    return "[" + num(point.x()) + "," + num(point.y()) + "]";
}

struct DerivedRun {
    std::vector<SkScalar> widths;
    std::vector<SkPoint> offsets;
    std::vector<SkPoint> sourcePositions;
};

// SkiaScalarToHarfBuzzPosition (skia_text_metrics.cc:207-211): 16.16 fixed
// point through ClampTo<int>, which truncates toward zero.
hb_position_t skiaScalarToHarfBuzzPosition(SkScalar value) {
    const double scaled = static_cast<double>(value) * (1 << 16);
    if (scaled >= static_cast<double>(std::numeric_limits<int>::max()))
        return std::numeric_limits<int>::max();
    if (scaled <= static_cast<double>(std::numeric_limits<int>::min()))
        return std::numeric_limits<int>::min();
    return static_cast<hb_position_t>(value * (1 << 16));
}

float harfBuzzPositionToFloat(hb_position_t value) {
    return static_cast<float>(value) / (1 << 16);
}

// HarfBuzzSkiaGetTable (harfbuzz_face.cc:522-545): CoreText-backed faces are
// read through table copies on Apple platforms.
hb_blob_t* skiaGetTable(hb_face_t*, hb_tag_t tableTag, void* userData) {
    auto* typeface = static_cast<SkTypeface*>(userData);
    const size_t size = typeface->getTableSize(tableTag);
    if (!size) return nullptr;
    char* buffer = static_cast<char*>(std::malloc(size));
    if (!buffer) return nullptr;
    if (typeface->getTableData(tableTag, 0, size, buffer) != size) {
        std::free(buffer);
        return nullptr;
    }
    return hb_blob_create(buffer, static_cast<unsigned>(size), HB_MEMORY_MODE_WRITABLE,
                          buffer, std::free);
}

// HarfBuzzGetGlyphHorizontalAdvance(s) -> SkFontGetGlyphWidthForHarfBuzz
// (harfbuzz_face.cc:240-268, skia_text_metrics.cc:20-73): Skia strike widths,
// rounded only without subpixel positioning, then 16.16.
hb_position_t skiaWidth(const SkFont& font, hb_codepoint_t glyph) {
    SkGlyphID id = static_cast<SkGlyphID>(glyph);
    SkScalar width = 0;
    font.getWidths({&id, 1}, {&width, 1});
    if (!font.isSubpixel()) width = SkScalarRoundToScalar(width);
    return skiaScalarToHarfBuzzPosition(width);
}

hb_position_t hbAdvance(hb_font_t*, void* fontData, hb_codepoint_t glyph, void*) {
    return skiaWidth(*static_cast<const SkFont*>(fontData), glyph);
}

void hbAdvances(hb_font_t*, void* fontData, unsigned count, const hb_codepoint_t* firstGlyph,
                unsigned glyphStride, hb_position_t* firstAdvance, unsigned advanceStride, void*) {
    const auto* font = static_cast<const SkFont*>(fontData);
    for (unsigned i = 0; i < count; ++i) {
        const auto* glyph = reinterpret_cast<const hb_codepoint_t*>(
            reinterpret_cast<const char*>(firstGlyph) + i * glyphStride);
        auto* advance = reinterpret_cast<hb_position_t*>(
            reinterpret_cast<char*>(firstAdvance) + i * advanceStride);
        *advance = skiaWidth(*font, *glyph);
    }
}

// Shape the corpus the way Blink does on macOS, then accumulate float origins.
// Face: CreateHarfBuzzFontData (harfbuzz_face.cc:570-593) -- hb_ot font funcs,
// the typeface's complete variation position, and a sub-font whose horizontal
// advances come from Skia. Scale and ptem: GetScaledFont (harfbuzz_face.cc:
// 628-650). Buffer: the run's language, script and direction
// (harfbuzz_shaper.cc:339-352) with the default font features for this
// request, which are only `chws` because text-spacing-trim is normal
// (font_features.cc:36-228, text_spacing_trim.h:23-25). The `ot` shaper is
// used because HarfRustShaping has no stable status at this revision.
DerivedRun deriveRun(const Options& o, const SkFont& font) {
    SkTypeface* typeface = font.getTypeface();
    hb_face_t* face = hb_face_create_for_tables(skiaGetTable, typeface, nullptr);
    hb_font_t* otFont = hb_font_create(face);
    hb_ot_font_set_funcs(otFont);
    const int axisCount = typeface->getVariationDesignPosition({});
    if (axisCount > 0) {
        std::vector<SkFontArguments::VariationPosition::Coordinate> axes(axisCount);
        if (typeface->getVariationDesignPosition(
                SkSpan<SkFontArguments::VariationPosition::Coordinate>(axes.data(), axes.size())) > 0) {
            std::vector<hb_variation_t> variations;
            for (const auto& axis : axes) variations.push_back({axis.axis, axis.value});
            hb_font_set_variations(otFont, variations.data(), variations.size());
        }
    }
    hb_font_t* hbFont = hb_font_create_sub_font(otFont);
    hb_font_funcs_t* funcs = hb_font_funcs_create();
    hb_font_funcs_set_glyph_h_advance_func(funcs, hbAdvance, nullptr, nullptr);
    hb_font_funcs_set_glyph_h_advances_func(funcs, hbAdvances, nullptr, nullptr);
    hb_font_funcs_make_immutable(funcs);
    hb_font_set_funcs(hbFont, funcs, const_cast<SkFont*>(&font), nullptr);
    const int scale = skiaScalarToHarfBuzzPosition(font.getSize());
    hb_font_set_scale(hbFont, scale, scale);
    // Blink passes the specified size here. ptem only selects an AAT `trak`
    // entry, and shaping this font at ptem 13 and 26 is identical.
    hb_font_set_ptem(hbFont, font.getSize());

    hb_buffer_t* buffer = hb_buffer_create();
    hb_buffer_add_utf8(buffer, o.text.data(), static_cast<int>(o.text.size()), 0,
                       static_cast<int>(o.text.size()));
    hb_buffer_set_language(buffer, hb_language_from_string("en-us", -1));
    hb_buffer_set_script(buffer, HB_SCRIPT_LATIN);
    hb_buffer_set_direction(buffer, HB_DIRECTION_LTR);
    const hb_feature_t features[] = {
        {HB_TAG('c', 'h', 'w', 's'), 1, HB_FEATURE_GLOBAL_START, HB_FEATURE_GLOBAL_END}};
    const char* const shapers[] = {"ot", nullptr};
    if (!hb_shape_full(hbFont, buffer, features, 1, shapers)) fail("HarfBuzz shaping failed");

    unsigned count = 0;
    const hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buffer, &count);
    const hb_glyph_position_t* positions = hb_buffer_get_glyph_positions(buffer, &count);
    if (count != o.glyphIds.size()) fail("shaped glyph count differs from the manifest");
    DerivedRun run;
    SkScalar penX = o.sourceStartX;
    for (unsigned i = 0; i < count; ++i) {
        if (info[i].codepoint != o.glyphIds[i]) fail("shaped glyph id differs from the manifest");
        hb_position_t xAdvance = positions[i].x_advance;
        hb_position_t xOffset = positions[i].x_offset;
        hb_position_t yOffset = positions[i].y_offset;
        if (!font.isSubpixel()) {
            // RoundHarfBuzzBufferPositions (harfbuzz_shaper.cc:353-355).
            xAdvance = SkScalarRoundToInt(harfBuzzPositionToFloat(xAdvance)) << 16;
            xOffset = SkScalarRoundToInt(harfBuzzPositionToFloat(xOffset)) << 16;
            yOffset = SkScalarRoundToInt(harfBuzzPositionToFloat(yOffset)) << 16;
        }
        const SkScalar advance = harfBuzzPositionToFloat(xAdvance);
        const SkPoint offset{harfBuzzPositionToFloat(xOffset), -harfBuzzPositionToFloat(yOffset)};
        run.widths.push_back(advance);
        run.offsets.push_back(offset);
        run.sourcePositions.push_back({penX + offset.x(), o.sourceStartY + offset.y()});
        penX += advance;
    }
    hb_buffer_destroy(buffer);
    hb_font_destroy(hbFont);
    hb_font_funcs_destroy(funcs);
    hb_font_destroy(otFont);
    hb_face_destroy(face);
    return run;
}

std::string glyphsJson(const Options& o, ContextBundle& c, const DerivedRun& run,
                       bool persist) {
    const SkGlyphPositionRoundingSpec rounding(
        c.context->isSubpixel(), c.context->computeAxisAlignmentForHText());
    std::ostringstream out; out << '[';
    for (size_t i = 0; i < o.glyphIds.size(); ++i) {
        if (i) out << ',';
        const SkPoint sourcePosition = run.sourcePositions[i];
        const SkPoint deviceOrigin = c.deviceMatrix.mapPoint(sourcePosition);
        const SkPoint mappedWithRounding = deviceOrigin + rounding.halfAxisSampleFreq;
        const SkPoint roundedDeviceOrigin{
            static_cast<SkScalar>(std::floor(mappedWithRounding.x())),
            static_cast<SkScalar>(std::floor(mappedWithRounding.y()))};
        SkPackedGlyphID packed(o.glyphIds[i], mappedWithRounding,
                               rounding.ignorePositionFieldMask);
        SkSTArenaAlloc<4096> arena;
        SkGlyph glyph = c.context->makeGlyph(packed, &arena);
        if (!glyph.setImage(&arena, c.context.get())) fail("glyph image unavailable");
        size_t size = glyph.imageSize();
        if (size && glyph.image() == nullptr) fail("nonempty glyph image missing");
        const void* bytes = size ? glyph.image() : "";
        const std::string fileName = o.observationId + "-gid-" +
            std::to_string(o.glyphIds[i]) + "-" + std::to_string(i) + ".mask";
        if (persist) {
            std::ofstream file(o.outputDirectory + "/" + fileName, std::ios::binary);
            if (!file) fail("cannot open mask output");
            if (size) file.write(static_cast<const char*>(bytes), size);
            if (!file) fail("cannot write mask output");
        }
        uint32_t id = packed.value();
        out << "{\"index\":" << i << ",\"gid\":" << o.glyphIds[i]
            << ",\"shapedAdvance\":[" << num(run.widths[i]) << ",0]"
            << ",\"shapedOffset\":" << pointJson(run.offsets[i])
            << ",\"sourcePosition\":" << pointJson(sourcePosition)
            << ",\"deviceOrigin\":" << pointJson(deviceOrigin)
            << ",\"mappedWithRounding\":" << pointJson(mappedWithRounding)
            << ",\"roundedDeviceOrigin\":" << pointJson(roundedDeviceOrigin)
            << ",\"deviceBaseline\":" << num(o.deviceBaseline)
            << ",\"strikeAdvance\":[" << num(glyph.advanceX()) << ','
            << num(glyph.advanceY()) << ']'
            << ",\"subpixelOffsetFixed\":[" << glyph.getSubXFixed() << ','
            << glyph.getSubYFixed() << ']'
            << ",\"packedId\":" << id << ",\"phase\":{\"x\":" << (id & 3)
            << ",\"y\":" << ((id >> 18) & 3) << "},\"rounding\":{\"halfAxisSampleFreq\":["
            << num(rounding.halfAxisSampleFreq.x()) << ','
            << num(rounding.halfAxisSampleFreq.y()) << "],\"ignorePositionFieldMask\":["
            << rounding.ignorePositionFieldMask.x() << ','
            << rounding.ignorePositionFieldMask.y() << "]},\"metrics\":{\"left\":" << glyph.left()
            << ",\"top\":" << glyph.top() << ",\"width\":" << glyph.width()
            << ",\"height\":" << glyph.height() << ",\"maskFormat\":"
            << q(formatName(glyph.maskFormat())) << ",\"rowBytes\":" << glyph.rowBytes()
            << ",\"imageSize\":" << size << "},\"mask\":{\"encoding\":\"base64\",\"bytes\":"
            << q(b64(bytes, size)) << ",\"sha256\":" << q(sha(bytes, size))
            << ",\"file\":" << q(fileName) << "}}";
    }
    return out.str() + "]";
}

std::string coreTextJson(const Options& o, const TypefaceBundle& face,
                         const SkVector& scale) {
    CTFontRef base = SkTypeface_GetCTFontRef(face.typeface.get());
    if (!base) fail("CoreText font unavailable from decoded typeface");
    const auto* macTypeface = static_cast<const SkTypeface_Mac*>(face.typeface.get());
    SkUniqueCFRef<CTFontRef> font = SkCTFontCreateExactCopy(
        base, scale.y(), macTypeface->fOpszVariation);
    if (!font) fail("could not create exact-sized CoreText font");
    CGRect bounds = CTFontGetBoundingBox(font.get());
    const double ascent = CTFontGetAscent(font.get());
    const double descent = CTFontGetDescent(font.get());
    const double leading = CTFontGetLeading(font.get());
    const double capHeight = CTFontGetCapHeight(font.get());
    const double xHeight = CTFontGetXHeight(font.get());
    std::ostringstream out;
    out << "{\"raw\":{\"pointSize\":" << num(CTFontGetSize(font.get()))
        << ",\"unitsPerEm\":" << CTFontGetUnitsPerEm(font.get())
        << ",\"ascent\":" << num(ascent)
        << ",\"descent\":" << num(descent)
        << ",\"leading\":" << num(leading)
        << ",\"capHeight\":" << num(capHeight)
        << ",\"xHeight\":" << num(xHeight)
        << ",\"boundingBox\":[" << num(bounds.origin.x) << ','
        << num(bounds.origin.y) << ',' << num(bounds.size.width) << ','
        << num(bounds.size.height) << "]},\"normalized\":{"
        << "\"coordinateSystem\":\"device-y-down\",\"baseline\":"
        << num(o.deviceBaseline) << ",\"ascent\":" << num(-ascent)
        << ",\"descent\":" << num(descent)
        << ",\"leading\":" << num(leading)
        << ",\"capHeight\":" << num(-capHeight)
        << ",\"xHeight\":" << num(-xHeight)
        << ",\"top\":" << num(o.deviceBaseline - ascent)
        << ",\"bottom\":" << num(o.deviceBaseline + descent)
        << ",\"boundingBox\":[" << num(bounds.origin.x) << ','
        << num(-(bounds.origin.y + bounds.size.height)) << ','
        << num(bounds.size.width) << ',' << num(bounds.size.height) << "]}}";
    return out.str();
}

struct GammaInputs {
    SkScalar contrast = 0, deviceGamma = 0;
};

GammaInputs filteredGammaInputs(const SkScalerContextRec& rec) {
    const std::string dump(rec.dump().c_str());
    const std::string marker = "device gamma ";
    const size_t at = dump.find(marker);
    int gamma = -1, contrast = -1;
    if (at == std::string::npos ||
        std::sscanf(dump.c_str() + at, "device gamma %d, contrast %d", &gamma, &contrast) != 2 ||
        gamma < 0 || gamma > 255 || contrast < 0 || contrast > 255)
        fail("filtered record gamma inputs unavailable");
    return {SkIntToScalar(contrast) / ((1 << 8) - 1), SkIntToScalar(gamma) / (1 << 6)};
}

std::string collect(const Options& o) {
    TypefaceBundle face = makeTypeface(o);
    std::optional<ContextBundle> context;
    context.emplace(o, face.typeface);
    const DerivedRun run = deriveRun(o, context->font);
    for (int i = 0; i < o.warmups; ++i) (void)glyphsJson(o, *context, run, false);
    if (!context) fail("scaler context unavailable");
    const SkScalerContextRec& filtered = context->context->getRec();
    SkVector scale;
    SkMatrix remaining, remainingWithoutRotation, remainingRotation, total;
    bool invertible = filtered.computeMatrices(
        SkScalerContextRec::PreMatrixScale::kVertical, &scale, &remaining,
        &remainingWithoutRotation, &remainingRotation, &total);

    // The pre-blend is built from the FILTERED record's private device gamma and
    // contrast, which onFilterRec may replace (ignorePreBlend). They are not
    // publicly readable, so take the integers the record itself prints and
    // convert them with SkScalerContextRec's External*FromInternal rules
    // (g / 64, c / 255), the same values Chromium's hook records.
    const GammaInputs gammaInputs = filteredGammaInputs(filtered);
    const SkMaskGamma& gamma = filtered.cachedMaskGamma();
    int gammaWidth = 0, gammaHeight = 0;
    gamma.getGammaTableDimensions(&gammaWidth, &gammaHeight);
    const uint8_t* gammaBytes = gamma.getGammaTables();
    size_t gammaSize = gamma.getGammaTableSizeInBytes();
    auto preblend = SkScalerContext::GetMaskPreBlend(filtered);
    auto digest256 = [](const uint8_t* value) {
        return sha(value ? static_cast<const void*>(value) : static_cast<const void*>(""),
                   value ? 256 : 0);
    };
    auto base64256 = [](const uint8_t* value) {
        return b64(value ? static_cast<const void*>(value) : static_cast<const void*>(""),
                   value ? 256 : 0);
    };

    SkString family, postscript;
    face.typeface->getFamilyName(&family);
    bool hasPostscript = face.typeface->getPostScriptName(&postscript);
    SkFontMetrics metrics;
    context->context->getFontMetrics(&metrics);
    SkFontStyle style = face.typeface->fontStyle();

    std::ostringstream out;
    const SkPoint requestedDeviceStart = context->deviceMatrix.mapPoint(
        {o.sourceStartX, o.sourceStartY});
    out << "{\"schemaVersion\":2,\"collectorAbi\":" << q(kCollectorAbi)
        << ",\"observationId\":" << q(o.observationId)
        << ",\"caseId\":" << q(o.caseId) << ",\"kind\":" << q(o.kind)
        << ",\"scenarioId\":" << q(o.scenario)
        << ",\"controlId\":" << q(o.controlId)
        << ",\"lifecycle\":" << q(o.lifecycle) << ",\"ordinal\":" << o.ordinal
        << ",\"warmupCount\":" << o.warmups << ",\"source\":{\"chromiumRevision\":"
        << q(kChromiumRevision) << ",\"skiaRevision\":" << q(kSkiaRevision)
        << ",\"original\":{\"fontPath\":" << q(o.sourceFontPath)
        << ",\"byteLength\":" << face.sourceData->size()
        << ",\"sha256\":" << q(kFontSha256)
        << "},\"decoded\":{\"authority\":\"chromium-exact-ots\",\"fontPath\":"
        << q(o.decodedFontPath) << ",\"byteLength\":" << face.decodedData->size()
        << ",\"sha256\":" << q(kDecodedFontSha256)
        << ",\"collectionIndex\":0}},\"buildRuntime\":{\"clangVersion\":"
        << q(__clang_version__)
#if defined(__aarch64__) || defined(__arm64__)
        << ",\"architecture\":\"arm64\"}"
#elif defined(__x86_64__)
        << ",\"architecture\":\"x64\"}"
#else
        << ",\"architecture\":\"unknown\"}"
#endif
        << ",\"request\":{\"fontSize\":" << num(o.fontSize)
        << ",\"axes\":{\"wdth\":" << num(o.wdth) << ",\"opsz\":" << num(o.opsz)
        << ",\"GRAD\":" << num(o.grad) << ",\"wght\":" << num(o.wght)
        << "},\"font\":{\"scaleX\":1,\"skewX\":0,\"subpixel\":true,"
        << "\"linearMetrics\":true,\"embeddedBitmaps\":false,\"edging\":"
        << q(edgeName(o.edging)) << ",\"hinting\":" << q(hintName(o.hinting))
        << "},\"paint\":{\"color\":4294967295,\"style\":\"fill\"},"
        << "\"surface\":{\"flags\":" << o.surfaceFlags
        << ",\"pixelGeometry\":" << q(geometryName(o.pixelGeometry))
        << ",\"textContrast\":" << num(o.textContrast)
        << ",\"textGamma\":" << num(o.textGamma)
        << "},\"scalerContextFlags\":" << o.scalerContextFlags
        << ",\"run\":{\"sourceStart\":[" << num(o.sourceStartX) << ','
        << num(o.sourceStartY) << "],\"deviceStart\":" << pointJson(requestedDeviceStart)
        << ",\"deviceBaseline\":" << num(o.deviceBaseline)
        << ",\"liveDeviceMatrix\":" << matrixJson(context->deviceMatrix)
        << "}},\"typeface\":{\"uniqueId\":"
        << face.typeface->uniqueID() << ",\"family\":" << q(family.c_str()) << ",\"postscriptName\":"
        << q(hasPostscript ? postscript.c_str() : "") << ",\"style\":{\"weight\":" << style.weight()
        << ",\"width\":" << style.width() << ",\"slant\":" << static_cast<int>(style.slant())
        << "},\"axes\":" << axesJson(face)
        << ",\"fontBytes\":{\"authority\":\"ots-sanitized-sfnt\",\"byteLength\":"
        << face.decodedData->size() << ",\"collectionIndex\":0,\"sha256\":"
        << q(kDecodedFontSha256) << "}},\"font\":{\"size\":" << num(context->font.getSize())
        << ",\"scaleX\":" << num(context->font.getScaleX()) << ",\"skewX\":"
        << num(context->font.getSkewX()) << ",\"subpixel\":"
        << (context->font.isSubpixel() ? "true" : "false") << ",\"linearMetrics\":"
        << (context->font.isLinearMetrics() ? "true" : "false") << ",\"embeddedBitmaps\":"
        << (context->font.isEmbeddedBitmaps() ? "true" : "false") << ",\"edging\":"
        << q(edgeName(context->font.getEdging())) << ",\"hinting\":"
        << q(hintName(context->font.getHinting())) << "},\"paint\":{\"color\":"
        << context->paint.getColor() << ",\"style\":" << static_cast<int>(context->paint.getStyle())
        << "},\"surfaceProps\":{\"flags\":" << context->props.flags() << ",\"pixelGeometry\":"
        << q(geometryName(context->props.pixelGeometry())) << ",\"textContrast\":"
        << num(context->props.textContrast()) << ",\"textGamma\":"
        << num(context->props.textGamma()) << "},\"scalerContextFlags\":"
        << o.scalerContextFlags << ",\"rawRec\":" << recJson(context->rawRec)
        << ",\"filteredRec\":" << recJson(filtered) << ",\"matrices\":{\"device\":"
        << matrixJson(context->deviceMatrix) << ",\"total\":" << matrixJson(total)
        << ",\"scale\":[" << num(scale.x()) << ',' << num(scale.y()) << "],\"remaining\":"
        << matrixJson(remaining) << ",\"remainingWithoutRotation\":"
        << matrixJson(remainingWithoutRotation) << ",\"remainingRotation\":"
        << matrixJson(remainingRotation) << ",\"invertible\":"
        << (invertible ? "true" : "false") << "},\"smoothBehavior\":"
        << q(smoothName(SkCTFontGetSmoothBehavior()))
        << ",\"gamma\":{\"inputContrast\":" << num(gammaInputs.contrast)
        << ",\"inputDeviceGamma\":" << num(gammaInputs.deviceGamma) << ",\"tableApplicable\":"
        << (gammaBytes ? "true" : "false") << ",\"tableWidth\":" << gammaWidth
        << ",\"tableHeight\":" << gammaHeight << ",\"tableByteLength\":"
        << (gammaBytes ? gammaSize : 0) << ",\"tableSha256\":"
        << q(sha(gammaBytes ? static_cast<const void*>(gammaBytes) : static_cast<const void*>(""),
                 gammaBytes ? gammaSize : 0))
        << ",\"tableBytesBase64\":"
        << q(b64(gammaBytes ? static_cast<const void*>(gammaBytes) : static_cast<const void*>(""),
                 gammaBytes ? gammaSize : 0))
        << ",\"preblendApplicable\":" << (preblend.isApplicable() ? "true" : "false")
        << ",\"preblendByteLength\":" << (preblend.isApplicable() ? 256 : 0)
        << ",\"preblendR256Sha256\":" << q(digest256(preblend.fR))
        << ",\"preblendG256Sha256\":" << q(digest256(preblend.fG))
        << ",\"preblendB256Sha256\":" << q(digest256(preblend.fB))
        << ",\"preblendR256Base64\":" << q(base64256(preblend.fR))
        << ",\"preblendG256Base64\":" << q(base64256(preblend.fG))
        << ",\"preblendB256Base64\":" << q(base64256(preblend.fB))
        << "},\"coreTextMetrics\":" << coreTextJson(o, face, scale)
        << ",\"fontMetrics\":{\"top\":" << num(metrics.fTop)
        << ",\"ascent\":" << num(metrics.fAscent) << ",\"descent\":" << num(metrics.fDescent)
        << ",\"bottom\":" << num(metrics.fBottom) << ",\"leading\":" << num(metrics.fLeading)
        << ",\"avgCharWidth\":" << num(metrics.fAvgCharWidth) << ",\"maxCharWidth\":"
        << num(metrics.fMaxCharWidth) << ",\"xMin\":" << num(metrics.fXMin)
        << ",\"xMax\":" << num(metrics.fXMax) << ",\"xHeight\":" << num(metrics.fXHeight)
        << ",\"capHeight\":" << num(metrics.fCapHeight) << "},\"glyphs\":"
        << glyphsJson(o, *context, run, true) << '}';
    return out.str();
}
}  // namespace

int main(int argc, char** argv) {
    std::cout << collect(parseOptions(argc, argv)) << '\n';
    return 0;
}
