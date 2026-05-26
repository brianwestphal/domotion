# Reproducible Linux build for the glyph extractor.
#
# The release workflow builds this binary directly on an ubuntu-22.04 GitHub
# runner; this Dockerfile reproduces that build locally (or on a non-Ubuntu
# host) so you can rebuild `domotion-glyph-paths` without a local FreeType
# toolchain.
#
# The base image fixes the glibc floor — glibc stays dynamically linked, so the
# binary runs on any distro with that glibc or newer. ubuntu:22.04 (glibc 2.35)
# covers all currently supported mainstream distros and matches the release
# runner. FreeType is linked dynamically (libfreetype.so.6 is always present
# alongside Chromium — see CMakeLists.txt).
#
# Usage (from this directory):
#   docker build -t domotion-linux-glyph-build .
#   cid=$(docker create domotion-linux-glyph-build) \
#     && docker cp "$cid":/out/domotion-glyph-paths . \
#     && docker rm "$cid"
FROM ubuntu:22.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config libfreetype-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j \
    && mkdir -p /out && cp build/domotion-glyph-paths /out/domotion-glyph-paths \
    && strip /out/domotion-glyph-paths

CMD ["sh", "-c", "echo 'binary at /out/domotion-glyph-paths'"]
