// Domotion Windows native glyph-outline extractor (DirectWrite).
//
// Reads a single JSON request envelope from stdin (default) or `--input <path>`,
// extracts per-glyph SVG outlines and/or font metadata via DirectWrite, and
// writes the JSON response to stdout. The envelope is identical to the macOS
// CoreText helper and the Linux FreeType helper — see
// docs/16-coretext-glyph-extraction.md (shared contract) and
// docs/41-windows-glyph-extraction.md (Windows specifics).
//
// Coordinate convention: outlines are emitted in font design units, y-UP — the
// same convention fontkit's `glyph.path.commands` and the macOS/Linux helpers
// use, so the renderer's `scale(fontSize/unitsPerEm, ...)` transform consumes
// helper and fontkit output interchangeably. DirectWrite's GetGlyphRunOutline
// emits Direct2D screen-space geometry (y-DOWN), so we NEGATE y to reach the
// y-up convention. (This is the opposite of the FreeType helper, which is
// natively y-up. The sign is pinned by the `H` parity test — see
// tests/win32-glyph-extractor.test.ts. docs/41 originally said "negate y"
// without nailing down why; this comment is the authoritative rationale.)
//
// The JSON parser/serializer + formatNumber/jsonEscape are copied verbatim from
// the Linux helper (portable C++17), so only the DirectWrite-specific code here
// is new.
//
// A persistent `--serve` mode (DM-1035) mirrors the macOS CoreText and Linux
// FreeType helpers': read one request envelope per line on stdin, write one
// response per line on stdout, loop until EOF, reusing opened IDWriteFontFaces
// across requests via a cache. The fixed per-spawn cost (process spawn +
// DWriteCreateFactory + CreateFontFace) is what the persistent process
// amortizes, so the renderer's `glyph-helper.ts` does one round-trip per call
// over a single long-lived child instead of a fresh `spawnSync` each time. The
// one-shot CLI mode is the transparent fallback (an older binary that predates
// `--serve` dies on the unknown flag, the wrapper notices, and reverts to
// one-shot). The serve refactor — `fontCacheKey` + `handleEnvelope` + the
// stdin loop — is a structural mirror of the Linux helper's and adds no new
// DirectWrite API calls.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d2d1.h>      // full ID2D1SimplifiedGeometrySink definition (we implement it)
#include <dwrite_3.h>  // IDWriteGeometrySink is a typedef for the above

#include <fcntl.h>     // _O_BINARY — LF-only stdio on Windows (DM-1035 serve loop)
#include <io.h>        // _setmode / _fileno
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

#pragma comment(lib, "dwrite.lib")
// DM-1881: SystemParametersInfoW, for the OS UI font family (`systemfont` query).
// Declared as a pragma rather than only in the build scripts so every build path
// — cmake, the direct-MSVC script, and CI — links it without a fourth place to
// keep in sync.
#pragma comment(lib, "user32.lib")

// ───────────────────────────── JSON value ──────────────────────────────────
// (verbatim from tools/linux-glyph-extractor/src/main.cpp)

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
  bool asBool(bool def = false) const { return type == Type::Bool ? boolean : def; }
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& src) : s_(src) {}
  bool parse(JsonValue& out) {
    skipWs();
    if (!parseValue(out)) return false;
    skipWs();
    return true;
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
      case '"': out.type = JsonValue::Type::String; return parseString(out.string);
      case 't': case 'f': return parseBool(out);
      case 'n': return parseNull(out);
      default: return parseNumber(out);
    }
  }
  bool parseObject(JsonValue& out) {
    out.type = JsonValue::Type::Object;
    out.object = std::make_shared<JsonObject>();
    i_++;
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
    i_++;
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
    i_++;
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
            if (cp >= 0xD800 && cp <= 0xDBFF) {
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

static std::wstring toWide(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), &w[0], n);
  return w;
}
static std::string fromWide(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, nullptr, nullptr);
  return s;
}

// ───────────────────────── geometry sink ───────────────────────────────────

// Minimal ID2D1SimplifiedGeometrySink that turns DirectWrite glyph outlines
// into an SVG path-data string. y is negated on every point (Direct2D y-down →
// fontkit y-up). DirectWrite elevates TrueType quadratics to cubics, so curves
// arrive only via AddBeziers → we emit `C`. EndFigure closes implicitly, so we
// emit a single `Z` (no redundant trailing line, unlike FreeType).
class SvgPathSink : public IDWriteGeometrySink {
 public:
  std::string d;
  double minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;

  // IUnknown — single-threaded, stack-owned; ref counting is a no-op.
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(ID2D1SimplifiedGeometrySink)) {
      *ppv = static_cast<ID2D1SimplifiedGeometrySink*>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }

  void STDMETHODCALLTYPE SetFillMode(D2D1_FILL_MODE) override {}
  void STDMETHODCALLTYPE SetSegmentFlags(D2D1_PATH_SEGMENT) override {}

  void STDMETHODCALLTYPE BeginFigure(D2D1_POINT_2F p, D2D1_FIGURE_BEGIN) override {
    moveTo(p.x, p.y);
  }
  void STDMETHODCALLTYPE AddLines(const D2D1_POINT_2F* points, UINT32 count) override {
    for (UINT32 i = 0; i < count; i++) lineTo(points[i].x, points[i].y);
  }
  void STDMETHODCALLTYPE AddBeziers(const D2D1_BEZIER_SEGMENT* beziers, UINT32 count) override {
    for (UINT32 i = 0; i < count; i++) {
      cubicTo(beziers[i].point1.x, beziers[i].point1.y, beziers[i].point2.x, beziers[i].point2.y,
              beziers[i].point3.x, beziers[i].point3.y);
    }
  }
  void STDMETHODCALLTYPE EndFigure(D2D1_FIGURE_END) override { append("Z"); }
  HRESULT STDMETHODCALLTYPE Close() override { return S_OK; }

 private:
  bool first = true;
  void append(const std::string& seg) {
    if (!first) d.push_back(' ');
    d += seg;
    first = false;
  }
  void track(double x, double y) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Direct2D y-down → emit y-up (fontkit convention): negate y.
  static double fy(double y) { return -y; }
  void moveTo(double x, double y) {
    track(x, fy(y));
    append("M " + formatNumber(x) + " " + formatNumber(fy(y)));
  }
  void lineTo(double x, double y) {
    track(x, fy(y));
    append("L " + formatNumber(x) + " " + formatNumber(fy(y)));
  }
  void cubicTo(double c1x, double c1y, double c2x, double c2y, double x, double y) {
    track(x, fy(y));
    append("C " + formatNumber(c1x) + " " + formatNumber(fy(c1y)) + " " +
           formatNumber(c2x) + " " + formatNumber(fy(c2y)) + " " +
           formatNumber(x) + " " + formatNumber(fy(y)));
  }
};

// ──────────────────────────── font handling ────────────────────────────────

template <class T>
static void safeRelease(T*& p) {
  if (p) { p->Release(); p = nullptr; }
}

struct FontEntry {
  IDWriteFontFace* face = nullptr;
  int unitsPerEm = 0;
  UINT32 faceIndex = 0;
};

// ─────────────────── Skia's simulation stripping, transcribed ───────────────
//
// Chrome does NOT take DirectWrite's simulated faces. When DirectWrite has no
// real bold (or italic) cut for a request it hands back the base face with a
// DWRITE_FONT_SIMULATIONS_BOLD / _OBLIQUE flag, meaning "embolden/slant this
// yourself"; Skia retries the match with the offending style axis reset so the
// caller receives a CLEAN face, and Blink then applies its OWN synthetic-bold /
// synthetic-oblique decision on top. Both halves are conditional on the
// SK_WIN_FONTMGR_NO_SIMULATIONS build define — which Chromium sets
// (`skia/BUILD.gn:65`, tag 147.0.7727.15), so the stripping is ACTIVE in every
// shipping Chrome and is therefore what parity requires here.
//
// Transcribed from Skia rev fd139e79 — the revision Chromium tag 147.0.7727.15
// pins through `DEPS` (`skia_revision`), i.e. the Skia inside the Chrome this
// project targets, NOT the newer local `external/skia` checkout. The two differ:
// the newer tree threads an `allowedSimulations` mask through and gives the
// MapCharacters loop a regular/upright early-out that the pinned revision lacks.
// The pinned shape is the one below.
//
// The exemption is real and load-bearing: the Korean bitmap-strike families
// (Gulim, Dotum, Batang, Gungsuh) are ALLOWED to keep Windows' simulations,
// because their bitmap strikes get emboldened without antialiasing and Korean
// users prefer that to Skia's synthetic bold. A face qualifies by carrying an
// `EBDT` table.

/** `HasBitmapStrikes` (SkFontMgr_win_dw.cpp:43-51, Skia rev fd139e79). Skia
 *  builds the tag as `SkEndian_SwapBE32(SkSetFourByteTag('E','B','D','T'))`,
 *  which is bit-for-bit `DWRITE_MAKE_OPENTYPE_TAG('E','B','D','T')` (both
 *  0x54444245) — the macro is used here because it says what it means. */
static bool faceHasBitmapStrikes(IDWriteFont* font) {
  if (!font) return false;
  IDWriteFontFace* face = nullptr;
  if (FAILED(font->CreateFontFace(&face)) || !face) return false;
  const void* tableData = nullptr;
  UINT32 tableSize = 0;
  void* tableCtx = nullptr;
  BOOL exists = FALSE;
  if (SUCCEEDED(face->TryGetFontTable(DWRITE_MAKE_OPENTYPE_TAG('E', 'B', 'D', 'T'),
                                      &tableData, &tableSize, &tableCtx, &exists))) {
    if (tableCtx) face->ReleaseFontTable(tableCtx);
  }
  safeRelease(face);
  return exists != FALSE;
}

