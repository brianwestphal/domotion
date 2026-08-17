#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <unicode/uchar.h>
#include <unicode/udata.h>
#include <unicode/uscript.h>
#include <unicode/uversion.h>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#else
#include <unistd.h>
#endif

namespace {

constexpr const char* kProtocolVersion = "1";
constexpr const char* kExpectedIcuVersion = "78.2";
std::vector<char> gIcuData;

std::filesystem::path executablePath() {
#if defined(_WIN32)
  std::wstring path(32768, L'\0');
  const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  path.resize(size);
  return path;
#elif defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0) return {};
  path.resize(std::char_traits<char>::length(path.c_str()));
  return std::filesystem::weakly_canonical(path);
#else
  std::vector<char> path(4096);
  const ssize_t size = readlink("/proc/self/exe", path.data(), path.size() - 1);
  if (size <= 0) return {};
  return std::string(path.data(), static_cast<size_t>(size));
#endif
}

bool installIcuData() {
  const char* overridePath = std::getenv("DOMOTION_ICU_DATA");
  const auto path = overridePath && *overridePath
      ? std::filesystem::path(overridePath)
      : executablePath().parent_path() / "icudtl.dat";
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input) {
    std::cerr << "domotion-icu: data file unavailable: " << path << "\n";
    return false;
  }
  const auto size = input.tellg();
  if (size <= 0) return false;
  gIcuData.resize(static_cast<size_t>(size));
  input.seekg(0);
  if (!input.read(gIcuData.data(), size)) return false;
  UErrorCode status = U_ZERO_ERROR;
  udata_setCommonData(gIcuData.data(), &status);
  if (U_FAILURE(status)) {
    std::cerr << "domotion-icu: udata_setCommonData failed: " << u_errorName(status) << "\n";
    return false;
  }
  return true;
}

std::string quote(const char* value) {
  if (!value) return "\"\"";
  std::ostringstream out;
  out << '"';
  for (const unsigned char c : std::string(value)) {
    if (c == '"' || c == '\\') out << '\\' << c;
    else if (c >= 0x20) out << c;
  }
  out << '"';
  return out.str();
}

std::vector<uint32_t> parseCodepoints(const std::string& json) {
  std::vector<uint32_t> cps;
  const auto key = json.find("\"cps\"");
  if (key == std::string::npos) return cps;
  auto pos = json.find('[', key);
  const auto end = pos == std::string::npos ? pos : json.find(']', pos);
  if (pos == std::string::npos || end == std::string::npos) return cps;
  ++pos;
  while (pos < end) {
    while (pos < end && (std::isspace(static_cast<unsigned char>(json[pos])) || json[pos] == ',')) ++pos;
    if (pos >= end || !std::isdigit(static_cast<unsigned char>(json[pos]))) break;
    char* tail = nullptr;
    const unsigned long value = std::strtoul(json.c_str() + pos, &tail, 10);
    if (tail == json.c_str() + pos) break;
    cps.push_back(static_cast<uint32_t>(value));
    pos = static_cast<size_t>(tail - json.c_str());
  }
  return cps;
}

uint32_t binaryProperties(UChar32 cp) {
  uint32_t bits = 0;
  if (u_hasBinaryProperty(cp, UCHAR_IDEOGRAPHIC)) bits |= 1u << 0;
  if (u_hasBinaryProperty(cp, UCHAR_DEFAULT_IGNORABLE_CODE_POINT)) bits |= 1u << 1;
  if (u_hasBinaryProperty(cp, UCHAR_GRAPHEME_EXTEND)) bits |= 1u << 2;
  if (u_hasBinaryProperty(cp, UCHAR_EMOJI)) bits |= 1u << 3;
  if (u_hasBinaryProperty(cp, UCHAR_EMOJI_PRESENTATION)) bits |= 1u << 4;
  if (u_hasBinaryProperty(cp, UCHAR_EMOJI_MODIFIER_BASE)) bits |= 1u << 5;
  if (u_hasBinaryProperty(cp, UCHAR_EMOJI_COMPONENT)) bits |= 1u << 6;
  if (u_hasBinaryProperty(cp, UCHAR_EXTENDED_PICTOGRAPHIC)) bits |= 1u << 7;
  return bits;
}

