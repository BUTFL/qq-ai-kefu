#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rosmontis Pure-JS Bridge Installer (`scripts/install_bridge.sh`)
#
# Installs `bridge_onebot.js`, `bridge_renderer.js`, `bridge_main.js`,
# `types.js`, `core/*.js`, `onebot/*.js`, `actions/*.js`, and
# `app_launcher_index.js` into `/opt/QQ/resources/app/app_launcher/`, updates
# `/opt/QQ/resources/app/package.json` `"main"` -> `"./app_launcher/index.js"`,
# and verifies that no C++ `.so` memory hook (`LD_PRELOAD`) is active.
#
# Pass `--uninstall` to restore the original backed-up launcher files cleanly.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/../src" ]]; then
  SRC_DIR="$(cd "${SCRIPT_DIR}/../src" && pwd)"
else
  SRC_DIR="${SCRIPT_DIR}"
fi

QQ_APP_DIR="${QQ_APP_DIR:-/opt/QQ/resources/app}"
LAUNCHER_DIR="${QQ_APP_DIR}/app_launcher"
PACKAGE_JSON="${QQ_APP_DIR}/package.json"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "[rosmontis] Restoring original Linux QQ launcher in ${QQ_APP_DIR}..."
  if [[ -f "${QQ_APP_DIR}/package.orig.json" ]]; then
    cp -f "${QQ_APP_DIR}/package.orig.json" "${PACKAGE_JSON}"
  fi
  if [[ -f "${LAUNCHER_DIR}/index.orig.js" ]]; then
    cp -f "${LAUNCHER_DIR}/index.orig.js" "${LAUNCHER_DIR}/index.js"
  fi
  rm -f \
    "${LAUNCHER_DIR}/bridge_onebot.js" \
    "${LAUNCHER_DIR}/bridge_renderer.js" \
    "${LAUNCHER_DIR}/bridge_main.js" \
    "${LAUNCHER_DIR}/types.js"
  for subdir in core onebot actions; do
    rm -rf "${LAUNCHER_DIR}/${subdir}"
  done
  echo "[rosmontis] Uninstalled cleanly."
  exit 0
fi

echo "[rosmontis] Source dir : ${SRC_DIR}"
echo "[rosmontis] Target app : ${QQ_APP_DIR}"

# 1. Verify no LD_PRELOAD C++ .so hook is active
if [[ -n "${LD_PRELOAD:-}" ]]; then
  echo "[rosmontis] WARNING: LD_PRELOAD was set (${LD_PRELOAD}); unsetting for pure JS mode."
  unset LD_PRELOAD
fi

if [[ -f /etc/ld.so.preload ]] && [[ -s /etc/ld.so.preload ]]; then
  if grep -qiE "hook|preload|inject" /etc/ld.so.preload 2>/dev/null; then
    echo "[rosmontis] ERROR: Native preload hook detected in /etc/ld.so.preload" >&2
    exit 1
  fi
fi

# 2. Ensure target launcher directory exists
mkdir -p "${LAUNCHER_DIR}"
chmod 755 "${LAUNCHER_DIR}"

# 3. Backup original launcher index.js and package.json once
if [[ -f "${LAUNCHER_DIR}/index.js" ]] && [[ ! -f "${LAUNCHER_DIR}/index.orig.js" ]]; then
  if ! grep -q "bridge_main.js" "${LAUNCHER_DIR}/index.js" 2>/dev/null; then
    cp -f "${LAUNCHER_DIR}/index.js" "${LAUNCHER_DIR}/index.orig.js"
    echo "[rosmontis] Backed up original app_launcher/index.js -> index.orig.js"
  fi
fi

if [[ -f "${PACKAGE_JSON}" ]] && [[ ! -f "${QQ_APP_DIR}/package.orig.json" ]]; then
  cp -f "${PACKAGE_JSON}" "${QQ_APP_DIR}/package.orig.json"
  echo "[rosmontis] Backed up original package.json -> package.orig.json"
fi

# 4. Copy pure-JS bridge files and core/*.js + onebot/*.js + actions/*.js modules into app_launcher/
cp -f "${SRC_DIR}/bridge_onebot.js" "${LAUNCHER_DIR}/bridge_onebot.js"
cp -f "${SRC_DIR}/bridge_renderer.js" "${LAUNCHER_DIR}/bridge_renderer.js"
cp -f "${SRC_DIR}/bridge_main.js" "${LAUNCHER_DIR}/bridge_main.js"
cp -f "${SRC_DIR}/app_launcher_index.js" "${LAUNCHER_DIR}/index.js"

chmod 644 \
  "${LAUNCHER_DIR}/bridge_onebot.js" \
  "${LAUNCHER_DIR}/bridge_renderer.js" \
  "${LAUNCHER_DIR}/bridge_main.js" \
  "${LAUNCHER_DIR}/index.js"

if [[ -f "${SRC_DIR}/types.js" ]]; then
  cp -f "${SRC_DIR}/types.js" "${LAUNCHER_DIR}/types.js"
  chmod 644 "${LAUNCHER_DIR}/types.js"
fi

for subdir in core onebot actions; do
  if [[ -d "${SRC_DIR}/${subdir}" ]]; then
    rm -rf "${LAUNCHER_DIR}/${subdir}"
    mkdir -p "${LAUNCHER_DIR}/${subdir}"
    chmod 755 "${LAUNCHER_DIR}/${subdir}"
    shopt -s nullglob
    SUBDIR_JS_FILES=("${SRC_DIR}/${subdir}/"*.js)
    shopt -u nullglob
    if (( ${#SUBDIR_JS_FILES[@]} > 0 )); then
      cp -f "${SUBDIR_JS_FILES[@]}" "${LAUNCHER_DIR}/${subdir}/"
      chmod 644 "${LAUNCHER_DIR}/${subdir}/"*.js
    fi
  fi
done

# 5. Update /opt/QQ/resources/app/package.json "main" -> "./app_launcher/index.js" in-place
#    preserving version, buildVersion, appid, and all existing fields.
if [[ -f "${PACKAGE_JSON}" ]]; then
  if node -e '
      const fs = require("fs");
      const pkgPath = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!pkg.original_main && pkg.main && pkg.main !== "./app_launcher/index.js") {
        pkg.original_main = pkg.main;
      }
      pkg.main = "./app_launcher/index.js";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    ' "${PACKAGE_JSON}" 2>/dev/null; then
    :
  elif python3 -c '
import json, sys
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as f:
    pkg = json.load(f)
if not pkg.get("original_main") and pkg.get("main") and pkg.get("main") != "./app_launcher/index.js":
    pkg["original_main"] = pkg["main"]
pkg["main"] = "./app_launcher/index.js"
with open(p, "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
' "${PACKAGE_JSON}" 2>/dev/null; then
    :
  else
    sed -i 's|"main"[[:space:]]*:[[:space:]]*"[^"]*"|"main": "./app_launcher/index.js"|g' "${PACKAGE_JSON}"
  fi
else
  cp -f "${SRC_DIR}/package_patch.json" "${PACKAGE_JSON}"
fi

chmod 644 "${PACKAGE_JSON}"

# 6. Verify installation
if ! grep -q '"./app_launcher/index.js"' "${PACKAGE_JSON}"; then
  echo "[rosmontis] ERROR: Failed to update ${PACKAGE_JSON} main field" >&2
  exit 1
fi

echo "[rosmontis] Installed Rosmontis Pure-JS Bridge into ${LAUNCHER_DIR}"
