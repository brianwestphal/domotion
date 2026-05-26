// Domotion Linux native glyph-outline extractor (FreeType).
//
// Reads a single JSON request envelope from stdin (default) or `--input <path>`,
// extracts per-glyph SVG outlines and/or font metadata via FreeType, and writes
// the JSON response to stdout. The envelope is identical to the macOS CoreText
// helper (tools/macos-glyph-extractor) and the Windows DirectWrite helper — see
// docs/16-coretext-glyph-extraction.md (shared contract) and
// docs/45-linux-glyph-extraction.md (Linux specifics).
//
// Coordinate convention: outlines are emitted in FreeType's native y-UP, in
// font design units, via FT_LOAD_NO_SCALE — exactly what fontkit's
// `glyph.path.commands` returns, so the helper is a drop-in backend for the
// renderer's `scale(fontSize/unitsPerEm, ...)` transform. Do NOT negate y here:
// the renderer flips to SVG y-down at draw time, and negating would double-flip
// and fail the fontkit `H` parity test. (docs/45 originally said "negate y";
// that was wrong — corrected to match the macOS helper + fontkit.)

#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include FT_MULTIPLE_MASTERS_H
#include FT_TRUETYPE_TABLES_H
#include FT_SFNT_NAMES_H

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
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

static FontEntry openFont(FT_Library lib, const JsonValue& spec) {
  std::string fontPath = spec.at("fontPath").asString();
  std::string postscriptName = spec.at("postscriptName").asString();

  if (fontPath.empty()) {
    // Family-name-only resolution (fontconfig) is intentionally not implemented:
    // the capture side always resolves a concrete fontPath via the platform
    // font-path map before invoking the helper. Fail loudly rather than guess.
    die("font.fontPath missing (family-name resolution is not supported; pass a fontPath)");
  }

  FT_Long faceIndex = resolveFaceIndex(lib, fontPath, postscriptName);
  FT_Face face = nullptr;
  if (FT_New_Face(lib, fontPath.c_str(), faceIndex, &face) != 0) {
    die("could not open font: " + fontPath);
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

  FontEntry entry;
  entry.face = face;
  entry.unitsPerEm = static_cast<int>(face->units_per_EM);
  return entry;
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

// ──────────────────────────────── main ─────────────────────────────────────

static std::string readAll(std::istream& in) {
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

int main(int argc, char** argv) {
  std::string inputPath;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--version") {
      std::cout << "domotion-glyph-paths (linux/freetype) 0.1.0\n";
      return 0;
    }
    if (a == "--help" || a == "-h") {
      std::cout << "Usage: domotion-glyph-paths [--input <path>]\n"
                   "Reads a JSON request envelope from stdin (default) or the given file.\n"
                   "Writes a JSON response to stdout.\n";
      return 0;
    }
    if (a == "--input") {
      if (i + 1 >= argc) die("--input requires a path");
      inputPath = argv[++i];
    } else {
      die("unknown argument: " + a);
    }
  }

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

  FT_Library lib = nullptr;
  if (FT_Init_FreeType(&lib) != 0) die("FT_Init_FreeType failed");

  std::map<std::string, FontEntry> fonts;
  for (const JsonValue& spec : envelope.at("fonts").asArray()) {
    std::string ref = spec.at("ref").asString();
    if (ref.empty()) die("font.ref missing");
    fonts[ref] = openFont(lib, spec);
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
    } else {
      response << "{\"type\":\"" << jsonEscape(type) << "\",\"error\":\"unknown query type\"}";
    }
  }
  response << "]}";

  for (auto& kv : fonts) {
    if (kv.second.face) FT_Done_Face(kv.second.face);
  }
  FT_Done_FreeType(lib);

  std::cout << response.str() << "\n";
  return 0;
}
