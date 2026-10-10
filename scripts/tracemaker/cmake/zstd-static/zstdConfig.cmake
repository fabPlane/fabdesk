# Fabdesk override for find_package(zstd CONFIG). Homebrew's zstd package
# exports zstd::libzstd_shared as a dylib and does not define
# zstd::libzstd_static (run 38009143938). Upstream tm_replay prefers the
# shared target when it exists, so both names point at libzstd.a here.

if(NOT TM_ZSTD_LIBRARY OR NOT EXISTS "${TM_ZSTD_LIBRARY}")
  message(FATAL_ERROR
    "fabdesk: TM_ZSTD_LIBRARY must be an existing static archive (libzstd.a). "
    "Homebrew's libzstd.dylib is not allowed in the published macOS binary.")
endif()
if(TM_ZSTD_LIBRARY MATCHES "\\.dylib$")
  message(FATAL_ERROR "fabdesk: refusing ${TM_ZSTD_LIBRARY} — link libzstd.a, not a dylib")
endif()

foreach(_fabdesk_zstd_name zstd::libzstd_static zstd::libzstd_shared zstd::libzstd)
  if(NOT TARGET ${_fabdesk_zstd_name})
    add_library(${_fabdesk_zstd_name} STATIC IMPORTED GLOBAL)
    set_target_properties(${_fabdesk_zstd_name} PROPERTIES
      IMPORTED_LOCATION "${TM_ZSTD_LIBRARY}")
    if(TM_ZSTD_INCLUDE_DIR)
      set_target_properties(${_fabdesk_zstd_name} PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${TM_ZSTD_INCLUDE_DIR}")
    endif()
  endif()
endforeach()

set(zstd_FOUND TRUE)
set(ZSTD_FOUND TRUE)
set(ZSTD_LIBRARY "${TM_ZSTD_LIBRARY}")
set(ZSTD_LIBRARIES "${TM_ZSTD_LIBRARY}")
if(TM_ZSTD_INCLUDE_DIR)
  set(ZSTD_INCLUDE_DIR "${TM_ZSTD_INCLUDE_DIR}")
  set(ZSTD_INCLUDE_DIRS "${TM_ZSTD_INCLUDE_DIR}")
endif()
message(STATUS "fabdesk: zstd CONFIG uses static ${TM_ZSTD_LIBRARY}")
