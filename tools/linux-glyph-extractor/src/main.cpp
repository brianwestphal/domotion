// Domotion Linux native glyph-outline extractor (FreeType).
//
// Reads a single JSON request envelope from stdin (default) or `--input <path>`,
// extracts per-glyph SVG outlines and/or font metadata via FreeType, and writes
// the JSON response to stdout. The envelope is identical to the macOS CoreText
// helper (tools/macos-glyph-extractor) and the Windows DirectWrite helper — see
// docs/16-coretext-glyph-extraction.md (shared contract) and
// docs/45-linux-glyph-extraction.md (Linux specifics).
//
// A persistent `--serve` mode (DM-1034) mirrors the macOS CoreText helper's:
// read one request envelope per line on stdin, write one response per line on
// stdout, loop until EOF, reusing opened FT_Faces across requests via a cache.
// The fixed per-spawn cost (process spawn + FreeType init + face open) is what
// the persistent process amortizes — so the renderer's `glyph-helper.ts` does
// one round-trip per call over a single long-lived child instead of a fresh
// `spawnSync` each time. The one-shot CLI mode below is the transparent
// fallback (an older binary that predates `--serve` dies on the unknown flag,
// the wrapper notices, and reverts to one-shot).
//
// Coordinate convention: outlines are emitted in FreeType's native y-UP, in
// font design units, via FT_LOAD_NO_SCALE — exactly what fontkit's
// `glyph.path.commands` returns, so the helper is a drop-in backend for the
// renderer's `scale(fontSize/unitsPerEm, ...)` transform. Do NOT negate y here:
// the renderer flips to SVG y-down at draw time, and negating would double-flip
// and fail the fontkit `H` parity test. (docs/45 originally said "negate y";
// that was wrong — corrected to match the macOS helper + fontkit.)

#include <fontconfig/fontconfig.h>

#include <strings.h>  // strcasecmp (familyMatch acceptance check)
#include <unistd.h>   // access() (familyMatch readability check)

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include FT_MULTIPLE_MASTERS_H
#include FT_TRUETYPE_TABLES_H
#include FT_SFNT_NAMES_H

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

// ───────────────────────────── JSON value ──────────────────────────────────

struct JsonValue;
using JsonArray = std::vector<JsonValue>;
using JsonObject = std::map<std::string, JsonValue>;

struct JsonValue {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::shared_ptr<JsonArray> array;
  std::shared_ptr<JsonObject> object;

  bool isObject() const { return type == Type::Object; }
  bool isArray() const { return type == Type::Array; }
  bool isString() const { return type == Type::String; }
  bool isNumber() const { return type == Type::Number; }

  // Object member access; returns a Null sentinel when absent.
  const JsonValue& at(const std::string& key) const {
    static const JsonValue null;
    if (type != Type::Object || !object) return null;
    auto it = object->find(key);
    return it == object->end() ? null : it->second;
  }
  bool has(const std::string& key) const {
    return type == Type::Object && object && object->count(key) > 0;
  }
  const JsonArray& asArray() const {
    static const JsonArray empty;
    return (type == Type::Array && array) ? *array : empty;
  }
  std::string asString(const std::string& def = "") const {
    return type == Type::String ? string : def;
  }
  double asNumber(double def = 0) const { return type == Type::Number ? number : def; }
};

// ───────────────────────────── JSON parser ─────────────────────────────────

class JsonParser {
 public:
  explicit JsonParser(const std::string& src) : s_(src) {}

  bool parse(JsonValue& out) {
    skipWs();
    if (!parseValue(out)) return false;
    skipWs();
    return true;  // trailing content tolerated
  }

 private:
  const std::string& s_;
  size_t i_ = 0;

  void skipWs() {
    while (i_ < s_.size()) {
      char c = s_[i_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i_++;
      else break;
    }
  }

  bool parseValue(JsonValue& out) {
    skipWs();
    if (i_ >= s_.size()) return false;
    char c = s_[i_];
    switch (c) {
      case '{': return parseObject(out);
      case '[': return parseArray(out);
      case '"': {
        out.type = JsonValue::Type::String;
        return parseString(out.string);
      }
      case 't': case 'f': return parseBool(out);
      case 'n': return parseNull(out);
      default: return parseNumber(out);
    }
  }

  bool parseObject(JsonValue& out) {
    out.type = JsonValue::Type::Object;
    out.object = std::make_shared<JsonObject>();
    i_++;  // '{'
    skipWs();
    if (i_ < s_.size() && s_[i_] == '}') { i_++; return true; }
    while (i_ < s_.size()) {
      skipWs();
      if (i_ >= s_.size() || s_[i_] != '"') return false;
      std::string key;
      if (!parseString(key)) return false;
      skipWs();
      if (i_ >= s_.size() || s_[i_] != ':') return false;
      i_++;
      JsonValue v;
      if (!parseValue(v)) return false;
      (*out.object)[key] = std::move(v);
      skipWs();
      if (i_ >= s_.size()) return false;
      if (s_[i_] == ',') { i_++; continue; }
      if (s_[i_] == '}') { i_++; return true; }
      return false;
    }
    return false;
  }

  bool parseArray(JsonValue& out) {
    out.type = JsonValue::Type::Array;
    out.array = std::make_shared<JsonArray>();
    i_++;  // '['
    skipWs();
    if (i_ < s_.size() && s_[i_] == ']') { i_++; return true; }
    while (i_ < s_.size()) {
      JsonValue v;
      if (!parseValue(v)) return false;
      out.array->push_back(std::move(v));
      skipWs();
      if (i_ >= s_.size()) return false;
      if (s_[i_] == ',') { i_++; continue; }
      if (s_[i_] == ']') { i_++; return true; }
      return false;
    }
    return false;
  }

  static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp <= 0x7F) {
      out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  bool parseHex4(uint32_t& out) {
    if (i_ + 4 > s_.size()) return false;
    out = 0;
    for (int k = 0; k < 4; k++) {
      char c = s_[i_++];
      out <<= 4;
      if (c >= '0' && c <= '9') out |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f') out |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') out |= static_cast<uint32_t>(c - 'A' + 10);
      else return false;
    }
    return true;
  }

  bool parseString(std::string& out) {
    out.clear();
    i_++;  // opening quote
    while (i_ < s_.size()) {
      char c = s_[i_++];
      if (c == '"') return true;
      if (c == '\\') {
        if (i_ >= s_.size()) return false;
        char e = s_[i_++];
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            uint32_t cp;
            if (!parseHex4(cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate
              if (i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                i_ += 2;
                uint32_t lo;
                if (!parseHex4(lo)) return false;
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              }
            }
            appendUtf8(out, cp);
            break;
          }
          default: return false;
        }
      } else {
        out.push_back(c);
      }
    }
    return false;
  }

  bool parseNumber(JsonValue& out) {
    size_t start = i_;
    if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) i_++;
    bool any = false;
    while (i_ < s_.size()) {
      char c = s_[i_];
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        i_++;
        any = true;
      } else {
        break;
      }
    }
    if (!any) return false;
    out.type = JsonValue::Type::Number;
    out.number = std::strtod(s_.c_str() + start, nullptr);
    return true;
  }

  bool parseBool(JsonValue& out) {
    if (s_.compare(i_, 4, "true") == 0) { i_ += 4; out.type = JsonValue::Type::Bool; out.boolean = true; return true; }
    if (s_.compare(i_, 5, "false") == 0) { i_ += 5; out.type = JsonValue::Type::Bool; out.boolean = false; return true; }
    return false;
  }

  bool parseNull(JsonValue& out) {
    if (s_.compare(i_, 4, "null") == 0) { i_ += 4; out.type = JsonValue::Type::Null; return true; }
    return false;
  }
};

