cmake_minimum_required(VERSION 3.16)
project(domotion_icu CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT DOMOTION_ICU_ROOT)
  message(FATAL_ERROR "DOMOTION_ICU_ROOT must point to an ICU 78.2 bundle")
endif()

add_executable(domotion-icu src/main.cpp)
target_include_directories(domotion-icu PRIVATE "${DOMOTION_ICU_ROOT}/include")
find_library(DOMOTION_ICU_UC NAMES icuuc libicuuc REQUIRED
  PATHS "${DOMOTION_ICU_ROOT}/lib" "${DOMOTION_ICU_ROOT}/lib64" "${DOMOTION_ICU_ROOT}/libARM64" NO_DEFAULT_PATH)
find_library(DOMOTION_ICU_DATA NAMES icudata libicudata REQUIRED
  PATHS "${DOMOTION_ICU_ROOT}/lib" "${DOMOTION_ICU_ROOT}/lib64" "${DOMOTION_ICU_ROOT}/libARM64" "${DOMOTION_ICU_ROOT}/stubdata" NO_DEFAULT_PATH)
target_link_libraries(domotion-icu PRIVATE "${DOMOTION_ICU_UC}" "${DOMOTION_ICU_DATA}")

if(APPLE)
  set_target_properties(domotion-icu PROPERTIES BUILD_RPATH "@loader_path")
elseif(UNIX)
  set_target_properties(domotion-icu PROPERTIES BUILD_RPATH "$ORIGIN")
elseif(MSVC)
  target_compile_options(domotion-icu PRIVATE /O2 /EHsc /W3)
  set_property(TARGET domotion-icu PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()