// Both loops below reset at most one style axis per pass, so three matching
// calls is already one more than either can need. The cap exists because the
// PINNED `SkFontMgr_DirectWrite::fallback` loop has no upright/regular
// termination clause: were DirectWrite ever to answer a REGULAR/NORMAL request
// with a simulation flag, that loop would re-issue the identical request
// forever. Skia can afford the theoretical spin; a helper process that must
// answer a pipe request cannot, so the count is bounded and the last matched
// face is kept. No input that terminates in Skia reaches the cap.
static const int kMaxSimulationStrips = 4;

/** `FirstMatchingFontWithoutSimulations` (SkFontMgr_win_dw.cpp:52-92, Skia rev
 *  fd139e79) — the wrapper `SkFontStyleSet_DirectWrite::matchStyle` (`:861-870`)
 *  puts around `GetFirstMatchingFont`, and therefore what Blink's
 *  `matchFamilyStyle` actually runs on Windows. */
static HRESULT firstMatchingFontWithoutSimulations(IDWriteFontFamily* family,
                                                   DWRITE_FONT_WEIGHT weight,
                                                   DWRITE_FONT_STRETCH stretch,
                                                   DWRITE_FONT_STYLE slant,
                                                   IDWriteFont** out) {
  *out = nullptr;
  if (!family) return E_INVALIDARG;
  for (int pass = 0; pass < kMaxSimulationStrips; pass++) {
    IDWriteFont* searchFont = nullptr;
    HRESULT hr = family->GetFirstMatchingFont(weight, stretch, slant, &searchFont);
    if (FAILED(hr)) { safeRelease(*out); return hr; }
    if (!searchFont) break;
    safeRelease(*out);
    *out = searchFont;

    DWRITE_FONT_SIMULATIONS simulations = searchFont->GetSimulations();
    // "If we still get simulations even though we're not asking for bold or
    // italic, we can't help it and exit the loop."
    const bool noSimulations = simulations == DWRITE_FONT_SIMULATIONS_NONE ||
                               (weight == DWRITE_FONT_WEIGHT_REGULAR &&
                                slant == DWRITE_FONT_STYLE_NORMAL) ||
                               faceHasBitmapStrikes(searchFont);
    if (noSimulations) break;
    if (simulations & DWRITE_FONT_SIMULATIONS_BOLD) {
      weight = DWRITE_FONT_WEIGHT_REGULAR;
      continue;
    }
    if (simulations & DWRITE_FONT_SIMULATIONS_OBLIQUE) {
      slant = DWRITE_FONT_STYLE_NORMAL;
      continue;
    }
    break;  // unreachable: a non-NONE mask is one of the two flags above.
  }
  return *out ? S_OK : E_FAIL;
}

// Read a localized informational string (e.g. PostScript name), preferring en-us.
static std::string readInfoString(IDWriteLocalizedStrings* strings) {
  if (!strings) return "";
  UINT32 index = 0;
  BOOL exists = FALSE;
  if (FAILED(strings->FindLocaleName(L"en-us", &index, &exists)) || !exists) index = 0;
  UINT32 len = 0;
  if (FAILED(strings->GetStringLength(index, &len))) return "";
  std::wstring buf(len + 1, L'\0');
  if (FAILED(strings->GetString(index, &buf[0], len + 1))) return "";
  buf.resize(len);
  return fromWide(buf);
}

static std::string facePostScriptName(IDWriteFontFace* face) {
  IDWriteFontFace3* face3 = nullptr;
  if (FAILED(face->QueryInterface(__uuidof(IDWriteFontFace3), reinterpret_cast<void**>(&face3))) || !face3) {
    return "";
  }
  IDWriteLocalizedStrings* names = nullptr;
  BOOL exists = FALSE;
  std::string result;
  if (SUCCEEDED(face3->GetInformationalStrings(DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME, &names, &exists)) &&
      exists && names) {
    result = readInfoString(names);
  }
  safeRelease(names);
  safeRelease(face3);
  return result;
}

// DM-1403: the on-disk file path of an IDWriteFontFace's first file, resolved
// through the local font-file loader (GetReferenceKey → GetFilePathFromKey).
// Used by the system-fallback query so the renderer can open the substitute
// face by path through the same machinery it uses elsewhere.
static std::string fontFacePath(IDWriteFontFace* face) {
  if (!face) return "";
  UINT32 fileCount = 0;
  if (FAILED(face->GetFiles(&fileCount, nullptr)) || fileCount == 0) return "";
  std::vector<IDWriteFontFile*> files(fileCount, nullptr);
  if (FAILED(face->GetFiles(&fileCount, files.data()))) return "";
  std::string out;
  if (files[0]) {
    const void* key = nullptr;
    UINT32 keySize = 0;
    IDWriteFontFileLoader* loader = nullptr;
    IDWriteLocalFontFileLoader* local = nullptr;
    if (SUCCEEDED(files[0]->GetReferenceKey(&key, &keySize)) &&
        SUCCEEDED(files[0]->GetLoader(&loader)) && loader &&
        SUCCEEDED(loader->QueryInterface(__uuidof(IDWriteLocalFontFileLoader),
                                         reinterpret_cast<void**>(&local))) && local) {
      UINT32 len = 0;
      if (SUCCEEDED(local->GetFilePathLengthFromKey(key, keySize, &len))) {
        std::wstring buf(len + 1, L'\0');
        if (SUCCEEDED(local->GetFilePathFromKey(key, keySize, &buf[0], len + 1))) {
          buf.resize(len);
          out = fromWide(buf);
        }
      }
    }
    safeRelease(local);
    safeRelease(loader);
  }
  for (IDWriteFontFile* f : files) safeRelease(f);
  return out;
}

// DM-1403: the (en-us) family name of an IDWriteFont.
static std::string fontFamilyDisplayName(IDWriteFont* font) {
  if (!font) return "";
  IDWriteFontFamily* family = nullptr;
  if (FAILED(font->GetFontFamily(&family)) || !family) return "";
  IDWriteLocalizedStrings* names = nullptr;
  std::string out;
  if (SUCCEEDED(family->GetFamilyNames(&names)) && names) out = readInfoString(names);
  safeRelease(names);
  safeRelease(family);
  return out;
}

// DM-1403: encode a Unicode scalar as UTF-16 (Windows wchar_t), with a surrogate
// pair for the supplementary planes.
static std::wstring cpToUtf16(uint32_t cp) {
  std::wstring w;
  if (cp <= 0xFFFF) {
    w.push_back(static_cast<wchar_t>(cp));
  } else {
    cp -= 0x10000;
    w.push_back(static_cast<wchar_t>(0xD800 + (cp >> 10)));
    w.push_back(static_cast<wchar_t>(0xDC00 + (cp & 0x3FF)));
  }
  return w;
}