// ──────────────────────────── output helpers ───────────────────────────────

// Round to 3 decimals, drop trailing zeros — matches the macOS/Windows helpers
// so dedup keys are identical across platforms. (With FT_LOAD_NO_SCALE all
// outline coords are integers, so this almost always prints integers.)
static std::string formatNumber(double value) {
  if (value == 0) return "0";
  double rounded = std::round(value * 1000.0) / 1000.0;
  if (rounded == std::floor(rounded)) {
    return std::to_string(static_cast<long long>(rounded));
  }
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.3f", rounded);
  std::string s(buf);
  while (!s.empty() && s.back() == '0') s.pop_back();
  if (!s.empty() && s.back() == '.') s.pop_back();
  return s;
}

static std::string jsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 2);
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  return out;
}

[[noreturn]] static void die(const std::string& message) {
  std::cerr << "{\"error\":\"" << jsonEscape(message) << "\"}\n";
  std::exit(1);
}

// ───────────────────────── outline decomposition ───────────────────────────

// FreeType signals contour starts via move_to but emits no close callback, and
// it traces the explicit closing edge back to the contour's start as the final
// segment. SVG `Z` already closes a subpath with a straight line back to the
// start, so a trailing `L <start>` before `Z` is redundant. fontkit and the
// CoreText helper both omit it (leaving the close implicit), so we do too — it
// keeps the emitted path identical to fontkit's `glyph.path.commands` (verified
// by the `H` parity test) and the output marginally smaller. We buffer each
// contour's segments, drop a trailing line-to-start, then emit `M … Z`.
struct Segment {
  char type;        // 'L', 'Q', or 'C'
  double endX, endY;  // the segment's on-curve endpoint
  std::string text;
};
struct ContourSink {
  std::string out;
  bool hasMove = false;
  double moveX = 0, moveY = 0;
  std::string moveText;
  std::vector<Segment> segments;

  void push(Segment seg) { segments.push_back(std::move(seg)); }

  void flushContour() {
    if (!hasMove) return;
    if (!segments.empty() && segments.back().type == 'L' &&
        segments.back().endX == moveX && segments.back().endY == moveY) {
      segments.pop_back();  // drop redundant closing line; Z handles it
    }
    if (!out.empty()) out.push_back(' ');
    out += moveText;
    for (const Segment& s : segments) { out.push_back(' '); out += s.text; }
    out += " Z";
    segments.clear();
    hasMove = false;
  }

  void startContour(double x, double y) {
    flushContour();
    moveX = x;
    moveY = y;
    moveText = "M " + formatNumber(x) + " " + formatNumber(y);
    hasMove = true;
  }
};

static int moveTo(const FT_Vector* to, void* user) {
  static_cast<ContourSink*>(user)->startContour(to->x, to->y);
  return 0;
}
static int lineTo(const FT_Vector* to, void* user) {
  static_cast<ContourSink*>(user)->push(
      {'L', static_cast<double>(to->x), static_cast<double>(to->y),
       "L " + formatNumber(to->x) + " " + formatNumber(to->y)});
  return 0;
}
static int conicTo(const FT_Vector* ctrl, const FT_Vector* to, void* user) {
  static_cast<ContourSink*>(user)->push(
      {'Q', static_cast<double>(to->x), static_cast<double>(to->y),
       "Q " + formatNumber(ctrl->x) + " " + formatNumber(ctrl->y) + " " +
           formatNumber(to->x) + " " + formatNumber(to->y)});
  return 0;
}
static int cubicTo(const FT_Vector* c1, const FT_Vector* c2, const FT_Vector* to, void* user) {
  static_cast<ContourSink*>(user)->push(
      {'C', static_cast<double>(to->x), static_cast<double>(to->y),
       "C " + formatNumber(c1->x) + " " + formatNumber(c1->y) + " " +
           formatNumber(c2->x) + " " + formatNumber(c2->y) + " " +
           formatNumber(to->x) + " " + formatNumber(to->y)});
  return 0;
}

static std::string decomposeOutline(FT_Outline* outline) {
  ContourSink sink;
  FT_Outline_Funcs funcs;
  funcs.move_to = moveTo;
  funcs.line_to = lineTo;
  funcs.conic_to = conicTo;
  funcs.cubic_to = cubicTo;
  funcs.shift = 0;
  funcs.delta = 0;
  if (FT_Outline_Decompose(outline, &funcs, &sink) != 0) return "";
  sink.flushContour();
  return sink.out;
}

// ──────────────────────────── font handling ────────────────────────────────

struct FontEntry {
  FT_Face face = nullptr;
  int unitsPerEm = 0;
};

static FT_ULong fourCharTag(const std::string& s) {
  if (s.size() != 4) return 0;
  return (static_cast<FT_ULong>(static_cast<unsigned char>(s[0])) << 24) |
         (static_cast<FT_ULong>(static_cast<unsigned char>(s[1])) << 16) |
         (static_cast<FT_ULong>(static_cast<unsigned char>(s[2])) << 8) |
         static_cast<FT_ULong>(static_cast<unsigned char>(s[3]));
}

// Resolve the face index inside a (possibly .ttc) file by PostScript name.
static FT_Long resolveFaceIndex(FT_Library lib, const std::string& path,
                                const std::string& postscriptName) {
  if (postscriptName.empty()) return 0;
  FT_Face probe = nullptr;
  if (FT_New_Face(lib, path.c_str(), 0, &probe) != 0) return 0;
  FT_Long numFaces = probe->num_faces;
  FT_Done_Face(probe);
  for (FT_Long fi = 0; fi < numFaces; fi++) {
    FT_Face f = nullptr;
    if (FT_New_Face(lib, path.c_str(), fi, &f) != 0) continue;
    const char* psn = FT_Get_Postscript_Name(f);
    bool match = psn != nullptr && postscriptName == psn;
    FT_Done_Face(f);
    if (match) return fi;
  }
  return 0;
}