std::string rowJson(uint32_t rawCp) {
  if (rawCp > 0x10ffff)
    return "{\"cp\":" + std::to_string(rawCp) + ",\"found\":false}";
  const UChar32 cp = static_cast<UChar32>(rawCp);
  const int32_t script = u_getIntPropertyValue(cp, UCHAR_SCRIPT);
  const int32_t block = ublock_getCode(cp);
  UScriptCode scripts[32] = {};
  UErrorCode status = U_ZERO_ERROR;
  int32_t scriptCount = uscript_getScriptExtensions(cp, scripts, 32, &status);
  if (U_FAILURE(status) && status != U_BUFFER_OVERFLOW_ERROR) scriptCount = 0;
  scriptCount = std::clamp(scriptCount, 0, 32);

  std::ostringstream out;
  out << "{\"cp\":" << rawCp << ",\"found\":true"
      << ",\"generalCategory\":" << static_cast<int32_t>(u_charType(cp))
      << ",\"generalCategoryName\":" << quote(u_getPropertyValueName(
             UCHAR_GENERAL_CATEGORY, u_charType(cp), U_LONG_PROPERTY_NAME))
      << ",\"combiningClass\":" << static_cast<int32_t>(u_getCombiningClass(cp))
      << ",\"script\":" << script
      << ",\"scriptName\":" << quote(uscript_getShortName(static_cast<UScriptCode>(script)))
      << ",\"scriptLongName\":" << quote(uscript_getName(static_cast<UScriptCode>(script)))
      << ",\"block\":" << block
      << ",\"blockName\":" << quote(u_getPropertyValueName(UCHAR_BLOCK, block, U_LONG_PROPERTY_NAME))
      << ",\"bidiClass\":" << u_getIntPropertyValue(cp, UCHAR_BIDI_CLASS)
      << ",\"bidiPairedBracketType\":" << u_getIntPropertyValue(cp, UCHAR_BIDI_PAIRED_BRACKET_TYPE)
      << ",\"eastAsianWidth\":" << u_getIntPropertyValue(cp, UCHAR_EAST_ASIAN_WIDTH)
      << ",\"indicPositionalCategory\":" << u_getIntPropertyValue(cp, UCHAR_INDIC_POSITIONAL_CATEGORY)
      << ",\"indicSyllabicCategory\":" << u_getIntPropertyValue(cp, UCHAR_INDIC_SYLLABIC_CATEGORY)
      << ",\"lineBreak\":" << u_getIntPropertyValue(cp, UCHAR_LINE_BREAK)
      << ",\"verticalOrientation\":" << u_getIntPropertyValue(cp, UCHAR_VERTICAL_ORIENTATION)
      << ",\"binaryProperties\":" << binaryProperties(cp)
      << ",\"scriptExtensions\":[";
  for (int32_t i = 0; i < scriptCount; ++i) {
    if (i) out << ',';
    out << static_cast<int32_t>(scripts[i]);
  }
  out << "],\"scriptExtensionNames\":[";
  for (int32_t i = 0; i < scriptCount; ++i) {
    if (i) out << ',';
    out << quote(uscript_getShortName(scripts[i]));
  }
  out << "]}";
  return out.str();
}

