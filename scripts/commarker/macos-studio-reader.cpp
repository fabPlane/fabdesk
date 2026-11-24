// CI only. Editor entry points in the pinned Intel Mac package. FabDesk never links these
// private libraries. Only initialise document services, open a local file and save a copy.
#include <cstring>
#include <iostream>
#include <memory>
#include <string>

namespace utils {
class path {
  void* impl;
public:
  path();
  ~path();
};
}
namespace param {
struct InitParam { utils::path defaults, version; };
int load(InitParam);
}
namespace shape {
struct InitParam {
  // Caller-owned opaque storage. Construction and destruction both run in libshape.
  alignas(16) unsigned char storage[256];
  InitParam();
  ~InitParam();
};
int load(InitParam);
}
namespace doc {
struct InitParam {};
int load(InitParam);
}
union SeriOption { unsigned int format; };
class LcsDoc {
public:
  unsigned int saveAs(const wchar_t*, SeriOption);
};
class LcsDocMgr {
public:
  static LcsDocMgr* instance();
  std::shared_ptr<LcsDoc> openDoc(const wchar_t*, unsigned int&);
};

int main(int argc, char** argv) {
  if (argc != 4) return 2;
  if (param::load({}) || shape::load({}) || doc::load({})) {
    std::cerr << "Studio editor initialization failed\n";
    return 1;
  }
  // The CI runner's temporary filenames are ASCII.
  std::wstring input(argv[1], argv[1] + std::strlen(argv[1]));
  std::wstring output(argv[2], argv[2] + std::strlen(argv[2]));
  std::wstring normalSave(argv[3], argv[3] + std::strlen(argv[3]));
  unsigned int error = 0;
  auto document = LcsDocMgr::instance()->openDoc(input.c_str(), error);
  if (error || !document) {
    std::cerr << "Studio could not open the FabDesk project (" << error << ")\n";
    return 1;
  }
  error = document->saveAs(output.c_str(), SeriOption{0});
  if (!error) error = document->saveAs(normalSave.c_str(), SeriOption{1});
  if (error) std::cerr << "Studio could not save its copy (" << error << ")\n";
  return error ? 1 : 0;
}
