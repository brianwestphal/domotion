cmake_minimum_required(VERSION 3.16)

# CMP0091 (NEW): select the MSVC runtime via MSVC_RUNTIME_LIBRARY below.
cmake_policy(SET CMP0091 NEW)

project(domotion_glyph_paths CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(domotion-glyph-paths src/main.cpp)

# DirectWrite (dwrite.lib) ships with the Windows SDK that's present on every
# windows-latest runner. d2d1.h is header-only here — we implement the geometry
# sink ourselves and call no Direct2D functions, so only dwrite.lib is linked.
target_link_libraries(domotion-glyph-paths PRIVATE dwrite)

if(MSVC)
  target_compile_options(domotion-glyph-paths PRIVATE /O2 /EHsc /W3)
  # Static CRT (/MT) so the .exe runs on a clean Windows with no VC++ redist.
  set_property(TARGET domotion-glyph-paths PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()
