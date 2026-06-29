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
};

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
// string, the input IDWriteFontFallback::MapCharacters requires. Locale is
// en-us, LTR, no number substitution — we feed it one codepoint at a time.
class SingleStringAnalysisSource : public IDWriteTextAnalysisSource {
 public:
  explicit SingleStringAnalysisSource(std::wstring text) : text_(std::move(text)) {}
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
    if (r == 0) delete this;
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
    *name = L"en-us";
    *len = static_cast<UINT32>(text_.size() - (pos < text_.size() ? pos : text_.size()));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetNumberSubstitution(UINT32 pos, UINT32* len, IDWriteNumberSubstitution** ns) override {
    *ns = nullptr;
    *len = static_cast<UINT32>(text_.size() - (pos < text_.size() ? pos : text_.size()));
    return S_OK;
  }

 private:
  std::wstring text_;
  ULONG ref_ = 1;
};

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
  return true;
}

// ──────────────────────────────── queries ──────────────────────────────────

static std::string runGlyphsQuery(const JsonValue& query, std::map<std::string, FontEntry>& fonts) {
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
    double advance = 0;
    double bx = 0, by = 0, bw = 0, bh = 0;
    if (glyphIndex != 0) {
      DWRITE_GLYPH_METRICS gm;
      if (SUCCEEDED(face->GetDesignGlyphMetrics(&glyphIndex, 1, &gm, FALSE))) {
        advance = static_cast<double>(gm.advanceWidth);  // design units (emSize == unitsPerEm)
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
  DWRITE_FONT_METRICS m;
  it->second.face->GetMetrics(&m);

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
      << ",\"strikeoutThickness\":" << static_cast<int>(m.strikethroughThickness)
      << "}";
  return out.str();
}

// DM-1403: per-codepoint live system-fallback resolution via DirectWrite's
// IDWriteFontFallback::MapCharacters — the same API Chrome-on-Windows
// (FontFallback::MapCharacters in font_fallback_win.cc) uses to pick the
// substitute font for a character the primary lacks. Mirrors the macOS helper's
// `runFallbackQuery` (CTFontCreateForString) byte-for-byte in protocol shape:
//   in : { type:"fallback", cps:[...] }
//   out: { type:"fallback", fonts:[ {cp,found:true,postscriptName,familyName,path} | {cp,found:false} ] }
// We pass a null base family so MapCharacters performs pure system fallback (the
// codepoint reaching here is one the primary couldn't render), and verify the
// mapped font actually covers the cp (HasCharacter) so a non-covering result is
// reported found:false — the renderer then keeps its own last-resort, matching
// the macOS LastResort handling and the Linux coverage guard.
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

  const JsonArray& cps = query.at("cps").asArray();
  for (size_t i = 0; i < cps.size(); i++) {
    if (i > 0) out << ",";
    uint32_t cp = static_cast<uint32_t>(cps[i].asNumber());

    bool found = false;
    std::string psName, familyName, path;
    if (fallback && systemFonts) {
      std::wstring s = cpToUtf16(cp);
      SingleStringAnalysisSource* source = new SingleStringAnalysisSource(s);
      UINT32 mappedLength = 0;
      IDWriteFont* mappedFont = nullptr;
      FLOAT scale = 1.0f;
      HRESULT hr = fallback->MapCharacters(
          source, 0, static_cast<UINT32>(s.size()), systemFonts,
          nullptr,  // null base family → pure system fallback
          DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL,
          &mappedLength, &mappedFont, &scale);
      if (SUCCEEDED(hr) && mappedFont && mappedLength > 0) {
        BOOL covers = FALSE;
        // Coverage guard: only report a face that actually has the glyph.
        if (SUCCEEDED(mappedFont->HasCharacter(cp, &covers)) && covers) {
          IDWriteFontFace* face = nullptr;
          if (SUCCEEDED(mappedFont->CreateFontFace(&face)) && face) {
            psName = facePostScriptName(face);
            path = fontFacePath(face);
            familyName = fontFamilyDisplayName(mappedFont);
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
          << ",\"path\":\"" << jsonEscape(path) << "\"}";
    } else {
      out << "{\"cp\":" << static_cast<int>(cp) << ",\"found\":false}";
    }
  }

  safeRelease(systemFonts);
  safeRelease(fallback);
  safeRelease(factory2);
  out << "]}";
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
      response << runGlyphsQuery(queries[i], fonts);
    } else if (type == "meta") {
      response << runMetaQuery(queries[i], fonts);
    } else if (type == "fallback") {
      response << runFallbackQuery(queries[i], factory);  // DM-1403: DirectWrite MapCharacters
    } else {
      response << "{\"type\":\"" << jsonEscape(type) << "\",\"error\":\"unknown query type\"}";
    }
  }
  response << "]}";
  return response.str();
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
  bool serve = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--version") {
      std::cout << "domotion-glyph-paths (win32/directwrite) 0.1.0\n";
      return 0;
    }
    if (a == "--help" || a == "-h") {
      std::cout << "Usage: domotion-glyph-paths.exe [--input <path>] [--serve]\n"
                   "Reads a JSON request envelope from stdin (default) or the given file.\n"
                   "Writes a JSON response to stdout.\n"
                   "--serve: persistent mode — read one request envelope per line on stdin,\n"
                   "         write one response per line on stdout, looping until EOF, reusing\n"
                   "         opened fonts across requests (DM-1035).\n";
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

  IDWriteFactory* factory = nullptr;
  if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                 reinterpret_cast<IUnknown**>(&factory))) ||
      !factory) {
    die("DWriteCreateFactory failed");
  }

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