// DM-1403: minimal IDWriteTextAnalysisSource over a single in-memory UTF-16
// string, the input IDWriteFontFallback::MapCharacters requires. LTR; we feed it
// one codepoint at a time.
//
// DM-1896: the locale is the CALLER'S, not a constant. It used to report a
// hardcoded L"en-us", which is a different question than Chrome asks: Blink
// resolves a per-codepoint fallback locale
// (`FallbackLocaleForCharacter(...)->LocaleForSkFontMgr()`,
// win/font_cache_skia_win.cc:228-240, Chromium rev 7d859f27) and Skia plumbs it
// to exactly this method (`FontFallbackSource::GetLocaleName`,
// src/ports/SkFontMgr_win_dw.cpp:592-599, Skia rev ebf5052). It is what
// disambiguates unified Han — the same ideograph maps to a Japanese face under
// "ja" and a Chinese one under "zh-Hans" — so a constant here answered by
// DirectWrite's default preference order and reported it as Chrome's pick.
//
// The NUMBER SUBSTITUTION is likewise the caller's, not null. Skia builds one
// from the SAME bcp47 tag it reports as the locale and returns it verbatim from
// this method (`SkFontMgr_win_dw.cpp:637-643` and `:572-579`, Skia rev fd139e79
// — the revision Chromium tag 147.0.7727.15 pins), so a null here asked
// DirectWrite a question Chrome never asks. See `createSkiaNumberSubstitution`
// for the construction and for what happens when DirectWrite rejects the tag.
class SingleStringAnalysisSource : public IDWriteTextAnalysisSource {
 public:
  SingleStringAnalysisSource(std::wstring text, std::wstring locale,
                             IDWriteNumberSubstitution* numberSubstitution)
      : text_(std::move(text)), locale_(std::move(locale)),
        numberSubstitution_(numberSubstitution) {
    if (numberSubstitution_) numberSubstitution_->AddRef();
  }
  // IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IDWriteTextAnalysisSource)) {
      *ppv = static_cast<IDWriteTextAnalysisSource*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --ref_;
    if (r == 0) {
      if (numberSubstitution_) numberSubstitution_->Release();
      delete this;
    }
    return r;
  }
  // IDWriteTextAnalysisSource
  HRESULT STDMETHODCALLTYPE GetTextAtPosition(UINT32 pos, WCHAR const** str, UINT32* len) override {
    if (pos >= text_.size()) { *str = nullptr; *len = 0; return S_OK; }
    *str = text_.c_str() + pos;
    *len = static_cast<UINT32>(text_.size() - pos);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetTextBeforePosition(UINT32 pos, WCHAR const** str, UINT32* len) override {
    if (pos == 0 || pos > text_.size()) { *str = nullptr; *len = 0; return S_OK; }
    *str = text_.c_str();
    *len = pos;
    return S_OK;
  }
  DWRITE_READING_DIRECTION STDMETHODCALLTYPE GetParagraphReadingDirection() override {
    return DWRITE_READING_DIRECTION_LEFT_TO_RIGHT;
  }
  HRESULT STDMETHODCALLTYPE GetLocaleName(UINT32 pos, UINT32* len, WCHAR const** name) override {
    // The string outlives the call (it is a member), which is what this
    // interface requires of the pointer it hands back.
    *name = locale_.c_str();
    *len = static_cast<UINT32>(text_.size() - (pos < text_.size() ? pos : text_.size()));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetNumberSubstitution(UINT32 pos, UINT32* len, IDWriteNumberSubstitution** ns) override {
    // Skia hands back the object it built, unowned and without an AddRef
    // (`FontFallbackSource::GetNumberSubstitution`, :572-579) — the source holds
    // it alive for the duration of the MapCharacters call. Same contract here.
    *ns = numberSubstitution_;
    *len = static_cast<UINT32>(text_.size() - (pos < text_.size() ? pos : text_.size()));
    return S_OK;
  }

 private:
  std::wstring text_;
  std::wstring locale_;
  IDWriteNumberSubstitution* numberSubstitution_ = nullptr;
  ULONG ref_ = 1;
};

/** The `IDWriteNumberSubstitution` Skia builds before every fallback match
 *  (`SkFontMgr_win_dw.cpp:637-641`, Skia rev fd139e79):
 *
 *      HRNM(fFactory->CreateNumberSubstitution(DWRITE_NUMBER_SUBSTITUTION_METHOD_NONE,
 *                                              dwBcp47, TRUE, &numberSubstitution),
 *           "Could not create number substitution.");
 *
 *  All three arguments are choices, not defaults: the METHOD is NONE, the locale
 *  is the same tag the analysis source reports, and `ignoreUserOverride` is TRUE
 *  — so the host user's numeral-shape preference is deliberately excluded from
 *  the question. Returns null (and sets `hr`) if DirectWrite rejects the tag;
 *  the caller mirrors Skia's `HRNM`, which bails out of the whole match. */
static IDWriteNumberSubstitution* createSkiaNumberSubstitution(IDWriteFactory* factory,
                                                               const std::wstring& locale,
                                                               HRESULT* hr) {
  IDWriteNumberSubstitution* substitution = nullptr;
  *hr = factory ? factory->CreateNumberSubstitution(DWRITE_NUMBER_SUBSTITUTION_METHOD_NONE,
                                                    locale.c_str(), TRUE, &substitution)
                : E_POINTER;
  if (FAILED(*hr)) return nullptr;
  return substitution;
}

// Open the font described by `spec`. Returns true on success (populating
// `out`); on failure returns false and sets `err` — the caller decides whether
// to `die()` (one-shot mode, preserving the original fatal contract) or skip
// the ref (`--serve` mode, where one bad envelope must not kill the server,
// matching the macOS / Linux helpers).
static bool openFont(IDWriteFactory* factory, const JsonValue& spec, FontEntry& out, std::string& err) {
  std::string fontPath = spec.at("fontPath").asString();
  std::string postscriptName = spec.at("postscriptName").asString();
  if (fontPath.empty()) {
    err = "font.fontPath missing (family-name resolution is not supported; pass a fontPath)";
    return false;
  }

  std::wstring widePath = toWide(fontPath);
  IDWriteFontFile* file = nullptr;
  if (FAILED(factory->CreateFontFileReference(widePath.c_str(), nullptr, &file)) || !file) {
    err = "could not open font file: " + fontPath;
    return false;
  }

  BOOL isSupported = FALSE;
  DWRITE_FONT_FILE_TYPE fileType = DWRITE_FONT_FILE_TYPE_UNKNOWN;
  DWRITE_FONT_FACE_TYPE faceType = DWRITE_FONT_FACE_TYPE_UNKNOWN;
  UINT32 numberOfFaces = 0;
  if (FAILED(file->Analyze(&isSupported, &fileType, &faceType, &numberOfFaces)) || !isSupported) {
    safeRelease(file);
    err = "unsupported font file: " + fontPath;
    return false;
  }

  // Resolve the face index inside a (possibly .ttc) file by PostScript name.
  UINT32 faceIndex = 0;
  if (numberOfFaces > 1 && !postscriptName.empty()) {
    for (UINT32 i = 0; i < numberOfFaces; i++) {
      IDWriteFontFace* probe = nullptr;
      if (FAILED(factory->CreateFontFace(faceType, 1, &file, i, DWRITE_FONT_SIMULATIONS_NONE, &probe)) || !probe) {
        continue;
      }
      bool match = facePostScriptName(probe) == postscriptName;
      safeRelease(probe);
      if (match) { faceIndex = i; break; }
    }
  }

  IDWriteFontFace* face = nullptr;
  if (FAILED(factory->CreateFontFace(faceType, 1, &file, faceIndex, DWRITE_FONT_SIMULATIONS_NONE, &face)) || !face) {
    safeRelease(file);
    err = "could not create font face for: " + fontPath;
    return false;
  }
  safeRelease(file);  // the face holds its own reference to the file data

  // Variations (variable fonts): apply requested axis values via DirectWrite 3.
  const JsonValue& variations = spec.at("variations");
  if (variations.isObject() && variations.object && !variations.object->empty()) {
    IDWriteFontFace5* face5 = nullptr;
    if (SUCCEEDED(face->QueryInterface(__uuidof(IDWriteFontFace5), reinterpret_cast<void**>(&face5))) && face5 &&
        face5->HasVariations()) {
      IDWriteFontResource* resource = nullptr;
      if (SUCCEEDED(face5->GetFontResource(&resource)) && resource) {
        std::vector<DWRITE_FONT_AXIS_VALUE> axisValues;
        for (const auto& kv : *variations.object) {
          if (kv.first.size() != 4 || kv.second.type != JsonValue::Type::Number) continue;
          DWRITE_FONT_AXIS_VALUE v;
          v.axisTag = DWRITE_MAKE_FONT_AXIS_TAG(static_cast<BYTE>(kv.first[0]), static_cast<BYTE>(kv.first[1]),
                                                static_cast<BYTE>(kv.first[2]), static_cast<BYTE>(kv.first[3]));
          v.value = static_cast<FLOAT>(kv.second.number);
          axisValues.push_back(v);
        }
        if (!axisValues.empty()) {
          IDWriteFontFace5* varFace = nullptr;
          if (SUCCEEDED(resource->CreateFontFace(DWRITE_FONT_SIMULATIONS_NONE, axisValues.data(),
                                                 static_cast<UINT32>(axisValues.size()), &varFace)) &&
              varFace) {
            safeRelease(face);
            face = varFace;  // IDWriteFontFace5 is-a IDWriteFontFace
          }
        }
        safeRelease(resource);
      }
      safeRelease(face5);
    } else {
      safeRelease(face5);
    }
  }

  DWRITE_FONT_METRICS metrics;
  face->GetMetrics(&metrics);

  out.face = face;
  out.unitsPerEm = static_cast<int>(metrics.designUnitsPerEm);
  out.faceIndex = faceIndex;
  return true;
}

// ──────────────────────────────── queries ──────────────────────────────────

/**
 * Skia's selected-glyph color ownership, reduced to the representation name
 * Node needs at its vector/raster boundary.
 *
 * Chromium's DEPS-pinned Skia (62efacd3, SkScalerContext_win_dw.cpp
 * generateMetrics) asks these APIs BEFORE requesting an ordinary DirectWrite
 * path, in this order: COLRv1 paint tree, COLRv0 translated color run, SVG,
 * PNG. This ordering is load-bearing: GetGlyphRunOutline can return the
 * monochrome base outline for a COLR glyph, but Skia sets neverRequestPath once
 * one of these per-glyph queries succeeds. Face-wide table flags therefore
 * cannot answer this question for mixed faces such as Segoe UI Emoji.
 *
 * The interfaces are queried once per batched glyph request and passed here;
 * QueryInterface failure on an older DirectWrite runtime simply omits the
 * optional wire field, preserving the old helper contract.
 */
static const char* glyphRasterRepresentation(
    IDWriteFontFace* face,
    IDWriteFactory2* factory2,
    IDWriteFontFace4* face4,
#if DWRITE_CORE || (defined(NTDDI_WIN11_ZN) && NTDDI_VERSION >= NTDDI_WIN11_ZN)
    IDWriteFontFace7* face7,
#endif
    UINT16 glyphIndex,
    FLOAT emSize) {
  if (!face || glyphIndex == 0) return nullptr;

#if DWRITE_CORE || (defined(NTDDI_WIN11_ZN) && NTDDI_VERSION >= NTDDI_WIN11_ZN)
  // Skia generateColorV1Metrics: a successful SetCurrentGlyph with a non-NONE
  // root means this exact gid owns a COLRv1 paint tree.
  if (face7) {
    IDWritePaintReader* paintReader = nullptr;
    if (SUCCEEDED(face7->CreatePaintReader(DWRITE_GLYPH_IMAGE_FORMATS_COLR_PAINT_TREE,
                                           DWRITE_PAINT_FEATURE_LEVEL_COLR_V1,
                                           &paintReader)) && paintReader) {
      DWRITE_PAINT_ELEMENT element = {};
      D2D_RECT_F clipBox = {};
      DWRITE_PAINT_ATTRIBUTES attributes = {};
      const HRESULT hr = paintReader->SetCurrentGlyph(glyphIndex, &element, &clipBox, &attributes);
      safeRelease(paintReader);
      if (SUCCEEDED(hr) && element.paintType != DWRITE_PAINT_TYPE_NONE) return "colr";
    } else {
      safeRelease(paintReader);
    }
  }
#endif

  // Skia getColorGlyphRun / generateColorMetrics: DWRITE_E_NOCOLOR is the
  // explicit negative for this gid. Any successful translated run is COLRv0.
  if (factory2) {
    FLOAT advance = 0;
    DWRITE_GLYPH_OFFSET offset = {};
    DWRITE_GLYPH_RUN run = {};
    run.fontFace = face;
    run.fontEmSize = emSize;
    run.glyphCount = 1;
    run.glyphIndices = &glyphIndex;
    run.glyphAdvances = &advance;
    run.glyphOffsets = &offset;
    const DWRITE_MATRIX identity = {1, 0, 0, 1, 0, 0};
    IDWriteColorGlyphRunEnumerator* colorLayers = nullptr;
    const HRESULT hr = factory2->TranslateColorGlyphRun(
        0, 0, &run, nullptr, DWRITE_MEASURING_MODE_NATURAL,
        &identity, 0, &colorLayers);
    const bool hasColorRun = SUCCEEDED(hr) && colorLayers != nullptr;
    safeRelease(colorLayers);
    if (hasColorRun) return "colr";
  }

  // Skia drawSVGImage / generatePngMetrics use the exact gid and full ppem
  // range. Only SVG and PNG are consumed by this pinned backend.
  if (face4) {
    DWRITE_GLYPH_IMAGE_FORMATS formats = DWRITE_GLYPH_IMAGE_FORMATS_NONE;
    if (SUCCEEDED(face4->GetGlyphImageFormats(glyphIndex, 0, UINT32_MAX, &formats))) {
      if (formats & DWRITE_GLYPH_IMAGE_FORMATS_SVG) return "svg";
      if (formats & DWRITE_GLYPH_IMAGE_FORMATS_PNG) return "bitmap";
    }
  }
  return nullptr;
}

static std::string runGlyphsQuery(const JsonValue& query, IDWriteFactory* factory,
                                  std::map<std::string, FontEntry>& fonts) {
  std::ostringstream out;
  std::string ref = query.at("fontRef").asString();
  auto it = fonts.find(ref);
  if (it == fonts.end()) {
    return "{\"type\":\"glyphs\",\"error\":\"fontRef missing or unknown\",\"glyphs\":[]}";
  }
  IDWriteFontFace* face = it->second.face;
  // emSize = unitsPerEm makes GetGlyphRunOutline emit design-unit coordinates
  // (scale = emSize/unitsPerEm = 1), matching fontkit. Advances likewise stay in
  // design units. (Parity with the macOS helper opening at size=unitsPerEm.)
  const FLOAT emSize = static_cast<FLOAT>(it->second.unitsPerEm);

  // Match DWriteFontTypeface's fIsColorFont gate: Skia only enters the four
  // selected-glyph queries when both DirectWrite2 interfaces exist and the
  // selected face reports itself color-capable.
  IDWriteFactory2* factory2 = nullptr;
  IDWriteFontFace2* face2 = nullptr;
  bool isColorFont = false;
  if (factory && SUCCEEDED(factory->QueryInterface(__uuidof(IDWriteFactory2),
                                                   reinterpret_cast<void**>(&factory2))) && factory2 &&
      SUCCEEDED(face->QueryInterface(__uuidof(IDWriteFontFace2),
                                     reinterpret_cast<void**>(&face2))) && face2) {
    isColorFont = face2->IsColorFont() != FALSE;
  }
  IDWriteFontFace4* face4 = nullptr;
  if (isColorFont) {
    face->QueryInterface(__uuidof(IDWriteFontFace4), reinterpret_cast<void**>(&face4));
  }
#if DWRITE_CORE || (defined(NTDDI_WIN11_ZN) && NTDDI_VERSION >= NTDDI_WIN11_ZN)
  IDWriteFontFace7* face7 = nullptr;
  if (isColorFont) {
    face->QueryInterface(__uuidof(IDWriteFontFace7), reinterpret_cast<void**>(&face7));
  }
#endif

  out << "{\"type\":\"glyphs\",\"glyphs\":[";
  const JsonArray& inputs = query.at("glyphs").asArray();
  for (size_t i = 0; i < inputs.size(); i++) {
    const JsonValue& g = inputs[i];
    UINT16 glyphIndex = 0;
    if (g.has("id")) {
      glyphIndex = static_cast<UINT16>(g.at("id").asNumber());
    } else if (g.has("cp")) {
      UINT32 cp = static_cast<UINT32>(g.at("cp").asNumber());
      face->GetGlyphIndices(&cp, 1, &glyphIndex);
    }

    std::string d;
    const char* rasterRepresentation = nullptr;
    double advance = 0;
    double bx = 0, by = 0, bw = 0, bh = 0;
    if (glyphIndex != 0) {
      DWRITE_GLYPH_METRICS gm;
      if (SUCCEEDED(face->GetDesignGlyphMetrics(&glyphIndex, 1, &gm, FALSE))) {
        advance = static_cast<double>(gm.advanceWidth);  // design units (emSize == unitsPerEm)
      }
      // Preserve Skia's ownership order even though this helper still returns
      // the base outline as diagnostic/vector-fallback data: decide native
      // color/image paint for the selected gid before requesting that outline.
      if (isColorFont) {
        rasterRepresentation = glyphRasterRepresentation(
            face, factory2, face4,
#if DWRITE_CORE || (defined(NTDDI_WIN11_ZN) && NTDDI_VERSION >= NTDDI_WIN11_ZN)
            face7,
#endif
            glyphIndex, emSize);
      }
      SvgPathSink sink;
      if (SUCCEEDED(face->GetGlyphRunOutline(emSize, &glyphIndex, nullptr, nullptr, 1, FALSE, FALSE, &sink))) {
        d = sink.d;
        if (sink.maxX >= sink.minX) {
          bx = sink.minX;
          by = sink.minY;
          bw = sink.maxX - sink.minX;
          bh = sink.maxY - sink.minY;
        }
      }
    }

    if (i > 0) out << ",";
    out << "{\"id\":" << glyphIndex
        << ",\"advance\":" << formatNumber(advance)
        << ",\"bbox\":{\"x\":" << formatNumber(bx)
        << ",\"y\":" << formatNumber(by)
        << ",\"w\":" << formatNumber(bw)
        << ",\"h\":" << formatNumber(bh)
        << "},\"d\":\"" << d << "\"";
    if (rasterRepresentation) {
      out << ",\"rasterRepresentation\":\"" << rasterRepresentation << "\"";
    }
    out << "}";
  }
  out << "]}";
  safeRelease(face4);
#if DWRITE_CORE || (defined(NTDDI_WIN11_ZN) && NTDDI_VERSION >= NTDDI_WIN11_ZN)
  safeRelease(face7);
#endif
  safeRelease(face2);
  safeRelease(factory2);
  return out.str();
}

static std::string faceResolvedAxesJson(IDWriteFontFace* face);

static std::string runMetaQuery(const JsonValue& query, std::map<std::string, FontEntry>& fonts) {
  std::string ref = query.at("fontRef").asString();
  auto it = fonts.find(ref);
  if (it == fonts.end()) {
    return "{\"type\":\"meta\",\"error\":\"fontRef missing or unknown\"}";
  }
  DWRITE_FONT_METRICS m;
  it->second.face->GetMetrics(&m);

  auto hasTable = [&it](UINT32 tag) {
    const void* data = nullptr;
    UINT32 size = 0;
    void* context = nullptr;
    BOOL exists = FALSE;
    const HRESULT hr = it->second.face->TryGetFontTable(tag, &data, &size, &context, &exists);
    if (context) it->second.face->ReleaseFontTable(context);
    return SUCCEEDED(hr) && exists && size > 0;
  };

  std::ostringstream out;
  out << "{\"type\":\"meta\""
      << ",\"unitsPerEm\":" << static_cast<int>(m.designUnitsPerEm)
      << ",\"ascent\":" << static_cast<int>(m.ascent)
      // DirectWrite descent is a positive magnitude below the baseline; fontkit
      // (and the other helpers) report descent as negative.
      << ",\"descent\":" << -static_cast<int>(m.descent)
      << ",\"underlinePosition\":" << static_cast<int>(m.underlinePosition)
      << ",\"underlineThickness\":" << static_cast<int>(m.underlineThickness)
      << ",\"strikeoutPosition\":" << static_cast<int>(m.strikethroughPosition)
      << ",\"strikeoutThickness\":" << static_cast<int>(m.strikethroughThickness);
  out << ",\"supportedColorTables\":[";
  bool firstTable = true;
  struct TaggedTable { const char* name; UINT32 tag; };
  const TaggedTable colorTables[] = {
    {"sbix", DWRITE_MAKE_OPENTYPE_TAG('s','b','i','x')}, {"COLR", DWRITE_MAKE_OPENTYPE_TAG('C','O','L','R')},
    {"CPAL", DWRITE_MAKE_OPENTYPE_TAG('C','P','A','L')}, {"CBDT", DWRITE_MAKE_OPENTYPE_TAG('C','B','D','T')},
    {"CBLC", DWRITE_MAKE_OPENTYPE_TAG('C','B','L','C')}, {"SVG ", DWRITE_MAKE_OPENTYPE_TAG('S','V','G',' ')},
  };
  for (const auto& table : colorTables) {
    if (!hasTable(table.tag)) continue;
    if (!firstTable) out << ",";
    firstTable = false;
    out << "\"" << table.name << "\"";
  }
  out << "]";
  out << ",\"postscriptName\":\"" << jsonEscape(facePostScriptName(it->second.face)) << "\""
      << ",\"faceIndex\":" << it->second.faceIndex;
  const std::string resolvedAxes = faceResolvedAxesJson(it->second.face);
  if (!resolvedAxes.empty()) out << ",\"resolvedAxes\":" << resolvedAxes;
  // Exact source of DWriteFontTypeface::fontStyle().slant() in Chromium's
  // pinned Skia: IDWriteFontFace3::GetStyle() (SkTypeface_win_dw.cpp:39-58).
  // Omit the optional field when older DirectWrite lacks Face3 so Node keeps
  // its outline-derived compatibility fallback.
  IDWriteFontFace3* face3 = nullptr;
  if (SUCCEEDED(it->second.face->QueryInterface(__uuidof(IDWriteFontFace3),
                                                reinterpret_cast<void**>(&face3))) && face3) {
    out << ",\"traitItalic\":"
        << (face3->GetStyle() != DWRITE_FONT_STYLE_NORMAL ? "true" : "false");
    safeRelease(face3);
  }
  out << "}";
  return out.str();
}

// DM-1721: the RESOLVED variation-axis values of a matched font face, as JSON
// (`{"wght":400,"opsz":10.5}`), or "" when the face is not a variable-font
// instance. DirectWrite pins named optical subfamilies at fixed axis values
// ("Segoe UI Variable Text" → opsz 10.5, "Display" → opsz 36, at EVERY font
// size — it does not re-vary opsz per size), so the axis location the matcher
// resolved to is authoritative for reproducing Chrome's paint and cannot be
// derived from CSS values Node-side. Read via IDWriteFontFace5::
// GetFontAxisValues; gated on HasVariations() so static faces report nothing.
static std::string faceResolvedAxesJson(IDWriteFontFace* face) {
  if (!face) return "";
  IDWriteFontFace5* face5 = nullptr;
  if (FAILED(face->QueryInterface(__uuidof(IDWriteFontFace5), reinterpret_cast<void**>(&face5))) || !face5) {
    return "";
  }
  std::string out;
  if (face5->HasVariations()) {
    UINT32 count = face5->GetFontAxisValueCount();
    if (count > 0 && count <= 64) {
      std::vector<DWRITE_FONT_AXIS_VALUE> values(count);
      if (SUCCEEDED(face5->GetFontAxisValues(values.data(), count))) {
        std::ostringstream ss;
        ss << "{";
        bool first = true;
        for (const DWRITE_FONT_AXIS_VALUE& v : values) {
          // DWRITE_MAKE_FONT_AXIS_TAG packs the 4 tag chars low-byte-first.
          char tag[5] = {
            static_cast<char>(v.axisTag & 0xFF),
            static_cast<char>((v.axisTag >> 8) & 0xFF),
            static_cast<char>((v.axisTag >> 16) & 0xFF),
            static_cast<char>((v.axisTag >> 24) & 0xFF),
            '\0',
          };
          if (!first) ss << ",";
          first = false;
          ss << "\"" << jsonEscape(tag) << "\":" << formatNumber(static_cast<double>(v.value));
        }
        ss << "}";
        if (!first) out = ss.str();  // at least one axis emitted
      }
    }
  }
  safeRelease(face5);
  return out;
}

// DM-1864: the DWRITE style triple Blink hands `MapCharacters`, transcribed.
//
// Blink reaches DirectWrite through Skia:
// `FontCache::GetDWriteFallbackFamily` (win/font_cache_skia_win.cc:238-240)
// calls `matchFamilyStyleCharacter(..., font_description.SkiaFontStyle(), ...)`;
// Skia's `SkFontMgr_DirectWrite::onMatchFamilyStyleCharacter` wraps that
// `SkFontStyle` in `DWriteStyle` and passes its three fields straight to
// `MapCharacters` (SkFontMgr_win_dw.cpp:621-653 → :928-939), where `DWriteStyle`
// is a plain cast of weight and width plus a slant switch
// (src/utils/win/SkDWrite.h:83-97). So the values below are exactly what Chrome
// asks with — where this helper previously asked with NORMAL/NORMAL/NORMAL, i.e.
// it asked a different question and then reported the answer as Chrome's.
//
// `FontDescription::SkiaFontStyle()` (fonts/font_description.cc:477-521,
// Chromium rev 7d859f27) is the CSS→SkFontStyle conversion being mirrored:
// weight passes through when it is inside [1, 1000] and is 400 otherwise; stretch
// collapses to the nine named widths at the boundaries in
// `fonts/font_selection_types.h:221-245`; slant is upright at 0, italic up to the
// `kItalicThreshold` of 14 degrees, oblique beyond.
static DWRITE_FONT_WEIGHT dwriteWeightFromCss(double cssWeight) {
  if (cssWeight >= 1 && cssWeight <= 1000) {
    return static_cast<DWRITE_FONT_WEIGHT>(static_cast<int>(cssWeight));
  }
  return DWRITE_FONT_WEIGHT_NORMAL;  // SkFontStyle::kNormal_Weight
}

static DWRITE_FONT_STRETCH dwriteStretchFromCss(double cssStretch) {
  // Written in Blink's own cascading-if order so the boundary behavior matches:
  // each test overwrites the previous, so an exact 50 lands on ULTRA_CONDENSED
  // and an exact 200 on ULTRA_EXPANDED.
  DWRITE_FONT_STRETCH width = DWRITE_FONT_STRETCH_NORMAL;
  if (cssStretch <= 87.5) width = DWRITE_FONT_STRETCH_SEMI_CONDENSED;
  if (cssStretch <= 75) width = DWRITE_FONT_STRETCH_CONDENSED;
  if (cssStretch <= 62.5) width = DWRITE_FONT_STRETCH_EXTRA_CONDENSED;
  if (cssStretch <= 50) width = DWRITE_FONT_STRETCH_ULTRA_CONDENSED;
  if (cssStretch >= 112.5) width = DWRITE_FONT_STRETCH_SEMI_EXPANDED;
  if (cssStretch >= 125) width = DWRITE_FONT_STRETCH_EXPANDED;
  if (cssStretch >= 150) width = DWRITE_FONT_STRETCH_EXTRA_EXPANDED;
  if (cssStretch >= 200) width = DWRITE_FONT_STRETCH_ULTRA_EXPANDED;
  return width;
}

static DWRITE_FONT_STYLE dwriteSlantFromCss(double cssSlant, bool italic) {
  // `cssSlant` is the `font-style` angle Blink calls `Style()`. The renderer's
  // slant channel is an italic FLAG rather than an angle, so it sends `italic`
  // and leaves `cssSlant` at 0 — which resolves to ITALIC, matching every
  // italic-but-not-`oblique <angle>` run. A caller that does know the angle gets
  // Blink's three-way split.
  if (cssSlant > 14) return DWRITE_FONT_STYLE_OBLIQUE;  // kItalicThreshold
  if (cssSlant > 0) return DWRITE_FONT_STYLE_ITALIC;
  return italic ? DWRITE_FONT_STYLE_ITALIC : DWRITE_FONT_STYLE_NORMAL;
}

// DM-1403: per-codepoint live system-fallback resolution via DirectWrite's
// IDWriteFontFallback::MapCharacters — the same API Chrome-on-Windows
// (FontFallback::MapCharacters in font_fallback_win.cc) uses to pick the
// substitute font for a character the primary lacks. Mirrors the macOS helper's
// `runFallbackQuery` (CTFontCreateForString) byte-for-byte in protocol shape:
//   in : { type:"fallback", cps:[...], cssWeight?, italic?, cssSlant?, cssStretch?,
//          baseFamilyName?, locale? }
//   out: { type:"fallback", fonts:[ {cp,found:true,postscriptName,familyName,path} | {cp,found:false} ] }
// We pass a null base family so MapCharacters performs pure system fallback (the
// codepoint reaching here is one the primary couldn't render), and verify the
// mapped font actually covers the cp (HasCharacter) so a non-covering result is
// reported found:false — the renderer then keeps its own last-resort, matching
// the macOS LastResort handling and the Linux coverage guard.
//
// DM-1864: the style triple is now the RUN's, from the query's optional
// `cssWeight` / `italic` / `cssSlant` / `cssStretch`, converted by
// `dwriteWeightFromCss` & co. Previously it was hardcoded NORMAL/NORMAL/NORMAL
// while Blink passes `font_description.SkiaFontStyle()`, so a bold or italic run
// resolved the regular upright cut and was reported as what Chrome picked.
//
// DM-1871: the run's primary family arrives as the optional `baseFamilyName`.
//
// DM-1896: and the fallback LOCALE as the optional `locale`, which the analysis
// source reports from `GetLocaleName` (see SingleStringAnalysisSource). Node
// derives it the way Blink does; an absent field keeps the previous hardcoded
// `en-us`, so an older Node side degrades to the old behavior rather than to no
// locale at all.
//
// DM-1931: and the `IDWriteNumberSubstitution` Skia builds from that same tag
// (method NONE, `ignoreUserOverride` TRUE) and returns from the analysis
// source, where this helper used to return null —
// `createSkiaNumberSubstitution` above. When DirectWrite rejects the tag we
// mirror Skia's `HRNM`, which abandons the match: Skia returns nullptr, Blink's
// `GetDWriteFallbackFamily` turns that into `return nullptr`
// (`win/font_cache_skia_win.cc:242-244`, Chromium rev 7d859f27), and "no
// DirectWrite fallback family" is exactly what this protocol's `found:false`
// means. The query additionally reports `"numberSubstitution":"failed"` so a
// rejected tag is visible instead of looking like universal non-coverage.
//
// `onMatchFamilyStyleCharacter` calls `fallback(..., kDefaultSimulations)`;
// that mask explicitly ALLOWS DirectWrite's bold and oblique simulations
// (`SkFontMgr_win_dw.cpp:149-150,648`, Skia rev fd139e79). This differs from
// the family-style matcher, whose caller can prohibit simulations. The
// fallback loop therefore accepts either simulation here and Blink receives
// the base face plus its simulation bits.
//
// DM-1721: when the mapped face is a variable-font instance, each found entry
// additionally carries `"axes":{...}` — the axis location DirectWrite resolved
// the face to (see faceResolvedAxesJson). Node uses it to pin the
// hinting-preserving embedded subset at the SAME instance DirectWrite renders,
// instead of deriving opsz from the font size (wrong for named optical
// subfamilies, which DirectWrite pins at a fixed opsz at every size).
static std::string runFallbackQuery(const JsonValue& query, IDWriteFactory* factory) {
  std::ostringstream out;
  out << "{\"type\":\"fallback\",\"fonts\":[";

  IDWriteFactory2* factory2 = nullptr;
  IDWriteFontFallback* fallback = nullptr;
  IDWriteFontCollection* systemFonts = nullptr;
  if (factory) {
    factory->QueryInterface(__uuidof(IDWriteFactory2), reinterpret_cast<void**>(&factory2));
    if (factory2) factory2->GetSystemFontFallback(&fallback);
    factory->GetSystemFontCollection(&systemFonts, FALSE);
  }

  // DM-1864: the run's real style, not NORMAL/NORMAL/NORMAL. Absent fields keep
  // the previous defaults, so an older Node side (or a caller that has no style
  // to offer) gets exactly the pre-existing behavior.
  const DWRITE_FONT_WEIGHT dwWeight = dwriteWeightFromCss(query.at("cssWeight").asNumber(400));
  const DWRITE_FONT_STYLE dwSlant =
      dwriteSlantFromCss(query.at("cssSlant").asNumber(0), query.at("italic").asBool(false));
  const DWRITE_FONT_STRETCH dwStretch = dwriteStretchFromCss(query.at("cssStretch").asNumber(100));

  // DM-1871: the run's primary family, when the caller knows it.
  const std::wstring baseFamilyW = toWide(query.at("baseFamilyName").asString());

  // DM-1896: the run's fallback locale, when the caller knows it. Empty keeps
  // the pre-DM-1896 constant so an older Node side is unchanged rather than
  // locale-less. Only the tag DirectWrite is given matters here — see
  // `blinkWinFallbackLocale` on the Node side for how it is derived; this end
  // does no reduction of its own, deliberately, so there is exactly one place
  // the transcription lives.
  const std::string localeUtf8 = query.at("locale").asString();
  const std::wstring localeW = localeUtf8.empty() ? L"en-us" : toWide(localeUtf8);

  // DM-1931: built once per query — the tag is constant across it, and Skia
  // builds one per match from that same tag. A failure here is a property of the
  // tag, so it applies to every codepoint in the query, which is precisely how
  // Skia would fail each of them one at a time.
  HRESULT nsHr = S_OK;
  IDWriteNumberSubstitution* numberSubstitution =
      createSkiaNumberSubstitution(factory, localeW, &nsHr);
  // A null factory is a different (and already fatal) condition; only a real
  // DirectWrite rejection of the tag counts as the Skia-mirroring bail.
  const bool numberSubstitutionFailed = factory != nullptr && FAILED(nsHr);

  const JsonArray& cps = query.at("cps").asArray();
  for (size_t i = 0; i < cps.size(); i++) {
    if (i > 0) out << ",";
    uint32_t cp = static_cast<uint32_t>(cps[i].asNumber());

    bool found = false;
    std::string psName, familyName, path, axesJson;
    UINT32 mappedWeight = 0, mappedStretch = 0, mappedStyle = 0, mappedSimulations = 0;
    if (fallback && systemFonts && !numberSubstitutionFailed) {
      std::wstring s = cpToUtf16(cp);
      SingleStringAnalysisSource* source =
          new SingleStringAnalysisSource(s, localeW, numberSubstitution);
      UINT32 mappedLength = 0;
      IDWriteFont* mappedFont = nullptr;
      FLOAT scale = 1.0f;
      HRESULT hr = E_FAIL;
      // Keep Skia's loop shape, including its mutable style triple. With
      // `kDefaultSimulations`, both DirectWrite simulation bits are allowed,
      // so the first mapped face terminates it; spelling the predicate keeps
      // this transcription honest if the allowed mask ever narrows.
      DWRITE_FONT_WEIGHT mapWeight = dwWeight;
      DWRITE_FONT_STYLE mapSlant = dwSlant;
      constexpr DWRITE_FONT_SIMULATIONS allowedSimulations =
          static_cast<DWRITE_FONT_SIMULATIONS>(
              DWRITE_FONT_SIMULATIONS_BOLD | DWRITE_FONT_SIMULATIONS_OBLIQUE);
      for (int pass = 0; pass < kMaxSimulationStrips; pass++) {
        safeRelease(mappedFont);
        // DM-1871: Blink passes the RUN'S PRIMARY FAMILY as `baseFamilyName`.
        // `FontCache::GetDWriteFallbackFamily` takes
        // `font_description.Family().FamilyName()` and Skia forwards it as this
        // argument (`win/font_cache_skia_win.cc:234-240` →
        // `SkFontMgr_win_dw.cpp:653-666`, Chromium rev 7d859f27).
        //
        // It is not cosmetic: the base family is what lets that family's own font
        // linking participate in DirectWrite's answer, so passing null asks a
        // different question than Chrome asks. Absent field keeps the previous
        // nullptr behaviour, so an older Node side degrades rather than mismatches.
        hr = fallback->MapCharacters(
            source, 0, static_cast<UINT32>(s.size()), systemFonts,
            baseFamilyW.empty() ? nullptr : baseFamilyW.c_str(),
            mapWeight, mapSlant, dwStretch,
            &mappedLength, &mappedFont, &scale);
        if (FAILED(hr) || !mappedFont) break;
        DWRITE_FONT_SIMULATIONS simulations = mappedFont->GetSimulations();
        if ((simulations & ~allowedSimulations) == 0 ||
            faceHasBitmapStrikes(mappedFont)) {
          break;
        }
        if (simulations & DWRITE_FONT_SIMULATIONS_BOLD) {
          mapWeight = DWRITE_FONT_WEIGHT_REGULAR;
          continue;
        }
        if (simulations & DWRITE_FONT_SIMULATIONS_OBLIQUE) {
          mapSlant = DWRITE_FONT_STYLE_NORMAL;
          continue;
        }
        break;  // unreachable: a non-NONE mask is one of the two flags above.
      }
      if (SUCCEEDED(hr) && mappedFont && mappedLength > 0) {
        mappedWeight = static_cast<UINT32>(mappedFont->GetWeight());
        mappedStretch = static_cast<UINT32>(mappedFont->GetStretch());
        mappedStyle = static_cast<UINT32>(mappedFont->GetStyle());
        mappedSimulations = static_cast<UINT32>(mappedFont->GetSimulations());
        familyName = fontFamilyDisplayName(mappedFont);

        // Blink does not render the Skia/DirectWrite fallback typeface directly.
        // It copies that face's SkFontStyle into a FontDescription, then opens
        // the returned FAMILY again (`GetDWriteFallbackFamily`, Chromium rev
        // 7d859f27). The conversion has an observable asymmetry: only Skia
        // OBLIQUE becomes a non-normal Blink slope; Skia ITALIC becomes normal
        // (`FontDescription::UpdateFromSkiaFontStyle`, font_description.cc:553).
        // Re-run the same simulation-free family matcher used by the helper's
        // `family` query with that converted style before testing coverage.
        // This is what turns DirectWrite's Calibri-Italic / SegoeUI-Italic
        // nominations for the DM-2083 probes into Chrome's regular cuts.
        if (!familyName.empty()) {
          std::wstring mappedFamilyW = toWide(familyName);
          UINT32 familyIndex = 0;
          BOOL familyExists = FALSE;
          if (SUCCEEDED(systemFonts->FindFamilyName(mappedFamilyW.c_str(), &familyIndex,
                                                     &familyExists)) && familyExists) {
            IDWriteFontFamily* mappedFamily = nullptr;
            if (SUCCEEDED(systemFonts->GetFontFamily(familyIndex, &mappedFamily)) && mappedFamily) {
              IDWriteFont* reopened = nullptr;
              const DWRITE_FONT_STYLE blinkSlant =
                  mappedFont->GetStyle() == DWRITE_FONT_STYLE_OBLIQUE
                    ? DWRITE_FONT_STYLE_OBLIQUE
                    : DWRITE_FONT_STYLE_NORMAL;
              if (SUCCEEDED(firstMatchingFontWithoutSimulations(
                      mappedFamily, mappedFont->GetWeight(), mappedFont->GetStretch(),
                      blinkSlant, &reopened)) && reopened) {
                safeRelease(mappedFont);
                mappedFont = reopened;
              }
              safeRelease(mappedFamily);
            }
          }
        }
        BOOL covers = FALSE;
        // Coverage guard: only report a face that actually has the glyph.
        if (SUCCEEDED(mappedFont->HasCharacter(cp, &covers)) && covers) {
          IDWriteFontFace* face = nullptr;
          if (SUCCEEDED(mappedFont->CreateFontFace(&face)) && face) {
            psName = facePostScriptName(face);
            path = fontFacePath(face);
            familyName = fontFamilyDisplayName(mappedFont);
            axesJson = faceResolvedAxesJson(face);  // DM-1721: variable-instance axis pin
            if (!psName.empty() && !path.empty()) found = true;
            safeRelease(face);
          }
        }
      }
      safeRelease(mappedFont);
      source->Release();
    }

    if (found) {
      out << "{\"cp\":" << static_cast<int>(cp) << ",\"found\":true"
          << ",\"postscriptName\":\"" << jsonEscape(psName) << "\""
          << ",\"familyName\":\"" << jsonEscape(familyName) << "\""
          << ",\"path\":\"" << jsonEscape(path) << "\"";
      if (!axesJson.empty()) out << ",\"axes\":" << axesJson;  // DM-1721
      if (query.at("diagnostics").asBool(false)) {
        out << ",\"diagnostics\":{\"mappedWeight\":" << mappedWeight
            << ",\"mappedStretch\":" << mappedStretch
            << ",\"mappedStyle\":" << mappedStyle
            << ",\"mappedSimulations\":" << mappedSimulations << "}";
      }
      // Coverage, reported alongside the nomination so the caller does not ask
      // again over IPC. Unconditionally true here, and that is exact rather than
      // optimistic: `found` is only set above after `HasCharacter(cp)` succeeded
      // AND reported coverage, and nothing re-selects the face afterwards — a
      // non-covering result is already reported as `found:false`.
      //
      // Measured before this: 4.43 coverage round trips per codepoint on
      // Windows, 74% of the resolver's entire cost, every one of them re-asking
      // a question this function had already answered and discarded. Same shape
      // Linux's `fcfallback` has always had.
      out << ",\"covered\":true";
      out << "}";
    } else {
      out << "{\"cp\":" << static_cast<int>(cp) << ",\"found\":false}";
    }
  }

  safeRelease(numberSubstitution);
  safeRelease(systemFonts);
  safeRelease(fallback);
  safeRelease(factory2);
  out << "]";
  // DM-1931: only emitted on the failure path, so a normal response is byte-for
  // byte what it was and no consumer has to learn a new field to stay correct.
  if (numberSubstitutionFailed) out << ",\"numberSubstitution\":\"failed\"";
  out << "}";
  return out.str();
}

// DM-1721: CSS-family-name → installed-font resolution via the system font
// collection — the win32 implementation of the `family` query the macOS
// CoreText helper has had since DM-1018 (`CTFontCreateWithName` + name guard).
// Protocol shape matches the macOS helper:
//   in : { type:"family", name:"Segoe UI Variable Text",
//          cssWeight?, italic?, cssSlant?, cssStretch? }
//   out: { type:"family", found:true, postscriptName, familyName, path[, axes] }
//        | { type:"family", found:false }
// DirectWrite's FindFamilyName is an exact family-name lookup (no fuzzy
// substitution), so no name-match guard is needed — a miss reports
// found:false and the renderer keeps walking the CSS family stack, matching
// Blink's FontFallbackList behavior. `axes` carries the resolved axis values
// when the matched face is a variable-font instance (see faceResolvedAxesJson)
// — for named optical subfamilies ("Segoe UI Variable Text"/"Display") this is
// the ONLY correct source of the `opsz` pin, since DirectWrite pins it at the
// subfamily's fixed value at every font size.
//
// DM-1878: the CUT is chosen by the run's style, which the caller now sends as
// `cssWeight` / `italic` / `cssSlant` / `cssStretch` — the same four fields the
// `fallback` query takes, converted by the same `dwriteWeightFromCss` & co.
//
// This mirrors two DIFFERENT Blink calls with the same API, and the difference
// is the point:
//
//  - Face selection is `matchFamilyStyle(name, font_description.SkiaFontStyle())`
//    (`fonts/skia/font_cache_skia.cc:293-295`, reached from `CreateTypeface`),
//    i.e. the run's real style. On Windows that bottoms out in exactly this
//    `GetFirstMatchingFont` call, so passing NORMAL/NORMAL/NORMAL asked Chrome's
//    question with the wrong arguments: a weight-700 run resolved the regular
//    cut. It is the same omission DM-1864 fixed one call over, in `MapCharacters`.
//  - PRESENCE is `matchFamilyStyle(font_name, SkFontStyle())` — the DEFAULT
//    style — because Blink's `IsFontPresent` only asks whether the family exists
//    (`win/font_fallback_win.cc:54-59`). A caller probing presence therefore
//    sends no style fields and correctly gets the family's default face.
//
// DM-1956: and the matching call is Skia's WRAPPER, not a bare
// `GetFirstMatchingFont`. `SkFontStyleSet_DirectWrite::matchStyle` —
// where `matchFamilyStyle` bottoms out — routes through
// `FirstMatchingFontWithoutSimulations` (`SkFontMgr_win_dw.cpp:861-870` and
// `:52-92`, Skia rev fd139e79), which re-asks with the offending style axis
// reset whenever DirectWrite answers with a simulated face, so Blink receives a
// clean face and makes its own synthetic-bold/oblique decision. See
// `firstMatchingFontWithoutSimulations` above for the transcription and for why
// the loop is active in shipping Chrome.
//
// So absent fields keeping the old defaults is not merely backward compatibility;
// for the presence probe it is the transcription. (Chromium rev 7d859f27.)
// The OS's UI font family — what CSS `system-ui` resolves to on this host.
//
// Blink does not hardcode a name here. `FontCache::SystemFontFamily()` returns
// `MenuFontFamily()` (`win/font_cache_skia_win.cc:130-133`, rev 7d859f27), and
// `CreateTypeface` asserts `DCHECK_NE(family, font_family_names::kSystemUi)` —
// `system-ui` never reaches font matching as a literal name, it is replaced by
// whatever the OS reports first.
//
// The family is pushed into Blink from the browser side via
// `WebFontRendering::SetMenuFontMetrics` (`core/layout/web_font_rendering_win.cc:29`).
// The code that READS it from the OS lives outside the Blink tree and is not in
// the local checkout, so — stated rather than glossed — the Blink half of this is
// transcribed and cited, while the OS half is the standard Win32 call for the
// non-client metrics and carries no Chromium line. Asking the OS is still
// categorically better than baking in "Segoe UI", which would be correct on
// current Windows 11 and wrong by construction: a sampled literal that survives
// only until someone runs a differently-configured host.
static std::string runSystemFontQuery() {
  std::ostringstream out;
  out << "{\"type\":\"systemfont\"";
  NONCLIENTMETRICSW ncm;
  ZeroMemory(&ncm, sizeof(ncm));
  ncm.cbSize = sizeof(ncm);
  if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0)) {
    out << ",\"found\":true,\"family\":\"" << jsonEscape(fromWide(ncm.lfMenuFont.lfFaceName)) << "\"";
    // The message font too: callers may want the distinction, and it costs
    // nothing to report both from the one call.
    out << ",\"messageFamily\":\"" << jsonEscape(fromWide(ncm.lfMessageFont.lfFaceName)) << "\"";
  } else {
    out << ",\"found\":false";
  }
  out << "}";
  return out.str();
}