// ─────────────────── per-codepoint system fallback (fontconfig) ─────────────
//
// DM-1886. Transcribes what Chrome does on Linux, which is NOT what
// `fc-match ":charset=<hex>"` does.
//
// Blink: `linux/font_cache_linux.cc:89-97` → `gfx::GetFallbackFontForChar(c,
// locale, …)`. That implementation is `ui/gfx/font_fallback_linux.cc:424-535`,
// readable in the local checkout at rev 7d859f27 like any Blink file — an
// earlier note here said it had to be fetched because the checkout carries only
// `third_party/blink/renderer/**`, which was wrong: `sparse-checkout add
// ui/gfx` brings it in. It does:
//
//     FcPatternAddString(pattern, FC_LANG, locale)   // deleted if locale empty
//     FcPatternAddBool(pattern, FC_SCALABLE, FcTrue)
//     FcConfigSubstitute(config, pattern, FcMatchPattern)
//     FcDefaultSubstitute(pattern)
//     FcFontSort(config, pattern, /*trim=*/FcFalse, nullptr, &result)
//     → walk the sorted set; take the FIRST font whose charset covers the char
//     → read back FC_FILE and FC_INDEX
//
// **The character never enters the pattern.** The locale does. That is the
// substantive difference from `fc-match :charset=`, which is `FcFontMatch` with
// the codepoint as a charset CONSTRAINT: fontconfig then scores coverage as one
// weighted criterion among many and returns a single best match — which is why
// that path can return a font that does not cover the character at all, and why
// the Node side needs a `fontFileCoversCodepoint` guard behind it. Here coverage
// is a FILTER applied while walking a locale-sorted list, exactly as in Chrome,
// so no such guard is required: a miss reports found:false.
//
// The sorted set depends only on the locale, not on the codepoint, so it is
// built once per language and reused for every codepoint in the batch. That is
// what makes this fast as well as faithful — the old path spawned `fc-match`
// once per codepoint (~12.1 ms each, ~99% of a Linux conformance shard).
//
// `isBold` / `isItalic` are returned because Blink reads them back and MUTATES
// the FontDescription with them (`font_cache_linux.cc:106-129`): a bold face
// raises a sub-bold request, and a non-bold face under a bold request turns on
// SYNTHETIC bold. The Node side cannot make that decision without them.
//   in : { type:"fcfallback", cps:[...], lang?:"en" }
//   out: { type:"fcfallback", fonts:[ {cp,found:true,path,index,isBold,isItalic,family}
//                                   | {cp,found:false} ] }
//
// Forward declaration: `fcIsValidPattern` (rev fd139e79's `isValidPattern`
// port) is defined below alongside `runFamilyMatchQuery`, but `runFcFallbackQuery`
// needs it too — Blink's fallback walk applies the SAME per-candidate filter
// (`IsValidFontFromPattern`, `ui/gfx/font_fallback_linux.cc:38-56`) that
// `SkFontConfigInterfaceDirect::isValidPattern` applies for family matching.
static bool fcIsValidPattern(FcPattern* p);

static FcFontSet* sortedSetForLang(const std::string& lang) {
  // Keyed by language: FcFontSort's answer is a function of the pattern, and the
  // only things we put in the pattern are FC_LANG and FC_SCALABLE.
  static std::map<std::string, FcFontSet*> cache;
  auto it = cache.find(lang);
  if (it != cache.end()) return it->second;

  FcConfig* config = FcConfigGetCurrent();
  FcPattern* pattern = FcPatternCreate();
  if (pattern == nullptr) return nullptr;
  FcPatternAddString(pattern, FC_LANG,
                     reinterpret_cast<const FcChar8*>(lang.c_str()));
  // DM-2017: this was documented above (`font_fallback_linux.cc:463`) but never
  // actually added to the pattern — the comment described Blink's algorithm
  // correctly while the code silently omitted the FC_SCALABLE term.
  FcPatternAddBool(pattern, FC_SCALABLE, FcTrue);
  FcConfigSubstitute(config, pattern, FcMatchPattern);
  FcDefaultSubstitute(pattern);

  FcResult result;
  // trim=FcFalse, which is what Blink passes (`font_fallback_linux.cc:473`).
  // This line previously read `FcTrue` and claimed that matched Chrome; it does
  // not. The ANSWER is the same either way — trimming elides a face only when
  // its coverage is already contained in the union of the faces before it, so
  // any elided face that covers the codepoint is preceded by one that also
  // does, and the FIRST covering face is unchanged — but the call should be the
  // call Blink makes rather than one argued to be equivalent.
  FcFontSet* fonts = FcFontSort(config, pattern, FcFalse, nullptr, &result);
  FcPatternDestroy(pattern);
  cache[lang] = fonts;  // may be null; cached either way so we retry once only
  return fonts;
}

static std::string runFcFallbackQuery(const JsonValue& query) {
  std::string lang = query.at("lang").asString();
  if (lang.empty()) lang = "en";

  std::ostringstream out;
  out << "{\"type\":\"fcfallback\",\"fonts\":[";

  FcFontSet* fonts = sortedSetForLang(lang);
  const JsonArray& cps = query.at("cps").asArray();
  for (size_t i = 0; i < cps.size(); i++) {
    if (i > 0) out << ",";
    const FcChar32 cp = static_cast<FcChar32>(cps[i].asNumber());
    bool emitted = false;

    if (fonts != nullptr) {
      for (int f = 0; f < fonts->nfont && !emitted; f++) {
        FcPattern* font = fonts->fonts[f];
        // DM-2017: `IsValidFontFromPattern` (`font_fallback_linux.cc:38-56`) runs
        // BEFORE the charset test in `FillFallbackList` (`:492-505`) — scalable,
        // TrueType-or-CFF, and readable — so a bitmap / unreadable / wrong-format
        // face never even reaches the coverage question, exactly like a face
        // Chrome's own fallback list never included in the first place. `fcIsValidPattern`
        // already ports this (built for the family-match query below); reuse it
        // rather than checking only FC_FILE readability here as before.
        if (!fcIsValidPattern(font)) continue;
        FcCharSet* charset = nullptr;
        if (FcPatternGetCharSet(font, FC_CHARSET, 0, &charset) != FcResultMatch
            || charset == nullptr || !FcCharSetHasChar(charset, cp)) {
          continue;
        }
        FcChar8* file = nullptr;
        if (FcPatternGetString(font, FC_FILE, 0, &file) != FcResultMatch || file == nullptr) {
          continue;
        }
        int index = 0;
        FcPatternGetInteger(font, FC_INDEX, 0, &index);
        int weight = FC_WEIGHT_REGULAR;
        FcPatternGetInteger(font, FC_WEIGHT, 0, &weight);
        int slant = FC_SLANT_ROMAN;
        FcPatternGetInteger(font, FC_SLANT, 0, &slant);
        FcChar8* family = nullptr;
        FcPatternGetString(font, FC_FAMILY, 0, &family);

        out << "{\"cp\":" << static_cast<long>(cp) << ",\"found\":true"
            << ",\"path\":\"" << jsonEscape(reinterpret_cast<const char*>(file)) << "\""
            << ",\"index\":" << index
            << ",\"isBold\":" << (weight >= FC_WEIGHT_BOLD ? "true" : "false")
            << ",\"isItalic\":" << (slant != FC_SLANT_ROMAN ? "true" : "false");
        if (family != nullptr) {
          out << ",\"family\":\"" << jsonEscape(reinterpret_cast<const char*>(family)) << "\"";
        }
        out << "}";
        emitted = true;
      }
    }
    // No covering font in the whole sorted set — the honest answer, and the one
    // Chrome gives (GetFontForCharacter returns false → nullptr → the caller
    // keeps its last resort). NOT a reason to fall back to a non-covering pick.
    if (!emitted) out << "{\"cp\":" << static_cast<long>(cp) << ",\"found\":false}";
  }

  out << "]}";
  return out.str();
}

