# Mirrors DingoOz/TraceMaker src/server/CMakeLists.txt (v0.9.0 / 24c8477):
# find_package(zstd CONFIG REQUIRED) then prefer zstd::libzstd_shared.
find_package(zstd CONFIG REQUIRED)
add_library(tm_replay STATIC "${CMAKE_CURRENT_SOURCE_DIR}/../../stub.c")
add_library(tm::replay ALIAS tm_replay)
if(TARGET zstd::libzstd_shared)
  target_link_libraries(tm_replay PRIVATE zstd::libzstd_shared)
else()
  target_link_libraries(tm_replay PRIVATE zstd::libzstd_static)
endif()
add_executable(tracemaker "${CMAKE_CURRENT_SOURCE_DIR}/../../stub.c")
target_link_libraries(tracemaker PRIVATE tm_replay)
