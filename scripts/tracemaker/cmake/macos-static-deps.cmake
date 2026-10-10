# Included via CMAKE_PROJECT_INCLUDE on the macOS weekly build.
# Upstream tm_replay prefers zstd::libzstd_shared when that imported target
# exists (Homebrew's zstd config defines both). A Homebrew libzstd.dylib is
# not allowed in the published binary (verify-macos.sh rejects /opt/homebrew).
# Runs at the end of the top-level directory, after add_subdirectory(src).

function(fabdesk_prefer_static_zstd)
  if(NOT TARGET tm_replay)
    return()
  endif()
  if(NOT TARGET zstd::libzstd_static)
    message(WARNING "fabdesk: zstd::libzstd_static is missing; tm_replay may link a Homebrew zstd dylib")
    return()
  endif()
  get_target_property(_fabdesk_replay_libs tm_replay LINK_LIBRARIES)
  if(NOT _fabdesk_replay_libs)
    return()
  endif()
  list(TRANSFORM _fabdesk_replay_libs REPLACE "^zstd::libzstd_shared$" "zstd::libzstd_static")
  set_property(TARGET tm_replay PROPERTY LINK_LIBRARIES "${_fabdesk_replay_libs}")
  message(STATUS "fabdesk: tm_replay links zstd::libzstd_static")
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}" CALL fabdesk_prefer_static_zstd)
