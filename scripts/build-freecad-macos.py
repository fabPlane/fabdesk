#!/usr/bin/env python3
"""Build the pinned fork's real headless CAD engine in isolated directories.

Requires existing LLVM >=18, CMake, Ninja, Qt6 Core/Network/Xml + LinguistTools,
OCCT, Boost, ICU, Xerces, Eigen, yaml-cpp and Python 3.12. No system installs.
"""
import argparse
import json
from pathlib import Path
import platform
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--install", required=True)
    parser.add_argument("--prefix", default="/opt/homebrew")
    parser.add_argument("--extra-prefix", default="")
    parser.add_argument("--llvm", default="/opt/homebrew/opt/llvm@22")
    parser.add_argument("--python", default="/opt/homebrew/opt/python@3.12/bin/python3.12")
    parser.add_argument("--jobs", default="6")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Only darwin-arm64 has been validated; do not substitute a foreign engine")
    repo = Path(__file__).resolve().parent.parent
    commit = (repo / "vendor/fab_cad/packages/protocol/FREECAD_COMMIT").read_text().strip()
    source = Path(args.source).resolve()
    if not source.exists():
        subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", "https://github.com/fabPlane/FreeCAD.git", str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "checkout", commit], check=True)
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != commit:
        raise RuntimeError(f"Expected pinned FreeCAD {commit}, found {actual}")
    subprocess.run(["git", "-C", str(source), "submodule", "update", "--init", "src/3rdParty/GSL"], check=True)
    # Upstream incorrectly requires GUI Pivy/SWIG for the headless Sketcher application module.
    # The minimal guarded build patch is included in the corresponding-source archive.
    swig = source / "cMake/FreeCAD_Helpers/SetupSwig.cmake"
    text = swig.read_text()
    swig.write_text(text.replace("if(BUILD_SKETCHER)\n", "if(BUILD_SKETCHER AND BUILD_GUI)\n", 1))
    interpreter = source / "src/Base/Interpreter.cpp"
    original = interpreter.read_bytes()
    newline = b"\r\n" if b"\r\n" in original else b"\n"
    anchor = b"    config.user_site_directory = 1;" + newline
    if b"Packaged native runtime controls" not in original:
        patch = newline.join([
            b"    // Packaged native runtime controls: keep Python and bytecode inside the bundle.",
            b"    if (const char* home = getenv(\"PYTHONHOME\"); home && *home) {",
            b"        status = PyConfig_SetBytesString(&config, &config.home, home);",
            b"        if (PyStatus_Exception(status)) throw Base::RuntimeError(\"Failed to set Python home\");",
            b"    }",
            b"    if (getenv(\"PYTHONNOUSERSITE\")) config.user_site_directory = 0;",
            b"    if (getenv(\"PYTHONDONTWRITEBYTECODE\")) config.write_bytecode = 0;",
        ]) + newline
        if anchor not in original:
            raise RuntimeError("Pinned Python initialization patch no longer applies")
        interpreter.write_bytes(original.replace(anchor, anchor + patch, 1))
    keep = {"BUILD_API", "BUILD_PART", "BUILD_PART_DESIGN", "BUILD_SKETCHER", "BUILD_MESH", "BUILD_IMPORT", "BUILD_MATERIAL"}
    options = re.findall(r'option\((BUILD_\w+) "Build the FreeCAD', (source / "cMake/FreeCAD_Helpers/InitializeFreeCADBuildOptions.cmake").read_text())
    configure = ["cmake", "-S", str(source), "-B", args.build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_INSTALL_PREFIX={args.install}", "-DBUILD_GUI=OFF", "-DENABLE_DEVELOPER_TESTS=OFF", "-DFREECAD_USE_CCACHE=OFF", "-DFREECAD_USE_PYBIND11=OFF", f"-DPython3_EXECUTABLE={args.python}", f"-DCMAKE_C_COMPILER={args.llvm}/bin/clang", f"-DCMAKE_CXX_COMPILER={args.llvm}/bin/clang++", f"-DCMAKE_PREFIX_PATH={args.extra_prefix};{args.prefix}", f"-DICU_ROOT={args.prefix}/opt/icu4c@78", f"-DICU_INCLUDE_DIR={args.prefix}/opt/icu4c@78/include", f"-DICU_UC_LIBRARY_RELEASE={args.prefix}/opt/icu4c@78/lib/libicuuc.dylib", f"-DICU_I18N_LIBRARY_RELEASE={args.prefix}/opt/icu4c@78/lib/libicui18n.dylib", f"-DZLIB_INCLUDE_DIR={args.prefix}/include", f"-DCMAKE_SHARED_LINKER_FLAGS=-L{args.prefix}/opt/tbb/lib -ltbb"]
    configure.extend(f'-D{name}={"ON" if name in keep else "OFF"}' for name in sorted(set(options)))
    subprocess.run(configure, check=True)
    subprocess.run(["cmake", "--build", args.build, "-j", args.jobs], check=True)
    subprocess.run(["cmake", "--install", args.build], check=True)
    recipe = Path(args.install) / "build-recipe.json"
    recipe.write_text(json.dumps({"freecadCommit": commit, "configure": configure, "headlessSwigGuard": True}, indent=2) + "\n")


if __name__ == "__main__":
    main()