static std::string runFamilyQuery(const JsonValue& query, IDWriteFactory* factory) {
  std::string name = query.at("name").asString();
  const DWRITE_FONT_WEIGHT dwWeight = dwriteWeightFromCss(query.at("cssWeight").asNumber(400));
  const DWRITE_FONT_STYLE dwSlant =
      dwriteSlantFromCss(query.at("cssSlant").asNumber(0), query.at("italic").asBool(false));
  const DWRITE_FONT_STRETCH dwStretch = dwriteStretchFromCss(query.at("cssStretch").asNumber(100));
  IDWriteFontCollection* systemFonts = nullptr;
  if (factory) factory->GetSystemFontCollection(&systemFonts, FALSE);

  bool found = false;
  std::string psName, familyName, path, axesJson;
  if (systemFonts && !name.empty()) {
    std::wstring wname = toWide(name);
    UINT32 index = 0;
    BOOL exists = FALSE;
    if (SUCCEEDED(systemFonts->FindFamilyName(wname.c_str(), &index, &exists)) && exists) {
      IDWriteFontFamily* family = nullptr;
      if (SUCCEEDED(systemFonts->GetFontFamily(index, &family)) && family) {
        IDWriteFont* font = nullptr;
        if (SUCCEEDED(firstMatchingFontWithoutSimulations(family, dwWeight, dwStretch, dwSlant,
                                                          &font)) && font) {
          IDWriteFontFace* face = nullptr;
          if (SUCCEEDED(font->CreateFontFace(&face)) && face) {
            psName = facePostScriptName(face);
            path = fontFacePath(face);
            familyName = fontFamilyDisplayName(font);
            axesJson = faceResolvedAxesJson(face);
            if (!psName.empty() && !path.empty()) found = true;
            safeRelease(face);
          }
          safeRelease(font);
        }
        safeRelease(family);
      }
    }
  }
  safeRelease(systemFonts);

  std::ostringstream out;
  if (found) {
    out << "{\"type\":\"family\",\"found\":true"
        << ",\"postscriptName\":\"" << jsonEscape(psName) << "\""
        << ",\"familyName\":\"" << jsonEscape(familyName) << "\""
        << ",\"path\":\"" << jsonEscape(path) << "\"";
    if (!axesJson.empty()) out << ",\"axes\":" << axesJson;
    out << "}";
  } else {
    out << "{\"type\":\"family\",\"found\":false}";
  }
  return out.str();
}

