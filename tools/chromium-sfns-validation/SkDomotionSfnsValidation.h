// Test-only exact SFNS scaler/mask evidence hook for Chromium 7d859f271c /
// Skia 62efacd377. This file is compiled only when a private validation hook
// define is present in the owning Blink or Skia target.
#ifndef SkDomotionSfnsValidation_DEFINED
#define SkDomotionSfnsValidation_DEFINED

#if defined(SK_DOMOTION_SFNS_VALIDATION_HOOK) || \
    defined(BLINK_DOMOTION_SFNS_VALIDATION_HOOK)

#include "include/core/SkFont.h"
#include "include/core/SkFontArguments.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkFontParameters.h"
#include "include/core/SkFontTypes.h"
#include "include/core/SkMatrix.h"
#include "include/core/SkPaint.h"
#include "include/core/SkSpan.h"
#include "include/core/SkStream.h"
#include "include/core/SkString.h"
#include "include/core/SkSurfaceProps.h"
#include "include/core/SkTypeface.h"
#include "src/core/SkGlyph.h"
#include "src/core/SkMaskGamma.h"
#include "src/core/SkScalerContext.h"
#include "src/utils/mac/SkCTFont.h"

#include <CommonCrypto/CommonDigest.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreText/CoreText.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace sk_domotion_sfns_validation {

inline constexpr char kHookAbi[] = "domotion-sfns-pinned-chromium-hook-v2";
inline constexpr char kChromiumRevision[] = "7d859f271cbda744098ac69f44978d4edfa62be3";
inline constexpr char kSkiaRevision[] = "62efacd37737505732dbe3d8daa62abd679626a1";
inline constexpr char kSourceFontSha256[] =
    "2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66";
inline constexpr size_t kSourceFontByteLength = 7909644;
inline constexpr char kDecodedFontSha256[] =
    "48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4";
inline constexpr size_t kDecodedFontByteLength = 7806016;
inline constexpr std::array<SkGlyphID, 6> kGlyphIds = {969, 815, 815, 795, 1310, 1377};

struct HookContext {
    std::string outputDirectory;
    std::string observationId;
    std::string scenarioId;
    std::string lifecycle;
    std::string controlId;
    int ordinal;
};

struct FontIdentity {
    size_t byteLength;
    int collectionIndex;
    std::string sha256;
};

struct ShapeGlyphEvidence {
    SkGlyphID glyphId;
    uint32_t characterIndex;
    SkPoint shapedAdvance;
    SkPoint shapedOffset;
    SkPoint accumulatedAdvance;
    bool horizontal;
};

inline bool safeToken(std::string_view value) {
    if (value.empty() || value.size() > 128) return false;
    for (unsigned char c : value) {
        if (!(std::isalnum(c) || c == '-' || c == '_' || c == '.')) return false;
    }
    return true;
}

inline std::optional<HookContext> context() {
    const char* abi = std::getenv("DOMOTION_SFNS_HOOK_ABI");
    const char* directory = std::getenv("DOMOTION_SFNS_OUTPUT_DIR");
    const char* observation = std::getenv("DOMOTION_SFNS_OBSERVATION_ID");
    const char* scenario = std::getenv("DOMOTION_SFNS_SCENARIO_ID");
    const char* lifecycle = std::getenv("DOMOTION_SFNS_LIFECYCLE");
    const char* ordinalText = std::getenv("DOMOTION_SFNS_ORDINAL");
    const char* control = std::getenv("DOMOTION_SFNS_CONTROL_ID");
    const char* sourceSha = std::getenv("DOMOTION_SFNS_SOURCE_SHA256");
    const char* sourceLength = std::getenv("DOMOTION_SFNS_SOURCE_BYTE_LENGTH");
    if (!abi || std::string_view(abi) != kHookAbi || !directory || !*directory ||
        !observation || !scenario || !lifecycle || !ordinalText || !sourceSha ||
        std::string_view(sourceSha) != kSourceFontSha256 || !sourceLength ||
        std::string_view(sourceLength) != std::to_string(kSourceFontByteLength)) {
        return std::nullopt;
    }
    if (!safeToken(observation) || !safeToken(scenario) || !safeToken(lifecycle) ||
        (control && *control && !safeToken(control))) return std::nullopt;
    char* end = nullptr;
    errno = 0;
    long ordinal = std::strtol(ordinalText, &end, 10);
    if (errno || end == ordinalText || *end || ordinal < 1 || ordinal > 2) return std::nullopt;
    if (std::string_view(lifecycle) != "cold" && std::string_view(lifecycle) != "warm" &&
        std::string_view(lifecycle) != "control") return std::nullopt;
    return HookContext{directory, observation, scenario, lifecycle,
                       control ? control : "", static_cast<int>(ordinal)};
}