// ──────────────── declared-family style match (fontconfig) ─────────────────
//
// Which CUT of a declared CSS family Chrome-on-Linux opens at a given
// weight / width / slant. This is a transcription of the code the Chrome build
// Playwright pins (tag 147.0.7727.15) actually runs for that decision:
//
//   Blink `FontCache::CreateTypeface` → `skia::DefaultFontMgr()->
//   matchFamilyStyle(name, font_description.SkiaFontStyle())`
//     (`third_party/blink/renderer/platform/fonts/skia/font_cache_skia.cc`,
//      tag 147.0.7727.15; identical at local checkout rev 7d859f27:262-295)
//   → on Linux that font manager is `SkFontMgr_New_FCI(SkFontConfigInterface::
//     RefGlobal(), …)` (`skia/ext/font_utils.cc:86-89`, tag 147.0.7727.15)
//   → `SkFontMgr_FCI::onMatchFamilyStyle` → `fFCI->matchFamilyName(...)`
//     (Skia `src/ports/SkFontMgr_FontConfigInterface.cpp`, rev fd139e79 —
//      the revision tag 147's DEPS pins)
//   → `SkFontConfigInterfaceDirect::matchFamilyName`
//     (Skia `src/ports/SkFontConfigInterface_direct.cpp:592-713`, rev fd139e79).
//
// The pinned revision matters: the CURRENT Skia tree rewrote `MatchFont` to
// keep scanning the sorted set until it finds an *acceptable* pattern and added
// a direct `FcFontMatch` fast path. The shipping build has neither — it takes
// the FIRST valid pattern from one `FcFontSort(trim=0)` and then accepts or
// rejects THAT pattern, full stop. Transcribing the newer tree would diverge
// from every capture Playwright runs.
//
// `SK_FONT_CONFIG_INTERFACE_ONLY_ALLOW_SFNT_FONTS` is defined in Chrome's
// build (`skia/config/SkUserConfig.h:151-152`, tag 147.0.7727.15), so the
// validity check requires FC_FONTFORMAT TrueType/CFF, exactly as below.
//
// The CSS style → SkFontStyle conversion is Blink's `FontDescription::
// SkiaFontStyle` (`platform/fonts/font_description.cc`, identical at tag and
// at rev 7d859f27): weight passes through when in [1,1000]
// (`kMinWeightValue`/`kMaxWeightValue`, `font_selection_types.h:184-186`),
// width buckets at the CSS stretch keywords' percentages
// (`font_selection_types.h:221-245`), italic maps to the italic slant.
//
//   in : { type:"familyMatch", family, cssWeight?:400, italic?:false,
//          cssWidth?:100 (CSS font-stretch percent) }
//   out: { type:"familyMatch", found:true, path, index, family,
//          postscriptName, weight, width, italic }
//        | { type:"familyMatch", found:false }

// Skia `map_ranges` (SkFontConfigInterface_direct.cpp:359-390, rev fd139e79):
// piecewise-linear interpolation between anchor pairs, clamped at both ends.
struct FcMapRange { double old_val; double new_val; };
static double fcMapRanges(double val, const FcMapRange ranges[], int count) {
  if (val < ranges[0].old_val) return ranges[0].new_val;
  for (int i = 0; i < count - 1; i++) {
    if (val < ranges[i + 1].old_val) {
      return ranges[i].new_val + ((val - ranges[i].old_val)
                                  * (ranges[i + 1].new_val - ranges[i].new_val)
                                  / (ranges[i + 1].old_val - ranges[i].old_val));
    }
  }
  return ranges[count - 1].new_val;
}

#ifndef FC_WEIGHT_DEMILIGHT
#define FC_WEIGHT_DEMILIGHT 65
#endif
// Available since FontConfig 2.15 (same guard as Skia's).
#ifndef FC_FONT_WRAPPER
#define FC_FONT_WRAPPER "fontwrapper"
#endif

// Skia `fcpattern_from_skfontstyle` weight anchors (SkFontStyle CSS-space →
// fontconfig space), rev fd139e79:446-483. SkFontStyle named weights are the
// CSS values (Thin 100 … ExtraBlack 1000).
static const FcMapRange kSkToFcWeight[] = {
  { 100, FC_WEIGHT_THIN },     { 200, FC_WEIGHT_EXTRALIGHT },
  { 300, FC_WEIGHT_LIGHT },    { 350, FC_WEIGHT_DEMILIGHT },
  { 380, FC_WEIGHT_BOOK },     { 400, FC_WEIGHT_REGULAR },
  { 500, FC_WEIGHT_MEDIUM },   { 600, FC_WEIGHT_DEMIBOLD },
  { 700, FC_WEIGHT_BOLD },     { 800, FC_WEIGHT_EXTRABOLD },
  { 900, FC_WEIGHT_BLACK },    { 1000, FC_WEIGHT_EXTRABLACK },
};
static const FcMapRange kFcToSkWeight[] = {
  { FC_WEIGHT_THIN, 100 },     { FC_WEIGHT_EXTRALIGHT, 200 },
  { FC_WEIGHT_LIGHT, 300 },    { FC_WEIGHT_DEMILIGHT, 350 },
  { FC_WEIGHT_BOOK, 380 },     { FC_WEIGHT_REGULAR, 400 },
  { FC_WEIGHT_MEDIUM, 500 },   { FC_WEIGHT_DEMIBOLD, 600 },
  { FC_WEIGHT_BOLD, 700 },     { FC_WEIGHT_EXTRABOLD, 800 },
  { FC_WEIGHT_BLACK, 900 },    { FC_WEIGHT_EXTRABLACK, 1000 },
};
// Width anchors (SkFontStyle width class 1..9 ↔ fontconfig), rev fd139e79.
static const FcMapRange kSkToFcWidth[] = {
  { 1, FC_WIDTH_ULTRACONDENSED }, { 2, FC_WIDTH_EXTRACONDENSED },
  { 3, FC_WIDTH_CONDENSED },      { 4, FC_WIDTH_SEMICONDENSED },
  { 5, FC_WIDTH_NORMAL },         { 6, FC_WIDTH_SEMIEXPANDED },
  { 7, FC_WIDTH_EXPANDED },       { 8, FC_WIDTH_EXTRAEXPANDED },
  { 9, FC_WIDTH_ULTRAEXPANDED },
};
static const FcMapRange kFcToSkWidth[] = {
  { FC_WIDTH_ULTRACONDENSED, 1 }, { FC_WIDTH_EXTRACONDENSED, 2 },
  { FC_WIDTH_CONDENSED, 3 },      { FC_WIDTH_SEMICONDENSED, 4 },
  { FC_WIDTH_NORMAL, 5 },         { FC_WIDTH_SEMIEXPANDED, 6 },
  { FC_WIDTH_EXPANDED, 7 },       { FC_WIDTH_EXTRAEXPANDED, 8 },
  { FC_WIDTH_ULTRAEXPANDED, 9 },
};