std::string responseJson(const std::string& request) {
  UVersionInfo unicodeInfo;
  char unicodeVersion[U_MAX_VERSION_STRING_LENGTH] = {};
  u_getUnicodeVersion(unicodeInfo);
  u_versionToString(unicodeInfo, unicodeVersion);
  const auto cps = parseCodepoints(request);
  std::ostringstream out;
  out << "{\"protocolVersion\":\"" << kProtocolVersion
      << "\",\"icuVersion\":" << quote(U_ICU_VERSION)
      << ",\"unicodeVersion\":" << quote(unicodeVersion)
      << ",\"properties\":[";
  for (size_t i = 0; i < cps.size(); ++i) {
    if (i) out << ',';
    out << rowJson(cps[i]);
  }
  out << "]}";
  return out.str();
}

void digestWord(uint64_t& hash, uint32_t value) {
  for (int i = 0; i < 4; ++i) {
    hash ^= static_cast<uint8_t>(value >> (i * 8));
    hash *= UINT64_C(1099511628211);
  }
}

std::string propertyDigestJson() {
  uint64_t hash = UINT64_C(14695981039346656037);
  uint64_t assigned = 0;
  for (uint32_t rawCp = 0; rawCp <= 0x10ffff; ++rawCp) {
    const UChar32 cp = static_cast<UChar32>(rawCp);
    const auto category = static_cast<uint32_t>(u_charType(cp));
    if (category != U_UNASSIGNED) ++assigned;
    digestWord(hash, rawCp);
    digestWord(hash, category);
    digestWord(hash, static_cast<uint32_t>(u_getCombiningClass(cp)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_SCRIPT)));
    digestWord(hash, static_cast<uint32_t>(ublock_getCode(cp)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_BIDI_CLASS)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_BIDI_PAIRED_BRACKET_TYPE)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_EAST_ASIAN_WIDTH)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_INDIC_POSITIONAL_CATEGORY)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_INDIC_SYLLABIC_CATEGORY)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_LINE_BREAK)));
    digestWord(hash, static_cast<uint32_t>(u_getIntPropertyValue(cp, UCHAR_VERTICAL_ORIENTATION)));
    digestWord(hash, binaryProperties(cp));
    UScriptCode scripts[32] = {};
    UErrorCode status = U_ZERO_ERROR;
    int32_t count = uscript_getScriptExtensions(cp, scripts, 32, &status);
    if (U_FAILURE(status) && status != U_BUFFER_OVERFLOW_ERROR) count = 0;
    count = std::clamp(count, 0, 32);
    digestWord(hash, static_cast<uint32_t>(count));
    for (int32_t i = 0; i < count; ++i) digestWord(hash, static_cast<uint32_t>(scripts[i]));
  }
  std::ostringstream hex;
  hex << std::hex << hash;
  return "{\"protocolVersion\":\"" + std::string(kProtocolVersion) +
      "\",\"icuVersion\":\"" + U_ICU_VERSION +
      "\",\"codepoints\":1114112,\"assigned\":" + std::to_string(assigned) +
      ",\"fnv1a64\":\"" + hex.str() + "\"}";
}

}  // namespace

int main(int argc, char** argv) {
  if (std::string(U_ICU_VERSION) != kExpectedIcuVersion) {
    std::cerr << "domotion-icu: built against ICU " << U_ICU_VERSION
              << ", expected " << kExpectedIcuVersion << "\n";
    return 2;
  }
  if (argc > 1 && std::string(argv[1]) == "--version") {
    std::cout << "domotion-icu " << kProtocolVersion << " ICU " << U_ICU_VERSION << "\n";
    return 0;
  }
  if (!installIcuData()) return 3;
  if (argc > 1 && std::string(argv[1]) == "--digest") {
    std::cout << propertyDigestJson() << '\n';
    return 0;
  }
  if (argc > 1 && std::string(argv[1]) == "--serve") {
    std::string line;
    while (std::getline(std::cin, line)) {
      std::cout << responseJson(line) << '\n' << std::flush;
    }
    return 0;
  }
  std::ostringstream input;
  input << std::cin.rdbuf();
  std::cout << responseJson(input.str()) << '\n';
  return 0;
}
