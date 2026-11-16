#!/usr/bin/env bash
# Download distro-authenticated packaging/test tools into job temp; no root or system writes.
set -euo pipefail
packages=()
command -v ar >/dev/null || packages+=(binutils)
# atlc's pinned source and its installer tests use tar.bz2 archives.
command -v bzip2 >/dev/null || packages+=(bzip2)
if [ "${#packages[@]}" -eq 0 ]; then
  exit 0
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"
tools=$(mktemp -d "$RUNNER_TEMP/debian-packaging.XXXXXX")
mkdir -p "$tools/state/lists/partial" "$tools/cache/archives/partial" "$tools/root" "$tools/bin"
apt_options=(
  -o "Dir::State=$tools/state"
  -o "Dir::State::status=/var/lib/dpkg/status"
  -o "Dir::Cache=$tools/cache"
  -o "Debug::NoLocking=1"
  -o "APT::Sandbox::User=$(id -un)"
)
apt-get "${apt_options[@]}" update -qq
apt-get "${apt_options[@]}" install -y -qq --download-only --no-install-recommends "${packages[@]}"
for package in "$tools/cache/archives/"*.deb; do
  dpkg-deb -x "$package" "$tools/root"
done
# Scope these libraries to ar; do not override loaders for KiCad or other build tools.
if [ -x "$tools/root/usr/bin/x86_64-linux-gnu-ar" ]; then
cat > "$tools/bin/ar" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
export LD_LIBRARY_PATH="$tools/root/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$tools/root/usr/bin/x86_64-linux-gnu-ar" "\$@"
WRAPPER
chmod +x "$tools/bin/ar"
"$tools/bin/ar" --version
fi
if [ -x "$tools/root/bin/bzip2" ]; then
  ln -s "$tools/root/bin/bzip2" "$tools/bin/bzip2"
elif [ -x "$tools/root/usr/bin/bzip2" ]; then
  ln -s "$tools/root/usr/bin/bzip2" "$tools/bin/bzip2"
fi
echo "$tools/bin" >> "$GITHUB_PATH"