// ──────────────────────────────── main ─────────────────────────────────────

static std::string readAll(std::istream& in) {
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

// DM-1035: stable cache key for an opened font, so `--serve` mode reuses the
// IDWriteFontFace across requests instead of re-opening (face creation +
// DirectWrite init is the dominant per-spawn cost). Mirrors the macOS / Linux
// helpers' `fontCacheKey`: postscriptName | fontPath | size | sorted variation
// axes. DirectWrite renders outlines at emSize = unitsPerEm regardless of the
// request `size`, so `size` never affects the outline, but it's kept in the key
// for parity with the cross-platform contract.
static std::string fontCacheKey(const JsonValue& spec) {
  std::string ps = spec.at("postscriptName").asString();
  std::string fp = spec.at("fontPath").asString();
  std::string sz = spec.has("size") ? formatNumber(spec.at("size").asNumber(16)) : "16";
  std::string varKey;
  const JsonValue& variations = spec.at("variations");
  if (variations.isObject() && variations.object) {
    bool first = true;
    for (const auto& kv : *variations.object) {
      if (!first) varKey += ",";
      first = false;
      varKey += kv.first + "=" +
                (kv.second.type == JsonValue::Type::Number ? formatNumber(kv.second.number) : std::string());
    }
  }
  return ps + "|" + fp + "|" + sz + "|" + varKey;
}

// Run one request envelope into its JSON response string, opening (or reusing,
// via `fontCache`) the declared fonts and dispatching each query. `dieOnOpenFail`
// preserves the one-shot CLI's fatal contract; `--serve` passes false so a
// malformed envelope yields a per-query error without taking down the loop.
// Faces are owned by `fontCache` and released by the caller — never here — so a
// cached face survives across envelopes (and isn't double-released).
static std::string handleEnvelope(IDWriteFactory* factory, const JsonValue& envelope,
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
    if (openFont(factory, spec, entry, err)) {
      fontCache[key] = entry;
      fonts[ref] = entry;
    } else if (dieOnOpenFail) {
      die(err);
    }
    // On open failure in serve mode the ref is simply absent; queries
    // referencing it report "fontRef missing or unknown" (matching macOS/Linux).
  }

  std::ostringstream response;
  response << "{\"results\":[";
  const JsonArray& queries = envelope.at("queries").asArray();
  for (size_t i = 0; i < queries.size(); i++) {
    if (i > 0) response << ",";
    const std::string type = queries[i].at("type").asString();
    if (type == "glyphs") {
      response << runGlyphsQuery(queries[i], factory, fonts);
    } else if (type == "meta") {
      response << runMetaQuery(queries[i], fonts);
    } else if (type == "fallback") {
      response << runFallbackQuery(queries[i], factory);  // DM-1403: DirectWrite MapCharacters
    } else if (type == "systemfont") {
      response << runSystemFontQuery();   // DM-1881: the OS UI font family (system-ui)
    } else if (type == "family") {
      response << runFamilyQuery(queries[i], factory);    // DM-1721: system-collection family lookup
    } else {
      response << "{\"type\":\"" << jsonEscape(type) << "\",\"error\":\"unknown query type\"}";
    }
  }
  response << "]}";
  return response.str();
}