// Blink `FontDescription::SkiaFontStyle` width bucketing: CSS `font-stretch`
// percent → SkFontStyle width class. Thresholds are the CSS keyword
// percentages (`font_selection_types.h:221-245`, values 50 / 62.5 / 75 / 87.5
// / 112.5 / 125 / 150 / 200); note Blink's ladder of non-else `if`s means the
// most specific bound wins, reproduced here in the same order.
static int skWidthClassFromCssStretchPercent(double stretch) {
  int w = 5;                       // SkFontStyle::kNormal_Width
  if (stretch <= 50) w = 1;
  if (stretch <= 62.5) w = 2;      // (later assignments override earlier ones,
  if (stretch <= 75) w = 3;        //  exactly as in SkiaFontStyle)
  if (stretch <= 87.5) w = 4;
  if (stretch >= 112.5) w = 6;
  if (stretch >= 125) w = 7;
  if (stretch >= 150) w = 8;
  if (stretch >= 200) w = 9;
  return w;
}

// Skia's metric-compatibility equivalence classes (`GetFontEquivClass` /
// `IsMetricCompatibleReplacement`, SkFontConfigInterface_direct.cpp, rev
// fd139e79). A match whose family is a metric-compatible replacement of the
// requested one is acceptable — this is how "Arial" accepts Liberation Sans.
// Class ids are arbitrary; equality (and != 0) is what matters.
struct FcFontEquiv { int clazz; const char* name; };
static const FcFontEquiv kFontEquivMap[] = {
  { 1, "Arial" }, { 1, "Arimo" }, { 1, "Liberation Sans" },
  { 2, "Times New Roman" }, { 2, "Tinos" }, { 2, "Liberation Serif" },
  { 3, "Courier New" }, { 3, "Cousine" }, { 3, "Liberation Mono" },
  { 4, "Symbol" }, { 4, "Symbol Neu" },
  // MS PGothic (ASCII + fullwidth spellings, as in the source)
  { 5, "MS PGothic" },
  { 5, "\xef\xbc\xad\xef\xbc\xb3 \xef\xbc\xb0\xe3\x82\xb4\xe3\x82\xb7\xe3\x83\x83\xe3\x82\xaf" },
  { 5, "Noto Sans CJK JP" }, { 5, "IPAPGothic" }, { 5, "MotoyaG04Gothic" },
  // MS Gothic
  { 6, "MS Gothic" },
  { 6, "\xef\xbc\xad\xef\xbc\xb3 \xe3\x82\xb4\xe3\x82\xb7\xe3\x83\x83\xe3\x82\xaf" },
  { 6, "Noto Sans Mono CJK JP" }, { 6, "IPAGothic" }, { 6, "MotoyaG04GothicMono" },
  // MS PMincho
  { 7, "MS PMincho" },
  { 7, "\xef\xbc\xad\xef\xbc\xb3 \xef\xbc\xb0\xe6\x98\x8e\xe6\x9c\x9d" },
  { 7, "Noto Serif CJK JP" }, { 7, "IPAPMincho" }, { 7, "MotoyaG04Mincho" },
  // MS Mincho
  { 8, "MS Mincho" },
  { 8, "\xef\xbc\xad\xef\xbc\xb3 \xe6\x98\x8e\xe6\x9c\x9d" },
  { 8, "Noto Serif CJK JP" }, { 8, "IPAMincho" }, { 8, "MotoyaG04MinchoMono" },
  // Simsun
  { 9, "Simsun" }, { 9, "\xe5\xae\x8b\xe4\xbd\x93" },
  { 9, "Noto Serif CJK SC" }, { 9, "MSung GB18030" }, { 9, "Song ASC" },
  // NSimsun
  { 10, "NSimsun" }, { 10, "\xe6\x96\xb0\xe5\xae\x8b\xe4\xbd\x93" },
  { 10, "Noto Serif CJK SC" }, { 10, "MSung GB18030" }, { 10, "N Song ASC" },
  // Simhei
  { 11, "Simhei" }, { 11, "\xe9\xbb\x91\xe4\xbd\x93" },
  { 11, "Noto Sans CJK SC" }, { 11, "MYingHeiGB18030" }, { 11, "MYingHeiB5HK" },
  // PMingLiU
  { 12, "PMingLiU" }, { 12, "\xe6\x96\xb0\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94" },
  { 12, "Noto Serif CJK TC" }, { 12, "MSung B5HK" },
  // MingLiU
  { 13, "MingLiU" }, { 13, "\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94" },
  { 13, "Noto Serif CJK TC" }, { 13, "MSung B5HK" },
  // PMingLiU_HKSCS
  { 14, "PMingLiU_HKSCS" },
  { 14, "\xe6\x96\xb0\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94_HKSCS" },
  { 14, "Noto Serif CJK TC" }, { 14, "MSung B5HK" },
  // MingLiU_HKSCS
  { 15, "MingLiU_HKSCS" },
  { 15, "\xe7\xb4\xb0\xe6\x98\x8e\xe9\xab\x94_HKSCS" },
  { 15, "Noto Serif CJK TC" }, { 15, "MSung B5HK" },
  { 16, "Cambria" }, { 16, "Caladea" },
  { 17, "Calibri" }, { 17, "Carlito" },
};
static int fontEquivClass(const char* name) {
  for (const FcFontEquiv& e : kFontEquivMap) {
    if (strcasecmp(e.name, name) == 0) return e.clazz;
  }
  return 0;
}
static bool isMetricCompatibleReplacement(const char* a, const char* b) {
  int ca = fontEquivClass(a);
  return ca != 0 && ca == fontEquivClass(b);
}

// `IsFallbackFontAllowed` (rev fd139e79:342-348): the request either names no
// family or one of the basic generics, and then ANY font is a good answer.
static bool isFallbackFontAllowed(const std::string& family) {
  return family.empty() || strcasecmp(family.c_str(), "sans") == 0
      || strcasecmp(family.c_str(), "serif") == 0
      || strcasecmp(family.c_str(), "monospace") == 0;
}

static const char* fcGetString(FcPattern* p, const char* object, int index = 0) {
  FcChar8* v = nullptr;
  if (FcPatternGetString(p, object, index, &v) != FcResultMatch) return nullptr;
  return reinterpret_cast<const char*>(v);
}
static int fcGetInt(FcPattern* p, const char* object, int missing) {
  int v;
  if (FcPatternGetInteger(p, object, 0, &v) != FcResultMatch) return missing;
  return v;
}

