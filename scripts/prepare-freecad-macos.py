#!/usr/bin/env python3
"""Assemble a relocatable headless FreeCAD install. No system installation or mock engine.

Input is `cmake --install` of the pinned fork plus the corresponding patched source checkout.
Keep shared libraries replaceable and include exact sources, notices and the build recipe.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def macho(path):
    if not path.is_file() or path.is_symlink():
        return False
    with path.open("rb") as stream:
        return stream.read(4) in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca")


def dependencies(path):
    return [line.strip().split(" (compatibility")[0] for line in run("otool", "-L", str(path)).splitlines()[1:]]


def rpaths(path):
    return re.findall(r"cmd LC_RPATH\n.*?path (.*?) \(offset", run("otool", "-l", str(path)), re.S)


def _python_info_plist(version: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Python</string>
	<key>CFBundleIdentifier</key>
	<string>org.python.python</string>
	<key>CFBundleName</key>
	<string>Python</string>
	<key>CFBundlePackageType</key>
	<string>FMWK</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
	<key>CFBundleVersion</key>
	<string>{version}</string>
</dict>
</plist>
"""


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _ensure_info_plist(info: Path, version: str):
    """codesign rejects a framework whose version has no bundle Info.plist."""
    if not info.exists():
        info.write_text(_python_info_plist(version))
        return
    data = info.read_bytes()
    # Leave a binary plist from the Python build alone; it already has the keys.
    if data.startswith(b"bplist"):
        return
    text = data.decode("utf-8", errors="replace")
    if "CFBundlePackageType" in text and "CFBundleExecutable" in text:
        return
    if "</dict>" not in text:
        info.write_text(_python_info_plist(version))
        return
    extra = ""
    if "CFBundleExecutable" not in text:
        extra += "\t<key>CFBundleExecutable</key>\n\t<string>Python</string>\n"
    if "CFBundlePackageType" not in text:
        extra += "\t<key>CFBundlePackageType</key>\n\t<string>FMWK</string>\n"
    if "CFBundleIdentifier" not in text:
        extra += "\t<key>CFBundleIdentifier</key>\n\t<string>org.python.python</string>\n"
    info.write_text(text.replace("</dict>", extra + "</dict>", 1))


def _relink(link: Path, target: str):
    if link.is_symlink() or link.exists():
        if not link.is_symlink():
            raise RuntimeError(f"{link} must be a symlink, not a copied directory")
        if os.readlink(link) == target:
            return
        link.unlink()
    link.symlink_to(target)