// Pipe buffer, and the read chunk. Sized to hold a whole typical response so a
// batched `fallback` answer for thousands of codepoints comes back in one or two
// reads; correctness does not depend on it, since both ends loop.
static const DWORD kPipeBufBytes = 1u << 20;

// Persistent serve over a NAMED PIPE rather than stdin/stdout.
//
// Why this exists at all, given `--serve` already works: the transport is fine,
// but the parent cannot drive it on Windows. Node exposes a spawned pipe as fd
// `-1` — no real OS file descriptor — and the parent's channel is synchronous
// `readSync`/`writeSync`, which need one. So the Windows parent had to fall back
// to spawning this binary fresh for every call. Measured at ~59 ms per spawn
// even for a request that does no work, which made the conformance sweep's
// Windows shards ~20x slower per codepoint than the macOS ones and the long pole
// of every three-platform run.
//
// A named pipe fixes it from this side: the parent opens the path with
// `fs.openSync`, which DOES yield a real fd, and its existing synchronous loop
// then drives the channel unchanged. We are the SERVER because only the server
// end can be created by name; the parent connects as a client.
//
// The protocol, the font cache and the responses are byte-for-byte what
// `--serve` produces — this only swaps the bytes' carrier. A parent whose binary
// predates this flag sees the child die on the unknown argument, never manages
// to open the path, and reverts to one-shot spawning, so an old helper degrades
// rather than hangs.
static int servePipe(IDWriteFactory* factory, const std::string& pipeName) {
  std::wstring wname(pipeName.begin(), pipeName.end());
  // PIPE_TYPE_BYTE, not MESSAGE: the framing is the protocol's own trailing
  // newline, exactly as over stdio. Message mode would impose a second framing
  // on top and truncate any response larger than one message buffer.
  HANDLE h = CreateNamedPipeW(
      wname.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1, kPipeBufBytes, kPipeBufBytes, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    std::cerr << "could not create named pipe: " << pipeName << "\n";
    return 1;
  }
  // The parent may connect between CreateNamedPipe and here, which surfaces as
  // ERROR_PIPE_CONNECTED rather than success. That is a connected client, not a
  // failure.
  if (!ConnectNamedPipe(h, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) {
    CloseHandle(h);
    return 1;
  }

  std::map<std::string, FontEntry> fontCache;
  std::string buf;
  std::vector<char> chunk(kPipeBufBytes);
  bool running = true;

  while (running) {
    size_t nl = buf.find('\n');
    while (nl == std::string::npos) {
      DWORD got = 0;
      // A closed client end reports ERROR_BROKEN_PIPE; both that and a zero-byte
      // read mean the parent is gone, which ends the session the way EOF on
      // stdin ends the `--serve` loop.
      if (!ReadFile(h, chunk.data(), static_cast<DWORD>(chunk.size()), &got, nullptr) || got == 0) {
        running = false;
        break;
      }
      buf.append(chunk.data(), got);
      nl = buf.find('\n');
    }
    if (!running) break;

    std::string line = buf.substr(0, nl);
    buf.erase(0, nl + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;

    JsonValue envelope;
    std::string resp;
    if (!JsonParser(line).parse(envelope) || !envelope.isObject()) {
      resp = "{\"results\":[],\"error\":\"invalid JSON on input line\"}\n";
    } else {
      resp = handleEnvelope(factory, envelope, fontCache, /*dieOnOpenFail=*/false) + "\n";
    }

    // WriteFile is not obliged to take the whole buffer, and a short write would
    // desync the parent's line framing for every subsequent response.
    size_t off = 0;
    while (off < resp.size()) {
      DWORD wrote = 0;
      if (!WriteFile(h, resp.data() + off, static_cast<DWORD>(resp.size() - off), &wrote, nullptr)) {
        running = false;
        break;
      }
      off += wrote;
    }
  }

  for (auto& kv : fontCache) safeRelease(kv.second.face);
  FlushFileBuffers(h);
  DisconnectNamedPipe(h);
  CloseHandle(h);
  return 0;
}

int main(int argc, char** argv) {
  // Force LF-only binary stdio (DM-1035): Windows defaults stdin/stdout to text
  // mode, which translates CRLF↔LF. On the line-delimited `--serve` protocol that
  // would inject stray CRs and desync framing; it would also make serve output
  // differ from one-shot. Binary mode emits `…}\n` verbatim in both modes, so
  // serve responses stay byte-identical to one-shot. (The win32 test parses JSON,
  // not raw bytes, so this doesn't change the one-shot contract.)
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  std::string inputPath;
  std::string servePipeName;
  bool serve = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--version") {
      std::cout << "domotion-glyph-paths (win32/directwrite) 0.7.0\n";
      return 0;
    }
    if (a == "--help" || a == "-h") {
      std::cout << "Usage: domotion-glyph-paths.exe [--input <path>] [--serve]\n"
                   "                                [--serve-pipe <\\\\.\\pipe\\name>]\n"
                   "Reads a JSON request envelope from stdin (default) or the given file.\n"
                   "Writes a JSON response to stdout.\n"
                   "--serve: persistent mode — read one request envelope per line on stdin,\n"
                   "         write one response per line on stdout, looping until EOF, reusing\n"
                   "         opened fonts across requests (DM-1035).\n"
                   "--serve-pipe: the same persistent protocol over a named pipe this process\n"
                   "         creates and the parent connects to. Windows parents use this\n"
                   "         because a spawned stdio pipe has no OS fd there, so their\n"
                   "         synchronous channel cannot drive --serve.\n";
      return 0;
    }
    if (a == "--serve") {
      serve = true;
    } else if (a == "--serve-pipe") {
      if (i + 1 >= argc) die("--serve-pipe requires a pipe name");
      servePipeName = argv[++i];
    } else if (a == "--input") {
      if (i + 1 >= argc) die("--input requires a path");
      inputPath = argv[++i];
    } else {
      die("unknown argument: " + a);
    }
  }

  IDWriteFactory* factory = nullptr;
  if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                 reinterpret_cast<IUnknown**>(&factory))) ||
      !factory) {
    die("DWriteCreateFactory failed");
  }

  if (!servePipeName.empty()) return servePipe(factory, servePipeName);

  if (serve) {
    // DM-1035: persistent server. One request envelope per line in, one
    // response per line out. Faces opened once are reused for the process
    // lifetime via `fontCache`. A malformed line yields an error response but
    // does not stop the loop; EOF (the parent closing stdin) ends it. stdout is
    // a pipe here (fully buffered by default), so flush after every response or
    // the parent's synchronous read blocks forever waiting on buffered bytes.
    std::map<std::string, FontEntry> fontCache;
    std::string line;
    while (std::getline(std::cin, line)) {
      // A Windows parent may send CRLF-terminated lines; std::getline strips the
      // LF but leaves the CR — drop it so the JSON parse sees clean bytes.
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      JsonValue envelope;
      if (!JsonParser(line).parse(envelope) || !envelope.isObject()) {
        std::cout << "{\"results\":[],\"error\":\"invalid JSON on input line\"}\n" << std::flush;
        continue;
      }
      std::cout << handleEnvelope(factory, envelope, fontCache, /*dieOnOpenFail=*/false)
                << "\n" << std::flush;
    }
    for (auto& kv : fontCache) safeRelease(kv.second.face);
    safeRelease(factory);
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
  std::string response = handleEnvelope(factory, envelope, fontCache, /*dieOnOpenFail=*/true);

  for (auto& kv : fontCache) safeRelease(kv.second.face);
  safeRelease(factory);

  std::cout << response << "\n";
  return 0;
}