// `isValidPattern` (rev fd139e79:519-550) with the SFNT-only format check
// ACTIVE, because Chrome defines SK_FONT_CONFIG_INTERFACE_ONLY_ALLOW_SFNT_FONTS
// (`skia/config/SkUserConfig.h:151-152`, tag 147.0.7727.15). Sysroot handling is
// omitted: Chrome never sets FcConfigSetSysRoot in this process model, so
// FcConfigGetSysRoot is null and the branch is dead there.
static bool fcIsValidPattern(FcPattern* p) {
  const char* fmt = fcGetString(p, FC_FONTFORMAT);
  if (fmt == nullptr || (strcmp(fmt, "TrueType") != 0 && strcmp(fmt, "CFF") != 0)) {
    return false;
  }
  const char* file = fcGetString(p, FC_FILE);
  if (file == nullptr) return false;
  return access(file, R_OK) == 0;
}

static std::string runFamilyMatchQuery(FT_Library lib, const JsonValue& query) {
  const std::string family = query.at("family").asString();
  const double cssWeight = query.has("cssWeight") ? query.at("cssWeight").asNumber(400) : 400;
  const bool italic = query.at("italic").type == JsonValue::Type::Bool
                      && query.at("italic").boolean;
  const double cssWidth = query.has("cssWidth") ? query.at("cssWidth").asNumber(100) : 100;

  // Blink `FontDescription::SkiaFontStyle`: weight passes through inside
  // [1,1000], otherwise 400; width buckets to the class; italic → italic slant.
  const double skWeight = (cssWeight >= 1 && cssWeight <= 1000) ? cssWeight : 400;
  const int skWidth = skWidthClassFromCssStretchPercent(cssWidth);

  const std::string notFound = "{\"type\":\"familyMatch\",\"found\":false}";

  FcConfig* config = FcConfigGetCurrent();
  FcPattern* pattern = FcPatternCreate();
  if (pattern == nullptr) return notFound;
  if (!family.empty()) {
    FcPatternAddString(pattern, FC_FAMILY,
                       reinterpret_cast<const FcChar8*>(family.c_str()));
  }
  // `fcpattern_from_skfontstyle` (rev fd139e79:446-501): weight and width via
  // the anchor tables, slant direct. SkScalarRoundToInt rounds half away from
  // zero on positive values, which llround matches.
  FcPatternAddInteger(pattern, FC_WEIGHT, static_cast<int>(std::llround(
      fcMapRanges(skWeight, kSkToFcWeight, static_cast<int>(std::size(kSkToFcWeight))))));
  FcPatternAddInteger(pattern, FC_WIDTH, static_cast<int>(std::llround(
      fcMapRanges(skWidth, kSkToFcWidth, static_cast<int>(std::size(kSkToFcWidth))))));
  FcPatternAddInteger(pattern, FC_SLANT, italic ? FC_SLANT_ITALIC : FC_SLANT_ROMAN);
  FcPatternAddBool(pattern, FC_SCALABLE, FcTrue);
  FcPatternAddString(pattern, FC_FONT_WRAPPER,
                     reinterpret_cast<const FcChar8*>("SFNT"));

  FcConfigSubstitute(config, pattern, FcMatchPattern);
  FcDefaultSubstitute(pattern);

  // The family name the config substitution turned the request into — the
  // accept/reject comparison below is against THIS, which is what lets a
  // config alias (Arial → Liberation Sans) count as a good match.
  const char* postConfigFamilyC = fcGetString(pattern, FC_FAMILY);
  const std::string postConfigFamily = postConfigFamilyC != nullptr ? postConfigFamilyC : "";

  FcResult result;
  // trim = 0, exactly as the shipping matchFamilyName (rev fd139e79:662). The
  // newer Skia tree's direct FcFontMatch stage does not exist in the pinned
  // build and is deliberately not reproduced.
  //
  // DM-2017: this was flagged as needing re-verification against the revision
  // Chromium actually pins (Chromium 7d859f27 pins Skia `62efacd3`, newer than
  // both this transcription's fd139e79 and the checkout's own ebf5052 HEAD) —
  // specifically whether `MatchFont` scans PAST an unacceptable first valid
  // pattern for a second one. Checked against `62efacd3:src/ports/
  // SkFontConfigInterface_direct.cpp` directly (`git show`, since sparse-checkout
  // HEAD is a different commit): `MatchFont` at that revision is
  // STRUCTURALLY IDENTICAL to the fd139e79 transcription below — same
  // break-on-first-valid loop, same single-pattern accept/reject, no second
  // scan. Nothing to port; the port already matches the pinned build.
  FcFontSet* fontSet = FcFontSort(config, pattern, 0, nullptr, &result);
  FcPatternDestroy(pattern);
  if (fontSet == nullptr) return notFound;

  // `MatchFont` (rev fd139e79:553-590, confirmed unchanged in substance at the
  // Chromium-pinned 62efacd3): take the FIRST valid pattern in sort order, then
  // accept or reject THAT one — no further scanning.
  FcPattern* match = nullptr;
  for (int i = 0; i < fontSet->nfont; i++) {
    if (fcIsValidPattern(fontSet->fonts[i])) { match = fontSet->fonts[i]; break; }
  }
  if (match != nullptr && !isFallbackFontAllowed(family)) {
    bool acceptable = false;
    for (int id = 0; id < 255; id++) {
      const char* postMatchFamily = fcGetString(match, FC_FAMILY, id);
      if (postMatchFamily == nullptr) break;
      acceptable = strcasecmp(postConfigFamily.c_str(), postMatchFamily) == 0
                || strcasecmp(family.c_str(), postMatchFamily) == 0
                || isMetricCompatibleReplacement(family.c_str(), postMatchFamily);
      if (acceptable) break;
    }
    if (!acceptable) match = nullptr;
  }
  if (match == nullptr) {
    FcFontSetDestroy(fontSet);
    return notFound;
  }

  const char* file = fcGetString(match, FC_FILE);
  const char* matchFamily = fcGetString(match, FC_FAMILY);
  const int index = fcGetInt(match, FC_INDEX, 0);
  if (file == nullptr) {
    FcFontSetDestroy(fontSet);
    return notFound;
  }

  // The matched face's style read back the way Skia reports `outStyle`
  // (`skfontstyle_from_fcpattern`, rev fd139e79:401-444) — Blink consults the
  // resulting typeface's weight/slant for its synthetic-bold / synthetic-italic
  // decisions, so the Node side needs the same numbers.
  const int outWeight = static_cast<int>(std::llround(fcMapRanges(
      fcGetInt(match, FC_WEIGHT, FC_WEIGHT_REGULAR), kFcToSkWeight,
      static_cast<int>(std::size(kFcToSkWeight)))));
  const int outWidth = static_cast<int>(std::llround(fcMapRanges(
      fcGetInt(match, FC_WIDTH, FC_WIDTH_NORMAL), kFcToSkWidth,
      static_cast<int>(std::size(kFcToSkWidth)))));
  const bool outItalic = fcGetInt(match, FC_SLANT, FC_SLANT_ROMAN) != FC_SLANT_ROMAN;

  // PostScript name of the matched face (FreeType, by file + index) so the
  // Node side can register the cut and the conformance oracle can compare
  // against CDP's `postScriptName`. Not part of Skia's answer — Skia carries
  // file + ttc index — so an unnameable face still reports found:true.
  std::string psName;
  {
    FT_Face f = nullptr;
    if (FT_New_Face(lib, file, index, &f) == 0 && f != nullptr) {
      const char* n = FT_Get_Postscript_Name(f);
      if (n != nullptr) psName = n;
      FT_Done_Face(f);
    }
  }

  std::ostringstream out;
  out << "{\"type\":\"familyMatch\",\"found\":true"
      << ",\"path\":\"" << jsonEscape(file) << "\""
      << ",\"index\":" << index
      << ",\"family\":\"" << jsonEscape(matchFamily != nullptr ? matchFamily : "") << "\""
      << ",\"postscriptName\":\"" << jsonEscape(psName) << "\""
      << ",\"weight\":" << outWeight
      << ",\"width\":" << outWidth
      << ",\"italic\":" << (outItalic ? "true" : "false")
      << "}";
  FcFontSetDestroy(fontSet);
  return out.str();
}