def normalize_python_framework(framework: Path, version: str):
    """Restore the versioned bundle Homebrew's python@3.12 altinstall deletes.

    `brew` removes Python.framework/{Headers,Python,Resources,Versions/Current}
    so the versioned prefix does not clash with the main python formula.
    codesign then reports "bundle format unrecognized, invalid, or unsuitable".
    """
    version_dir = framework / "Versions" / version
    if not version_dir.is_dir():
        raise RuntimeError(f"Python framework version is missing: {version_dir}")
    executable = version_dir / "Python"
    if executable.is_symlink() and not _inside(executable.resolve(), version_dir):
        # An absolute Cellar symlink is not a bundle executable. Copy the Mach-O in
        # rather than relinking at libpython, which often points back at Python.
        target = executable.resolve()
        if not target.is_file():
            raise RuntimeError(f"Python framework executable escapes the bundle: {executable}")
        payload = target.read_bytes()
        executable.unlink()
        executable.write_bytes(payload)
    elif not executable.exists() and not executable.is_symlink():
        libpython = next(version_dir.glob("lib/libpython*.dylib"), None)
        if libpython is None:
            raise RuntimeError(f"Python framework executable is missing: {executable}")
        executable.symlink_to(os.path.relpath(libpython, version_dir))
    resources = version_dir / "Resources"
    resources.mkdir(exist_ok=True)
    _ensure_info_plist(resources / "Info.plist", version)
    _relink(framework / "Versions" / "Current", version)
    for name in ("Python", "Resources", "Headers"):
        if name == "Headers" and not (version_dir / name).exists() and not (version_dir / name).is_symlink():
            continue
        if not (version_dir / name).exists() and not (version_dir / name).is_symlink():
            raise RuntimeError(f"Python framework is missing {version_dir / name}")
        _relink(framework / name, f"Versions/Current/{name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--python-home", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-cache", required=True)
    parser.add_argument("--yaml-source")
    parser.add_argument("--library-search-dir", action="append", default=[])
    args = parser.parse_args()
    if run("uname", "-m").strip() != "arm64":
        raise RuntimeError("This recipe is validated for macOS ARM64 only")
    installed, source, output = map(lambda p: Path(p).resolve(), (args.install, args.source, args.output))
    python_home = Path(args.python_home).resolve()
    cache = Path(args.source_cache).resolve()
    commit = run("git", "-C", str(source), "rev-parse", "HEAD").strip()
    if not (installed / "MacOS/FreeCADApiServer").is_file():
        raise RuntimeError("The native FreeCADApiServer must be built first")
    if output.exists():
        raise RuntimeError(f"Output already exists; choose a new isolated directory: {output}")
    shutil.copytree(installed, output, symlinks=True)
    (output / "lib").mkdir(exist_ok=True)
    frameworks = output / "Frameworks"
    frameworks.mkdir()
    py_framework = next(p for p in python_home.parents if p.name.endswith(".framework"))
    shutil.copytree(py_framework, frameworks / py_framework.name, symlinks=True)
    normalize_python_framework(frameworks / py_framework.name, python_home.name)
    site_packages = frameworks / py_framework.name / python_home.relative_to(py_framework) / "lib/python3.12/site-packages"
    if site_packages.is_symlink():
        site_packages.unlink()
        site_packages.mkdir()
    py_relative = (frameworks / py_framework.name / python_home.relative_to(py_framework)).relative_to(output)
    occt_resources = Path("/opt/homebrew/opt/opencascade/share/opencascade/resources")
    shutil.copytree(occt_resources, output / "share/opencascade", symlinks=True)

    # Remember each original binary's destination, including all Python extension modules.
    mapping = {}
    origins = {}
    for original_root, copied_root in [(installed, output), (py_framework, frameworks / py_framework.name)]:
        for original in original_root.rglob("*"):
            if macho(original):
                dest = copied_root / original.relative_to(original_root)
                mapping[original.resolve()] = dest
                origins[dest] = original.resolve()
    queue = list(origins)
    formulas = set()

    def external(original):
        original = original.resolve()
        if original in mapping:
            return mapping[original]
        framework = next((p for p in original.parents if p.name.endswith(".framework")), None)
        if framework:
            copied = frameworks / framework.name
            if not copied.exists():
                shutil.copytree(framework, copied, symlinks=True)
            for binary in framework.rglob("*"):
                if macho(binary):
                    dest = copied / binary.relative_to(framework)
                    mapping[binary.resolve()] = dest
                    if dest not in origins:
                        origins[dest] = binary.resolve()
                        queue.append(dest)
            return mapping[original]
        dest = output / "lib" / original.name
        if dest.exists() and hashlib.sha256(dest.read_bytes()).digest() != hashlib.sha256(original.read_bytes()).digest():
            raise RuntimeError(f"Conflicting library names: {original} and {dest}")
        shutil.copy2(original, dest)
        mapping[original] = dest
        origins[dest] = original
        queue.append(dest)
        return dest

    def locate(dependency, original):
        if dependency.startswith("@loader_path/"):
            return (original.parent / dependency.removeprefix("@loader_path/")).resolve()
        if dependency.startswith("@rpath/"):
            tail = dependency.removeprefix("@rpath/")
            for prefix in rpaths(original) + ["/opt/homebrew/opt/qtbase/lib", "/opt/homebrew/lib", str(installed / "lib"), *args.library_search_dir]:
                prefix = prefix.replace("@loader_path", str(original.parent)).replace("@executable_path", str(installed / "bin"))
                hit = Path(prefix) / tail
                if hit.exists():
                    return hit.resolve()
            raise RuntimeError(f"Cannot resolve {dependency} in {original}")
        if dependency.startswith("@executable_path/"):
            return (installed / "bin" / dependency.removeprefix("@executable_path/")).resolve()
        return Path(dependency).resolve()

    for dest in queue:
        original = origins[dest]
        for dependency in dependencies(original):
            if dependency.startswith(("/usr/lib/", "/System/Library/")):
                continue
            resolved = locate(dependency, original)
            if not resolved.exists():
                raise RuntimeError(f"Missing native library {resolved}")
            bundled = mapping.get(resolved) or external(resolved)
            relative = os.path.relpath(bundled, dest.parent)
            run("install_name_tool", "-change", dependency, "@loader_path/" + relative, str(dest))
        if dest.suffix == ".dylib" or ".framework/" in str(dest):
            run("install_name_tool", "-id", "@rpath/" + str(dest.relative_to(output)), str(dest))
        for path in rpaths(dest):
            if path.startswith("/") and not path.startswith("/System/"):
                run("install_name_tool", "-delete_rpath", path, str(dest))
        parts = original.parts
        if "Cellar" in parts:
            formulas.add(Path(*parts[:parts.index("Cellar") + 3]))

    # Include exact dependency source archives and their official license files. Validate hashes
    # using the installed Homebrew formula, not a rolling release or arbitrary download URL.
    cache.mkdir(parents=True, exist_ok=True)
    sources, licenses = output / "sources", output / "licenses"
    sources.mkdir(exist_ok=True)
    licenses.mkdir(exist_ok=True)
    manifest = []
    for cellar in sorted(formulas):
        formula = cellar / ".brew" / (cellar.parent.name + ".rb")
        text = formula.read_text()
        url = re.search(r'^  url "([^\"]+)"', text, re.M).group(1)
        checksum = re.search(r'^  sha256 "([a-f0-9]{64})"', text, re.M).group(1)
        archive = cache / (cellar.parent.name + "-" + cellar.name + ".tar.gz")
        urls = [url] + re.findall(r'^  mirror "([^\"]+)"', text, re.M)
        if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            for candidate in urls:
                try:
                    with urllib.request.urlopen(candidate, timeout=60) as response, archive.open("wb") as stream:
                        shutil.copyfileobj(response, stream)
                    if hashlib.sha256(archive.read_bytes()).hexdigest() == checksum:
                        break
                except Exception:
                    continue
            else:
                raise RuntimeError(f"Source checksum mismatch or download unavailable: {url}")
        shutil.copy2(archive, sources / archive.name)
        notice_dir = licenses / cellar.parent.name
        notice_dir.mkdir(exist_ok=True)
        with tarfile.open(archive) as tar:
            for entry in tar.getmembers():
                if entry.isfile() and re.search(r'(^|/)(LICENSE[^/]*|COPYING[^/]*|NOTICE[^/]*|OCCT_LGPL_EXCEPTION[^/]*)$', entry.name, re.I):
                    data = tar.extractfile(entry).read()
                    (notice_dir / entry.name.replace("/", "__")).write_bytes(data)
        shutil.copy2(formula, sources / (cellar.parent.name + ".rb"))
        receipt = json.loads((cellar / "INSTALL_RECEIPT.json").read_text())
        shutil.copy2(cellar / "INSTALL_RECEIPT.json", sources / (cellar.parent.name + "-receipt.json"))
        tap_commit = receipt["source"]["tap_git_head"]
        for patch in re.findall(r'file "(Patches/[^\"]+)"', text):
            patch_url = f"https://raw.githubusercontent.com/Homebrew/homebrew-core/{tap_commit}/{patch}"
            patch_file = cache / (cellar.parent.name + "-" + Path(patch).name)
            if not patch_file.exists():
                with urllib.request.urlopen(patch_url, timeout=60) as response:
                    patch_file.write_bytes(response.read())
            shutil.copy2(patch_file, sources / patch_file.name)
        manifest.append({"name": cellar.parent.name, "version": cellar.name, "source": url, "sha256": checksum})

    with tarfile.open(sources / "FreeCAD.tar.gz", "w:gz") as tar:
        tar.add(source, arcname="FreeCAD", filter=lambda e: None if ".git" in Path(e.name).parts else e)
    shutil.copy2(source / "LICENSE", licenses / "FreeCAD-LGPL-2.1.txt")
    third_party = licenses / "FreeCAD-third-party"
    third_party.mkdir(exist_ok=True)
    for notice in (source / "src/3rdParty").rglob("*"):
        if notice.is_file() and re.match(r"^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)", notice.name, re.I):
            shutil.copy2(notice, third_party / str(notice.relative_to(source)).replace("/", "__"))
    # The only non-Homebrew dynamic dependency built locally is yaml-cpp, supplied by the build
    # recipe. Require its source and license beside the install prefix rather than invent a notice.
    yaml_source = Path(args.yaml_source) if args.yaml_source else None
    if any("yaml" in str(p) and "Cellar" not in p.parts for p in origins.values()):
        if yaml_source is None or not (yaml_source / "LICENSE").exists():
            raise RuntimeError("yaml-cpp source/notice is required for redistribution")
        shutil.copy2(yaml_source / "LICENSE", licenses / "yaml-cpp-MIT.txt")
        with tarfile.open(sources / "yaml-cpp.tar.gz", "w:gz") as tar:
            tar.add(yaml_source, arcname="yaml-cpp", filter=lambda e: None if ".git" in Path(e.name).parts else e)
    shutil.copy2(Path(__file__).parent.parent / "docs/native-cad-packaging.md", licenses / "REBUILDING.md")
    (licenses / "NOTICE.txt").write_text("FreeCAD is LGPL-2.1-or-later; OCCT is LGPL-2.1 with its exception; Qt essential libraries are LGPL-3.0. Exact corresponding sources and notices are included in ../sources and this directory. The dynamically linked CAD engine is replaceable via FABDESK_FAB_CAD_BUNDLE. See docs/native-cad-packaging.md for rebuilding and local re-signing. No warranty is provided.\n")
    shutil.copy2(Path(__file__), sources / "prepare-freecad-macos.py")
    shutil.copy2(Path(__file__).with_name("build-freecad-macos.py"), sources / "build-freecad-macos.py")
    (sources / "dependencies.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for binary in origins:
        if "arm64" not in run("lipo", "-archs", str(binary)).split():
            raise RuntimeError(f"Native dependency lacks ARM64: {binary}")
        run("codesign", "--force", "--sign", "-", str(binary))
        if any(p.startswith(("/opt/", "/private/tmp/", "/tmp/", "/Users/")) for p in dependencies(binary)):
            raise RuntimeError(f"Unbundled dependency remains: {binary}")
    # Prove the restored Python.framework is a bundle before Developer ID signing.
    # install_name_tool above invalidates signatures, so this seal is last.
    run("codesign", "--force", "--sign", "-", str(frameworks / py_framework.name))
    (output / "runtime.json").write_text(json.dumps({"format": 1, "target": "darwin-arm64", "freecadCommit": commit, "apiServer": "MacOS/FreeCADApiServer", "pythonHome": str(py_relative), "environmentPaths": {"CSF_ResourcesDefaults": "share/opencascade", "CSF_STEPDefaults": "share/opencascade", "CSF_IGESDefaults": "share/opencascade"}}, indent=2) + "\n")
    print(f"Native runtime: {output}; {len(origins)} Mach-O binaries; {len(manifest)} dependencies")


if __name__ == "__main__":
    main()
