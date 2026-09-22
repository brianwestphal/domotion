cmake_minimum_required(VERSION 3.16)
project(domotion_glyph_paths CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O2")

add_executable(domotion-glyph-paths src/main.cpp)

# FreeType — required, linked dynamically against libfreetype.so.6.
#
# Why dynamic (not static): the helper only ever runs in an environment that
# also runs Domotion's Playwright Chromium, and Chromium-on-Linux requires
# system FreeType (libfreetype6 is part of `npx playwright install-deps`). So
# libfreetype.so.6 is always present wherever this binary is used, and its
# SONAME is ABI-stable across versions. A static build would need libfreetype.a
# (not shipped by mainstream distros — it would mean building FreeType from
# source) for no real portability gain. See docs/45-linux-glyph-extraction.md.
#
# Prefer pkg-config (correct include dirs across Debian/Arch/Fedora layouts);
# fall back to CMake's FindFreetype.
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
  pkg_check_modules(FREETYPE QUIET freetype2)
endif()

if(FREETYPE_FOUND)
  target_include_directories(domotion-glyph-paths PRIVATE ${FREETYPE_INCLUDE_DIRS})
  target_link_directories(domotion-glyph-paths PRIVATE ${FREETYPE_LIBRARY_DIRS})
  target_link_libraries(domotion-glyph-paths PRIVATE ${FREETYPE_LIBRARIES})
else()
  find_package(Freetype REQUIRED)
  target_link_libraries(domotion-glyph-paths PRIVATE Freetype::Freetype)
endif()

# DM-1886: fontconfig backs the `fcfallback` query — Chrome's own per-codepoint
# Linux fallback is `FcFontSort` + walk-until-covered (`ui/gfx/font_fallback_linux.cc`),
# not the `fc-match` CLI we used to spawn per codepoint. REQUIRED rather than
# optional: fontconfig is a hard dependency of every Linux distro we target and
# of the Playwright container, and a helper silently built without it would
# answer "unknown query type" — which the Node side would read as "no helper"
# and quietly fall back to the slow, non-equivalent CLI path. Failing the build
# is the honest outcome.
if(PkgConfig_FOUND)
  pkg_check_modules(FONTCONFIG QUIET fontconfig)
endif()
if(FONTCONFIG_FOUND)
  target_include_directories(domotion-glyph-paths PRIVATE ${FONTCONFIG_INCLUDE_DIRS})
  target_link_directories(domotion-glyph-paths PRIVATE ${FONTCONFIG_LIBRARY_DIRS})
  target_link_libraries(domotion-glyph-paths PRIVATE ${FONTCONFIG_LIBRARIES})
else()
  find_package(Fontconfig REQUIRED)
  target_link_libraries(domotion-glyph-paths PRIVATE Fontconfig::Fontconfig)
endif()