// Open the font described by `spec`. Returns true on success (populating
// `out`); on failure returns false and sets `err` — the caller decides whether
// to `die()` (one-shot mode, preserving the original fatal contract) or skip
// the ref (`--serve` mode, where one bad envelope must not kill the server,
// matching the macOS helper's `try? openFont`).
static bool openFont(FT_Library lib, const JsonValue& spec, FontEntry& out, std::string& err) {
  std::string fontPath = spec.at("fontPath").asString();
  std::string postscriptName = spec.at("postscriptName").asString();

  if (fontPath.empty()) {
    // Family-name-only resolution (fontconfig) is intentionally not implemented:
    // the capture side always resolves a concrete fontPath via the platform
    // font-path map before invoking the helper. Fail loudly rather than guess.
    err = "font.fontPath missing (family-name resolution is not supported; pass a fontPath)";
    return false;
  }

  FT_Long faceIndex = resolveFaceIndex(lib, fontPath, postscriptName);
  FT_Face face = nullptr;
  if (FT_New_Face(lib, fontPath.c_str(), faceIndex, &face) != 0) {
    err = "could not open font: " + fontPath;
    return false;
  }

  // Variations (variable / MM fonts): map requested axis tags to design coords.
  const JsonValue& variations = spec.at("variations");
  if (variations.isObject() && !variations.object->empty()) {
    FT_MM_Var* mm = nullptr;
    if (FT_Get_MM_Var(face, &mm) == 0 && mm != nullptr) {
      std::vector<FT_Fixed> coords(mm->num_axis);
      for (FT_UInt a = 0; a < mm->num_axis; a++) {
        coords[a] = mm->axis[a].def;  // default unless overridden below
        for (const auto& kv : *variations.object) {
          if (fourCharTag(kv.first) == mm->axis[a].tag && kv.second.isNumber()) {
            // FT design coords are 16.16 fixed point.
            coords[a] = static_cast<FT_Fixed>(std::llround(kv.second.number * 65536.0));
          }
        }
      }
      FT_Set_Var_Design_Coordinates(face, mm->num_axis, coords.data());
      FT_Done_MM_Var(lib, mm);
    }
  }

  out.face = face;
  out.unitsPerEm = static_cast<int>(face->units_per_EM);
  return true;
}

// Load a glyph outline in font units (NO_SCALE → exact design units, y-up).
static void loadGlyph(FT_Face face, FT_UInt glyphIndex, std::string& dOut,
                      double& advanceOut, FT_BBox& bboxOut) {
  dOut.clear();
  advanceOut = 0;
  bboxOut = {0, 0, 0, 0};
  if (glyphIndex == 0) return;  // .notdef → empty path (parity with other helpers)
  if (FT_Load_Glyph(face, glyphIndex,
                    FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP) != 0) {
    return;
  }
  FT_GlyphSlot slot = face->glyph;
  advanceOut = static_cast<double>(slot->advance.x);  // font units under NO_SCALE
  if (slot->format == FT_GLYPH_FORMAT_OUTLINE) {
    FT_Outline_Get_CBox(&slot->outline, &bboxOut);
    dOut = decomposeOutline(&slot->outline);
  }
}

// ──────────────────────────────── queries ──────────────────────────────────

static std::string runGlyphsQuery(const JsonValue& query, std::map<std::string, FontEntry>& fonts) {
  std::ostringstream out;
  std::string ref = query.at("fontRef").asString();
  auto it = fonts.find(ref);
  if (it == fonts.end()) {
    return "{\"type\":\"glyphs\",\"error\":\"fontRef missing or unknown\",\"glyphs\":[]}";
  }
  FT_Face face = it->second.face;

  out << "{\"type\":\"glyphs\",\"glyphs\":[";
  const JsonArray& inputs = query.at("glyphs").asArray();
  for (size_t i = 0; i < inputs.size(); i++) {
    const JsonValue& g = inputs[i];
    FT_UInt glyphIndex = 0;
    if (g.has("id")) {
      glyphIndex = static_cast<FT_UInt>(g.at("id").asNumber());
    } else if (g.has("cp")) {
      glyphIndex = FT_Get_Char_Index(face, static_cast<FT_ULong>(g.at("cp").asNumber()));
    }

    std::string d;
    double advance;
    FT_BBox bbox;
    loadGlyph(face, glyphIndex, d, advance, bbox);

    if (i > 0) out << ",";
    out << "{\"id\":" << glyphIndex
        << ",\"advance\":" << formatNumber(advance)
        << ",\"bbox\":{\"x\":" << formatNumber(bbox.xMin)
        << ",\"y\":" << formatNumber(bbox.yMin)
        << ",\"w\":" << formatNumber(bbox.xMax - bbox.xMin)
        << ",\"h\":" << formatNumber(bbox.yMax - bbox.yMin)
        << "},\"d\":\"" << d << "\"}";
  }
  out << "]}";
  return out.str();
}

static std::string runMetaQuery(const JsonValue& query, std::map<std::string, FontEntry>& fonts) {
  std::string ref = query.at("fontRef").asString();
  auto it = fonts.find(ref);
  if (it == fonts.end()) {
    return "{\"type\":\"meta\",\"error\":\"fontRef missing or unknown\"}";
  }
  FT_Face face = it->second.face;

  std::ostringstream out;
  out << "{\"type\":\"meta\""
      << ",\"unitsPerEm\":" << static_cast<int>(face->units_per_EM)
      << ",\"ascent\":" << static_cast<int>(face->ascender)
      << ",\"descent\":" << static_cast<int>(face->descender);

  // post table: underline position / thickness (design units).
  out << ",\"underlinePosition\":" << static_cast<int>(face->underline_position)
      << ",\"underlineThickness\":" << static_cast<int>(face->underline_thickness);

  // OS/2 table: strikeout position / size (design units).
  auto* os2 = static_cast<TT_OS2*>(FT_Get_Sfnt_Table(face, FT_SFNT_OS2));
  if (os2 != nullptr && os2->version != 0xFFFF) {
    out << ",\"strikeoutPosition\":" << static_cast<int>(os2->yStrikeoutPosition)
        << ",\"strikeoutThickness\":" << static_cast<int>(os2->yStrikeoutSize);
  }
  out << "}";
  return out.str();
}

