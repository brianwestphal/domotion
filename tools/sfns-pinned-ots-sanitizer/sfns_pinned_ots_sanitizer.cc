// Evidence-only wrapper around the exact OTS context used by pinned Blink's
// WebFontDecoder. This binary sanitizes one input independently; it is never
// linked into production Domotion or Chromium.
#include "third_party/ots/src/include/opentype-sanitiser.h"
#include "third_party/ots/src/include/ots-memory-stream.h"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

namespace {
constexpr size_t kMaxDecodedBytes = 128u * 1024u * 1024u;

class ChromiumExactContext final : public ots::OTSContext {
 public:
  ots::TableAction GetTableAction(uint32_t tag) override {
    switch (tag) {
      case OTS_TAG('C', 'B', 'D', 'T'):
      case OTS_TAG('C', 'B', 'L', 'C'):
      case OTS_TAG('E', 'B', 'D', 'T'):
      case OTS_TAG('E', 'B', 'L', 'C'):
      case OTS_TAG('C', 'O', 'L', 'R'):
      case OTS_TAG('C', 'P', 'A', 'L'):
      case OTS_TAG('C', 'F', 'F', '2'):
      case OTS_TAG('s', 'b', 'i', 'x'):
      case OTS_TAG('S', 'T', 'A', 'T'):
      case OTS_TAG('a', 'v', 'a', 'r'):
      case OTS_TAG('B', 'A', 'S', 'E'):
      case OTS_TAG('c', 'v', 'a', 'r'):
      case OTS_TAG('f', 'v', 'a', 'r'):
      case OTS_TAG('g', 'v', 'a', 'r'):
      case OTS_TAG('H', 'V', 'A', 'R'):
      case OTS_TAG('M', 'V', 'A', 'R'):
      case OTS_TAG('V', 'V', 'A', 'R'):
      case OTS_TAG('G', 'D', 'E', 'F'):
      case OTS_TAG('G', 'P', 'O', 'S'):
      case OTS_TAG('G', 'S', 'U', 'B'):
        return ots::TABLE_ACTION_PASSTHRU;
      default:
        return ots::TABLE_ACTION_DEFAULT;
    }
  }
};

std::vector<uint8_t> readFile(const char* path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) return {};
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(input), {});
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: sfns_pinned_ots_sanitizer INPUT OUTPUT\n";
    return 2;
  }
  const std::vector<uint8_t> input = readFile(argv[1]);
  if (input.empty()) {
    std::cerr << "input font is missing or empty\n";
    return 2;
  }
  ots::ExpandingMemoryStream output(input.size(), kMaxDecodedBytes);
  ChromiumExactContext context;
  if (!context.Process(&output, input.data(), input.size())) {
    std::cerr << "pinned Chromium OTS rejected the input\n";
    return 1;
  }
  const size_t outputSize = static_cast<size_t>(output.Tell());
  std::ofstream file(argv[2], std::ios::binary | std::ios::trunc);
  if (!file) {
    std::cerr << "could not open output\n";
    return 2;
  }
  file.write(static_cast<const char*>(output.get()), outputSize);
  if (!file) {
    std::cerr << "could not write output\n";
    return 2;
  }
  std::cout << outputSize << '\n';
  return 0;
}