inline std::string escape(std::string_view value) {
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

inline std::string quote(std::string_view value) { return "\"" + escape(value) + "\""; }

inline std::string number(double value) {
    if (!std::isfinite(value)) return "null";
    std::ostringstream out;
    out << std::setprecision(17) << value;
    return out.str();
}

inline std::string sha256(const void* bytes, size_t size) {
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
    CC_SHA256(bytes, static_cast<CC_LONG>(size), digest.data());
    std::ostringstream out;
    for (unsigned char byte : digest) {
        out << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
    }
    return out.str();
}

inline std::string base64(const void* raw, size_t size) {
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto* bytes = static_cast<const uint8_t*>(raw);
    std::string out;
    out.reserve(((size + 2) / 3) * 4);
    for (size_t i = 0; i < size; i += 3) {
        uint32_t value = static_cast<uint32_t>(bytes[i]) << 16;
        if (i + 1 < size) value |= static_cast<uint32_t>(bytes[i + 1]) << 8;
        if (i + 2 < size) value |= bytes[i + 2];
        out += alphabet[(value >> 18) & 63];
        out += alphabet[(value >> 12) & 63];
        out += i + 1 < size ? alphabet[(value >> 6) & 63] : '=';
        out += i + 2 < size ? alphabet[value & 63] : '=';
    }
    return out;
}

inline std::optional<FontIdentity> authenticateTypeface(SkTypeface& typeface) {
    static std::mutex mutex;
    static std::map<SkTypefaceID, std::optional<FontIdentity>> cache;
    std::lock_guard<std::mutex> lock(mutex);
    auto found = cache.find(typeface.uniqueID());
    if (found != cache.end()) return found->second;
    int collectionIndex = -1;
    std::unique_ptr<SkStreamAsset> stream = typeface.openStream(&collectionIndex);
    if (!stream || stream->getLength() != kDecodedFontByteLength) {
        cache[typeface.uniqueID()] = std::nullopt;
        return std::nullopt;
    }
    std::vector<uint8_t> bytes(kDecodedFontByteLength);
    if (stream->read(bytes.data(), bytes.size()) != bytes.size()) {
        cache[typeface.uniqueID()] = std::nullopt;
        return std::nullopt;
    }
    FontIdentity identity{bytes.size(), collectionIndex, sha256(bytes.data(), bytes.size())};
    if (identity.sha256 != kDecodedFontSha256) {
        cache[typeface.uniqueID()] = std::nullopt;
        return std::nullopt;
    }
    cache[typeface.uniqueID()] = identity;
    return identity;
}

inline const char* maskFormatName(SkMask::Format format) {
    switch (format) {
        case SkMask::kBW_Format: return "BW";
        case SkMask::kA8_Format: return "A8";
        case SkMask::k3D_Format: return "3D";
        case SkMask::kARGB32_Format: return "ARGB32";
        case SkMask::kLCD16_Format: return "LCD16";
        case SkMask::kSDF_Format: return "SDF";
    }
    return "unknown";
}

inline const char* hintingName(SkFontHinting hinting) {
    switch (hinting) {
        case SkFontHinting::kNone: return "none";
        case SkFontHinting::kSlight: return "slight";
        case SkFontHinting::kNormal: return "normal";
        case SkFontHinting::kFull: return "full";
    }
    return "unknown";
}

inline const char* edgingName(SkFont::Edging edging) {
    switch (edging) {
        case SkFont::Edging::kAlias: return "alias";
        case SkFont::Edging::kAntiAlias: return "aa";
        case SkFont::Edging::kSubpixelAntiAlias: return "subpixel";
    }
    return "unknown";
}

inline const char* pixelGeometryName(SkPixelGeometry geometry) {
    switch (geometry) {
        case kUnknown_SkPixelGeometry: return "unknown";
        case kRGB_H_SkPixelGeometry: return "rgb-h";
        case kBGR_H_SkPixelGeometry: return "bgr-h";
        case kRGB_V_SkPixelGeometry: return "rgb-v";
        case kBGR_V_SkPixelGeometry: return "bgr-v";
    }
    return "unknown";
}

inline const char* smoothBehaviorName(SkCTFontSmoothBehavior behavior) {
    switch (behavior) {
        case SkCTFontSmoothBehavior::none: return "none";
        case SkCTFontSmoothBehavior::some: return "some";
        case SkCTFontSmoothBehavior::subpixel: return "subpixel";
    }
    return "unknown";
}

inline std::string matrixJson(const SkMatrix& matrix) {
    std::ostringstream out;
    out << '[';
    for (int i = 0; i < 9; ++i) {
        if (i) out << ',';
        out << number(matrix[i]);
    }
    return out.str() + ']';
}

inline std::string affineJson(const CGAffineTransform& transform) {
    std::ostringstream out;
    out << '[' << number(transform.a) << ',' << number(transform.b) << ','
        << number(transform.c) << ',' << number(transform.d) << ','
        << number(transform.tx) << ',' << number(transform.ty) << ']';
    return out.str();
}

inline std::string matricesJson(const SkScalerContextRec& rec) {
    SkVector scale;
    SkMatrix remaining, remainingWithoutRotation, remainingRotation, total;
    bool invertible = rec.computeMatrices(SkScalerContextRec::PreMatrixScale::kVertical,
                                          &scale, &remaining, &remainingWithoutRotation,
                                          &remainingRotation, &total);
    std::ostringstream out;
    out << "{\"total\":" << matrixJson(total)
        << ",\"scale\":[" << number(scale.x()) << ',' << number(scale.y()) << ']'
        << ",\"remaining\":" << matrixJson(remaining)
        << ",\"remainingWithoutRotation\":" << matrixJson(remainingWithoutRotation)
        << ",\"remainingRotation\":" << matrixJson(remainingRotation)
        << ",\"invertible\":" << (invertible ? "true" : "false") << '}';
    return out.str();
}

inline std::string recJson(const SkScalerContextRec& rec) {
    std::ostringstream out;
    out << "{\"byteLength\":" << sizeof(rec)
        << ",\"bytesBase64\":" << quote(base64(&rec, sizeof(rec)))
        << ",\"sha256\":" << quote(sha256(&rec, sizeof(rec)))
        << ",\"dump\":" << quote(rec.dump().c_str())
        << ",\"textSize\":" << number(rec.fTextSize)
        << ",\"maskFormat\":" << quote(maskFormatName(rec.fMaskFormat))
        << ",\"flags\":" << rec.fFlags
        << ",\"hinting\":" << quote(hintingName(rec.getHinting()))
        << ",\"luminanceColor\":" << rec.getLuminanceColor()
        << ",\"singleMatrix\":" << matrixJson(rec.getSingleMatrix()) << '}';
    return out.str();
}

inline std::string tagName(SkFourByteTag tag) {
    std::string value(4, '\0');
    value[0] = static_cast<char>(tag >> 24);
    value[1] = static_cast<char>(tag >> 16);
    value[2] = static_cast<char>(tag >> 8);
    value[3] = static_cast<char>(tag);
    return value;
}

inline std::string typefaceJson(SkTypeface& typeface, const FontIdentity& identity) {
    SkString family, postscript;
    typeface.getFamilyName(&family);
    bool hasPostscript = typeface.getPostScriptName(&postscript);
    SkFontStyle style = typeface.fontStyle();
    int parameterCount = typeface.getVariationDesignParameters({});
    std::vector<SkFontParameters::Variation::Axis> parameters(
        parameterCount > 0 ? static_cast<size_t>(parameterCount) : 0);
    if (parameterCount > 0) {
        typeface.getVariationDesignParameters(SkSpan<SkFontParameters::Variation::Axis>(
            parameters.data(), parameters.size()));
    }
    int coordinateCount = typeface.getVariationDesignPosition({});
    std::vector<SkFontArguments::VariationPosition::Coordinate> coordinates(
        coordinateCount > 0 ? static_cast<size_t>(coordinateCount) : 0);
    if (coordinateCount > 0) {
        typeface.getVariationDesignPosition(
            SkSpan<SkFontArguments::VariationPosition::Coordinate>(coordinates.data(),
                                                                    coordinates.size()));
    }
    std::ostringstream out;
    out << "{\"uniqueId\":" << typeface.uniqueID()
        << ",\"family\":" << quote(family.c_str())
        << ",\"postscriptName\":" << quote(hasPostscript ? postscript.c_str() : "")
        << ",\"style\":{\"weight\":" << style.weight()
        << ",\"width\":" << style.width()
        << ",\"slant\":" << static_cast<int>(style.slant()) << "},\"axes\":[";
    for (size_t i = 0; i < parameters.size(); ++i) {
        if (i) out << ',';
        const auto& axis = parameters[i];
        auto found = std::find_if(coordinates.begin(), coordinates.end(),
            [&](const auto& coordinate) { return coordinate.axis == axis.tag; });
        out << "{\"tag\":" << quote(tagName(axis.tag))
            << ",\"min\":" << number(axis.min)
            << ",\"default\":" << number(axis.def)
            << ",\"max\":" << number(axis.max)
            << ",\"hidden\":" << (axis.isHidden() ? "true" : "false")
            << ",\"actual\":"
            << (found == coordinates.end() ? "null" : number(found->value)) << '}';
    }
    out << "],\"fontBytes\":{\"authority\":\"ots-sanitized-sfnt\",\"byteLength\":"
        << identity.byteLength
        << ",\"collectionIndex\":" << identity.collectionIndex
        << ",\"sha256\":" << quote(identity.sha256) << "}}";
    return out.str();
}

inline std::string envelope(const HookContext& hook, uint64_t sequence,
                            std::string_view event,
                            SkTypeface& typeface, const FontIdentity& identity,
                            std::string_view payload) {
    std::ostringstream out;
    out << "{\"schemaVersion\":2,\"hookAbi\":" << quote(kHookAbi)
        << ",\"sequence\":" << sequence
        << ",\"event\":" << quote(event)
        << ",\"observationId\":" << quote(hook.observationId)
        << ",\"scenarioId\":" << quote(hook.scenarioId)
        << ",\"lifecycle\":" << quote(hook.lifecycle)
        << ",\"controlId\":" << quote(hook.controlId)
        << ",\"ordinal\":" << hook.ordinal
        << ",\"processId\":" << static_cast<long>(getpid())
        << ",\"source\":{\"chromiumRevision\":" << quote(kChromiumRevision)
        << ",\"skiaRevision\":" << quote(kSkiaRevision)
        << ",\"sourceFontByteLength\":" << kSourceFontByteLength
        << ",\"sourceFontSha256\":" << quote(kSourceFontSha256)
        << ",\"decodedFontByteLength\":" << kDecodedFontByteLength
        << ",\"decodedFontSha256\":" << quote(kDecodedFontSha256) << "}"
        << ",\"typeface\":" << typefaceJson(typeface, identity)
        << ",\"payload\":" << payload << '}';
    return out.str();
}

inline void writeEvent(const HookContext& hook, std::string_view event,
                       SkTypeface& typeface, const FontIdentity& identity,
                       std::string_view payload) {
    static std::atomic<uint64_t> sequence{0};
    uint64_t current = sequence.fetch_add(1, std::memory_order_relaxed);
    std::string stem = hook.outputDirectory + '/' + hook.observationId + '-' +
        std::to_string(static_cast<long>(getpid())) + '-' + std::string(event) + '-' +
        std::to_string(current);
    std::string temporary = stem + ".json.tmp";
    std::string final = stem + ".json";
    std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
    if (!output) return;
    std::string body = envelope(hook, current, event, typeface, identity, payload);
    output.write(body.data(), static_cast<std::streamsize>(body.size()));
    output.close();
    if (!output) {
        std::remove(temporary.c_str());
        return;
    }
    if (std::rename(temporary.c_str(), final.c_str()) != 0) std::remove(temporary.c_str());
}

inline void WriteShape(SkTypeface& typeface,
                       const std::vector<ShapeGlyphEvidence>& glyphs) {
    auto hook = context();
    if (!hook || glyphs.size() != kGlyphIds.size()) return;
    for (size_t i = 0; i < glyphs.size(); ++i) {
        if (glyphs[i].glyphId != kGlyphIds[i]) return;
    }
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    std::ostringstream payload;
    payload << "{\"coordinateSystem\":\"skia-source-space-y-down\",\"glyphs\":[";
    for (size_t i = 0; i < glyphs.size(); ++i) {
        if (i) payload << ',';
        const auto& glyph = glyphs[i];
        payload << "{\"index\":" << i << ",\"gid\":" << glyph.glyphId
            << ",\"characterIndex\":" << glyph.characterIndex
            << ",\"shapedAdvance\":[" << number(glyph.shapedAdvance.x()) << ','
            << number(glyph.shapedAdvance.y()) << "]"
            << ",\"shapedOffset\":[" << number(glyph.shapedOffset.x()) << ','
            << number(glyph.shapedOffset.y()) << "]"
            << ",\"accumulatedAdvance\":[" << number(glyph.accumulatedAdvance.x())
            << ',' << number(glyph.accumulatedAdvance.y()) << "]"
            << ",\"horizontal\":" << (glyph.horizontal ? "true" : "false") << '}';
    }
    payload << "]}";
    writeEvent(*hook, "shape", typeface, *identity, payload.str());
}

inline void WriteRaw(SkTypeface& typeface, const SkFont& font, const SkPaint& paint,
                     const SkSurfaceProps& props, SkScalerContextFlags flags,
                     const SkMatrix& deviceMatrix, const SkScalerContextRec& rec) {
    auto hook = context();
    if (!hook) return;
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    std::ostringstream payload;
    payload << "{\"font\":{\"size\":" << number(font.getSize())
        << ",\"scaleX\":" << number(font.getScaleX())
        << ",\"skewX\":" << number(font.getSkewX())
        << ",\"subpixel\":" << (font.isSubpixel() ? "true" : "false")
        << ",\"linearMetrics\":" << (font.isLinearMetrics() ? "true" : "false")
        << ",\"embeddedBitmaps\":" << (font.isEmbeddedBitmaps() ? "true" : "false")
        << ",\"edging\":" << quote(edgingName(font.getEdging()))
        << ",\"hinting\":" << quote(hintingName(font.getHinting())) << "}"
        << ",\"paint\":{\"color\":" << paint.getColor()
        << ",\"style\":" << static_cast<int>(paint.getStyle()) << "}"
        << ",\"surfaceProps\":{\"flags\":" << static_cast<uint32_t>(props.flags())
        << ",\"pixelGeometry\":" << quote(pixelGeometryName(props.pixelGeometry()))
        << ",\"textContrast\":" << number(props.textContrast())
        << ",\"textGamma\":" << number(props.textGamma()) << "}"
        << ",\"scalerContextFlags\":" << static_cast<uint32_t>(flags)
        << ",\"deviceMatrix\":" << matrixJson(deviceMatrix)
        << ",\"rawRec\":" << recJson(rec)
        << ",\"matrices\":" << matricesJson(rec) << '}';
    writeEvent(*hook, "raw", typeface, *identity, payload.str());
}

inline void WriteFiltered(SkTypeface& typeface, const SkScalerContextRec& before,
                          const SkScalerContextRec& after,
                          SkCTFontSmoothBehavior smoothBehavior) {
    auto hook = context();
    if (!hook) return;
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    std::ostringstream payload;
    payload << "{\"before\":" << recJson(before)
        << ",\"after\":" << recJson(after)
        << ",\"matrices\":" << matricesJson(after)
        << ",\"smoothBehavior\":" << quote(smoothBehaviorName(smoothBehavior)) << '}';
    writeEvent(*hook, "filtered", typeface, *identity, payload.str());
}

template <typename Source>
inline void WriteRun(SkTypeface& typeface, const SkFont& font,
                     const SkSurfaceProps& props, SkScalerContextFlags flags,
                     const SkMatrix& positionMatrix,
                     const SkGlyphPositionRoundingSpec& rounding, Source source) {
    auto hook = context();
    if (!hook) return;
    std::vector<std::pair<SkGlyphID, SkPoint>> glyphs;
    for (auto [glyphId, position] : source) glyphs.emplace_back(glyphId, position);
    if (glyphs.size() != kGlyphIds.size()) return;
    for (size_t i = 0; i < glyphs.size(); ++i) {
        if (glyphs[i].first != kGlyphIds[i]) return;
    }
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    SkMatrix roundedMatrix = positionMatrix;
    roundedMatrix.postTranslate(rounding.halfAxisSampleFreq.x(),
                                rounding.halfAxisSampleFreq.y());
    std::ostringstream payload;
    payload << "{\"font\":{\"size\":" << number(font.getSize())
        << ",\"edging\":" << quote(edgingName(font.getEdging()))
        << ",\"hinting\":" << quote(hintingName(font.getHinting())) << "}"
        << ",\"surfaceProps\":{\"flags\":" << static_cast<uint32_t>(props.flags())
        << ",\"pixelGeometry\":" << quote(pixelGeometryName(props.pixelGeometry()))
        << ",\"textContrast\":" << number(props.textContrast())
        << ",\"textGamma\":" << number(props.textGamma()) << "}"
        << ",\"scalerContextFlags\":" << static_cast<uint32_t>(flags)
        << ",\"positionMatrix\":" << matrixJson(positionMatrix)
        << ",\"rounding\":{\"halfAxisSampleFreq\":["
        << number(rounding.halfAxisSampleFreq.x()) << ','
        << number(rounding.halfAxisSampleFreq.y()) << "],\"ignorePositionFieldMask\":["
        << rounding.ignorePositionFieldMask.x() << ','
        << rounding.ignorePositionFieldMask.y() << "]},\"glyphs\":[";
    for (size_t i = 0; i < glyphs.size(); ++i) {
        if (i) payload << ',';
        SkPoint sourcePosition = glyphs[i].second;
        SkPoint devicePosition = positionMatrix.mapPoint(sourcePosition);
        SkPoint mappedWithRounding = roundedMatrix.mapPoint(sourcePosition);
        SkPackedGlyphID packed(glyphs[i].first, mappedWithRounding,
                               rounding.ignorePositionFieldMask);
        payload << "{\"index\":" << i << ",\"gid\":" << glyphs[i].first
            << ",\"sourcePosition\":[" << number(sourcePosition.x()) << ','
            << number(sourcePosition.y()) << "],\"deviceOrigin\":["
            << number(devicePosition.x()) << ',' << number(devicePosition.y())
            << "],\"mappedWithRounding\":[" << number(mappedWithRounding.x()) << ','
            << number(mappedWithRounding.y()) << "],\"roundedDeviceOrigin\":["
            << number(std::floor(mappedWithRounding.x())) << ','
            << number(std::floor(mappedWithRounding.y())) << "],\"packedId\":"
            << packed.value() << ",\"phase\":{\"x\":" << (packed.value() & 3)
            << ",\"y\":" << ((packed.value() >> 18) & 3) << "}}";
    }
    payload << "]}";
    writeEvent(*hook, "run", typeface, *identity, payload.str());
}

inline std::string digest256(const uint8_t* bytes) {
    return sha256(bytes ? static_cast<const void*>(bytes) : static_cast<const void*>(""),
                  bytes ? 256 : 0);
}

inline void WriteGamma(SkTypeface& typeface, const SkScalerContextRec& rec,
                       const SkMaskGamma& gamma,
                       const SkMaskGamma::PreBlend& preblend,
                       SkScalar inputContrast, SkScalar inputDeviceGamma) {
    auto hook = context();
    if (!hook) return;
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    int tableWidth = 0;
    int tableHeight = 0;
    gamma.getGammaTableDimensions(&tableWidth, &tableHeight);
    const uint8_t* table = gamma.getGammaTables();
    const size_t tableByteLength = gamma.getGammaTableSizeInBytes();
    const size_t retainedTableLength = table ? tableByteLength : 0;
    const size_t preblendByteLength = preblend.isApplicable() ? 256 : 0;
    auto preblendBase64 = [&](const uint8_t* bytes) {
        return base64(bytes ? static_cast<const void*>(bytes) : static_cast<const void*>(""),
                      bytes ? preblendByteLength : 0);
    };
    std::ostringstream payload;
    payload << "{\"filteredRec\":" << recJson(rec)
        << ",\"inputContrast\":" << number(inputContrast)
        << ",\"inputDeviceGamma\":" << number(inputDeviceGamma)
        << ",\"tableApplicable\":" << (table ? "true" : "false")
        << ",\"tableWidth\":" << tableWidth
        << ",\"tableHeight\":" << tableHeight
        << ",\"tableByteLength\":" << retainedTableLength
        << ",\"tableSha256\":"
        << quote(sha256(table ? static_cast<const void*>(table) : static_cast<const void*>(""),
                        retainedTableLength))
        << ",\"tableBytesBase64\":"
        << quote(base64(table ? static_cast<const void*>(table) : static_cast<const void*>(""),
                        retainedTableLength))
        << ",\"preblendApplicable\":"
        << (preblend.isApplicable() ? "true" : "false")
        << ",\"preblendByteLength\":" << preblendByteLength
        << ",\"preblendR256Sha256\":" << quote(digest256(preblend.fR))
        << ",\"preblendG256Sha256\":" << quote(digest256(preblend.fG))
        << ",\"preblendB256Sha256\":" << quote(digest256(preblend.fB))
        << ",\"preblendR256Base64\":" << quote(preblendBase64(preblend.fR))
        << ",\"preblendG256Base64\":" << quote(preblendBase64(preblend.fG))
        << ",\"preblendB256Base64\":" << quote(preblendBase64(preblend.fB)) << '}';
    writeEvent(*hook, "gamma", typeface, *identity, payload.str());
}

inline void WriteMask(SkTypeface& typeface, const SkScalerContextRec& rec,
                      const SkGlyph& glyph, const void* imageBuffer,
                      const CGAffineTransform& transform,
                      const CGAffineTransform& inverseTransform,
                      CTFontRef fontRef, bool requestSmooth,
                      const SkMaskGamma::PreBlend& preblend) {
    auto hook = context();
    if (!hook) return;
    if (std::find(kGlyphIds.begin(), kGlyphIds.end(), glyph.getGlyphID()) == kGlyphIds.end()) return;
    auto identity = authenticateTypeface(typeface);
    if (!identity) return;
    const size_t imageSize = glyph.imageSize();
    const void* bytes = imageSize ? imageBuffer : static_cast<const void*>("");
    CGRect boundingBox = CTFontGetBoundingBox(fontRef);
    std::ostringstream payload;
    payload << "{\"filteredRec\":" << recJson(rec)
        << ",\"matrices\":" << matricesJson(rec)
        << ",\"coreText\":{\"pointSize\":" << number(CTFontGetSize(fontRef))
        << ",\"unitsPerEm\":" << CTFontGetUnitsPerEm(fontRef)
        << ",\"ascent\":" << number(CTFontGetAscent(fontRef))
        << ",\"descent\":" << number(CTFontGetDescent(fontRef))
        << ",\"leading\":" << number(CTFontGetLeading(fontRef))
        << ",\"capHeight\":" << number(CTFontGetCapHeight(fontRef))
        << ",\"xHeight\":" << number(CTFontGetXHeight(fontRef))
        << ",\"boundingBox\":[" << number(boundingBox.origin.x) << ','
        << number(boundingBox.origin.y) << ',' << number(boundingBox.size.width) << ','
        << number(boundingBox.size.height) << "]}"
        << ",\"transform\":" << affineJson(transform)
        << ",\"inverseTransform\":" << affineJson(inverseTransform)
        << ",\"requestSmooth\":" << (requestSmooth ? "true" : "false")
        << ",\"smoothBehavior\":"
        << quote(smoothBehaviorName(SkCTFontGetSmoothBehavior()))
        << ",\"gamma\":{\"recordDump\":" << quote(rec.dump().c_str())
        << ",\"preblendApplicable\":" << (preblend.isApplicable() ? "true" : "false")
        << ",\"preblendR256Sha256\":" << quote(digest256(preblend.fR))
        << ",\"preblendG256Sha256\":" << quote(digest256(preblend.fG))
        << ",\"preblendB256Sha256\":" << quote(digest256(preblend.fB)) << "}"
        << ",\"glyph\":{\"gid\":" << glyph.getGlyphID()
        << ",\"advance\":[" << number(glyph.advanceX()) << ',' << number(glyph.advanceY())
        << "],\"subpixelOffsetFixed\":[" << glyph.getSubXFixed() << ','
        << glyph.getSubYFixed() << "],\"packedId\":" << glyph.getPackedID().value()
        << ",\"phase\":{\"x\":" << (glyph.getPackedID().value() & 3)
        << ",\"y\":" << ((glyph.getPackedID().value() >> 18) & 3)
        << "},\"metrics\":{\"left\":" << glyph.left() << ",\"top\":" << glyph.top()
        << ",\"width\":" << glyph.width() << ",\"height\":" << glyph.height()
        << ",\"maskFormat\":" << quote(maskFormatName(glyph.maskFormat()))
        << ",\"rowBytes\":" << glyph.rowBytes() << ",\"imageSize\":" << imageSize
        << "},\"mask\":{\"encoding\":\"base64\",\"bytes\":"
        << quote(base64(bytes, imageSize)) << ",\"sha256\":"
        << quote(sha256(bytes, imageSize)) << "}}}";
    writeEvent(*hook, "mask", typeface, *identity, payload.str());
}

}  // namespace sk_domotion_sfns_validation

#endif  // private Blink/Skia SFNS validation hook
#endif  // SkDomotionSfnsValidation_DEFINED