// ─────────────────────────── envelope handling ─────────────────────────────

// DM-1034: stable cache key for an opened font, so `--serve` mode reuses the
// FT_Face across requests instead of re-opening (face open + FreeType init is
// the dominant per-spawn cost). Mirrors the macOS helper's `fontCacheKey`:
// postscriptName | fontPath | size | sorted variation axes. Under NO_SCALE the
// `size` field never affects the outline, but it's kept in the key for parity
// with the cross-platform contract (and so a future sized path stays correct).
static std::string fontCacheKey(const JsonValue& spec) {
  std::string ps = spec.at("postscriptName").asString();
  std::string fp = spec.at("fontPath").asString();
  std::string sz = spec.has("size") ? formatNumber(spec.at("size").asNumber(16)) : "16";
  std::string varKey;
  const JsonValue& variations = spec.at("variations");
  if (variations.isObject() && variations.object) {
    // Sorted axis=value pairs so the key is order-independent (std::map already
    // iterates keys in sorted order).
    bool first = true;
    for (const auto& kv : *variations.object) {
      if (!first) varKey += ",";
      first = false;
      varKey += kv.first + "=" +
                (kv.second.isNumber() ? formatNumber(kv.second.number) : std::string());
    }
  }
  return ps + "|" + fp + "|" + sz + "|" + varKey;
}

// Run one request envelope into its JSON response string, opening (or reusing,
// via `fontCache`) the declared fonts and dispatching each query. `dieOnOpenFail`
// preserves the one-shot CLI's fatal contract; `--serve` passes false so a
// malformed envelope yields a per-query error without taking down the loop.
// Faces are owned by `fontCache` and freed by the caller — never here — so a
// cached face survives across envelopes (and isn't double-freed).
static std::string handleEnvelope(FT_Library lib, const JsonValue& envelope,
                                  std::map<std::string, FontEntry>& fontCache,
                                  bool dieOnOpenFail) {
  std::map<std::string, FontEntry> fonts;  // ref → face for THIS envelope
  for (const JsonValue& spec : envelope.at("fonts").asArray()) {
    std::string ref = spec.at("ref").asString();
    if (ref.empty()) {
      if (dieOnOpenFail) die("font.ref missing");
      continue;
    }
    std::string key = fontCacheKey(spec);
    auto cached = fontCache.find(key);
    if (cached != fontCache.end()) {
      fonts[ref] = cached->second;
      continue;
    }
    FontEntry entry;
    std::string err;
    if (openFont(lib, spec, entry, err)) {
      fontCache[key] = entry;
      fonts[ref] = entry;
    } else if (dieOnOpenFail) {
      die(err);
    }
    // On open failure in serve mode the ref is simply absent; queries
    // referencing it report "fontRef missing or unknown" (matching macOS).
  }

  std::ostringstream response;
  response << "{\"results\":[";
  const JsonArray& queries = envelope.at("queries").asArray();
  for (size_t i = 0; i < queries.size(); i++) {
    if (i > 0) response << ",";
    const std::string type = queries[i].at("type").asString();
    if (type == "glyphs") {
      response << runGlyphsQuery(queries[i], fonts);
    } else if (type == "meta") {
      response << runMetaQuery(queries[i], fonts);
    } else if (type == "fcfallback") {
      response << runFcFallbackQuery(queries[i]);
    } else if (type == "familyMatch") {
      response << runFamilyMatchQuery(lib, queries[i]);
    } else {
      response << "{\"type\":\"" << jsonEscape(type) << "\",\"error\":\"unknown query type\"}";
    }
  }
  response << "]}";
  return response.str();
}

// ──────────────────────────────── main ─────────────────────────────────────

static std::string readAll(std::istream& in) {
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

int main(int argc, char** argv) {
  std::string inputPath;
  bool serve = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--version") {
      // 0.2.0: added the `familyMatch` query (declared-family style match —
      // the fontconfig transcription of Skia's matchFamilyName).
      std::cout << "domotion-glyph-paths (linux/freetype) 0.2.0\n";
      return 0;
    }
    if (a == "--help" || a == "-h") {
      std::cout << "Usage: domotion-glyph-paths [--input <path>] [--serve]\n"
                   "Reads a JSON request envelope from stdin (default) or the given file.\n"
                   "Writes a JSON response to stdout.\n"
                   "--serve: persistent mode — read one request envelope per line on stdin,\n"
                   "         write one response per line on stdout, looping until EOF, reusing\n"
                   "         opened fonts across requests (DM-1034).\n";
      return 0;
    }
    if (a == "--serve") {
      serve = true;
    } else if (a == "--input") {
      if (i + 1 >= argc) die("--input requires a path");
      inputPath = argv[++i];
    } else {
      die("unknown argument: " + a);
    }
  }

  FT_Library lib = nullptr;
  if (FT_Init_FreeType(&lib) != 0) die("FT_Init_FreeType failed");

  if (serve) {
    // DM-1034: persistent server. One request envelope per line in, one
    // response per line out. Faces opened once are reused for the process
    // lifetime via `fontCache`. A malformed line yields an error response but
    // does not stop the loop; EOF (the parent closing stdin) ends it. stdout is
    // a pipe here (fully buffered by default), so flush after every response or
    // the parent's synchronous read blocks forever waiting on buffered bytes.
    std::map<std::string, FontEntry> fontCache;
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.empty()) continue;
      JsonValue envelope;
      if (!JsonParser(line).parse(envelope) || !envelope.isObject()) {
        std::cout << "{\"results\":[],\"error\":\"invalid JSON on input line\"}\n" << std::flush;
        continue;
      }
      std::cout << handleEnvelope(lib, envelope, fontCache, /*dieOnOpenFail=*/false)
                << "\n" << std::flush;
    }
    for (auto& kv : fontCache) {
      if (kv.second.face) FT_Done_Face(kv.second.face);
    }
    FT_Done_FreeType(lib);
    return 0;
  }

  // One-shot mode (the fallback path / the original CLI contract).
  std::string requestText;
  if (!inputPath.empty()) {
    std::ifstream f(inputPath, std::ios::binary);
    if (!f) die("could not read --input file: " + inputPath);
    requestText = readAll(f);
  } else {
    requestText = readAll(std::cin);
  }

  JsonValue envelope;
  if (!JsonParser(requestText).parse(envelope) || !envelope.isObject()) {
    die("invalid JSON on input");
  }

  std::map<std::string, FontEntry> fontCache;
  std::string response = handleEnvelope(lib, envelope, fontCache, /*dieOnOpenFail=*/true);

  for (auto& kv : fontCache) {
    if (kv.second.face) FT_Done_Face(kv.second.face);
  }
  FT_Done_FreeType(lib);

  std::cout << response << "\n";
  return 0;
}
