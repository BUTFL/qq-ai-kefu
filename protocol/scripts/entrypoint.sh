#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rosmontis Headless Linux QQ Container Entrypoint (`scripts/entrypoint.sh`)
#
# Boots official Linux QQ (`/opt/QQ/qq`) with Rosmontis pure-JS Renderer/Main
# OneBot v11 bridge and ZERO native C++ `.so` / `LD_PRELOAD` / `ptrace` hooks:
# - Persistent `/etc/machine-id` -> `/app/data/config/machine-id`
# - System D-Bus, non-root Xvfb (:99), Fluxbox WM, optional x11vnc + noVNC (:6081)
# - Drop-in compatibility when mounted into legacy headless QQ containers
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Strictly clear LD_PRELOAD / NODE_OPTIONS
unset LD_PRELOAD || true
export LD_PRELOAD=""
unset NODE_OPTIONS || true

# 2. Neutralize legacy native hook binaries if migrating an existing container
if [[ -d /app/runtime/native ]]; then
  for hook_bin in /app/runtime/native/*.so /app/runtime/native/*.node; do
    if [[ -f "${hook_bin}" ]]; then
      mv -f "${hook_bin}" "${hook_bin}.disabled" 2>/dev/null || true
    fi
  done
fi

# 3. Install Rosmontis pure-JS bridge into /opt/QQ/resources/app/app_launcher/
QQ_APP_TARGET="${QQ_APP_DIR:-/opt/QQ/resources/app}"
if [[ -w "${QQ_APP_TARGET}" ]] || [[ ! -f "${QQ_APP_TARGET}/app_launcher/bridge_main.js" ]]; then
  bash "${SCRIPT_DIR}/install_bridge.sh"
else
  echo "[rosmontis] Using pre-installed Rosmontis bridge in ${QQ_APP_TARGET}/app_launcher"
fi

# 4. Legacy container migration path: if /root/start.sh + /etc/supervisord.conf exist,
#    strip any third-party native injector program and delegate cleanly.
if [[ "${ROSMONTIS_DIRECT_EXEC:-0}" != "1" ]] && [[ -f /root/start.sh ]] && [[ -f /etc/supervisord.conf ]]; then
  if [[ ! -f /etc/supervisord.orig.conf ]]; then
    cp -f /etc/supervisord.conf /etc/supervisord.orig.conf 2>/dev/null || true
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const p = "/etc/supervisord.conf";
      const src = fs.readFileSync(p, "utf8");
      let out = src.replace(/\[program:(?!qq\b|xvfb\b|fluxbox\b|x11vnc\b|novnc\b|dbus\b)[a-zA-Z0-9_-]+\][\s\S]*?(?=\n\[|$)/g, "");
      out = out.replace(/[A-Z0-9_]*HOOK_RUNTIME_DIR="[^"]*"/g, "ROSMONTIS_CONFIG_DIR=\"/app/data/config\"");
      out = out.replace(/\n{3,}/g, "\n\n");
      if (out !== src) {
        fs.writeFileSync(p, out.trimEnd() + "\n", "utf8");
        console.log("[rosmontis] Cleaned native injector entries from /etc/supervisord.conf");
      }
    '
  fi
  echo "[rosmontis] Delegating display & supervisor initialization to /root/start.sh..."
  exec /root/start.sh "$@"
fi

# ==============================================================================
# Standalone Pure Linux QQ Execution Mode
# ==============================================================================

NOFILE_SOFT="$(ulimit -Sn || echo 65536)"
if [[ "${NOFILE_SOFT}" == "unlimited" ]] || [[ "${NOFILE_SOFT}" -gt 65536 ]] 2>/dev/null; then
  ulimit -Sn 65536 || true
fi

DATA_DIR="${ROSMONTIS_DATA_DIR:-/app/data}"
mkdir -p "${DATA_DIR}/config"
if [[ ! -s "${DATA_DIR}/config/machine-id" ]]; then
  if [[ -s /etc/machine-id ]]; then
    cp -f /etc/machine-id "${DATA_DIR}/config/machine-id"
  else
    cat /proc/sys/kernel/random/uuid | tr -d '-' > "${DATA_DIR}/config/machine-id"
  fi
fi
ln -sf "${DATA_DIR}/config/machine-id" /etc/machine-id 2>/dev/null || true

if [[ "${ROSMONTIS_BLOCK_HOT_UPDATE:-1}" == "1" ]]; then
  if ! grep -q 'qqpatch\.gtimg\.cn' /etc/hosts 2>/dev/null; then
    printf '0.0.0.0 qqpatch.gtimg.cn\n' >> /etc/hosts 2>/dev/null || true
  fi
fi

# Start D-Bus system daemon
mkdir -p /var/run/dbus
if [[ ! -e /var/run/dbus/system_bus_socket ]] && [[ ! -e /run/dbus/system_bus_socket ]]; then
  dbus-daemon --system --fork 2>/dev/null || true
fi

# Prepare non-root target user & runtime directories BEFORE starting X11/VNC services
TARGET_UID="${QQ_UID:-1000}"
TARGET_GID="${QQ_GID:-1000}"
if [[ ! "${TARGET_UID}" =~ ^[0-9]+$ ]]; then
  echo "[rosmontis] ERROR: Invalid QQ_UID '${TARGET_UID}' (must be numeric)" >&2
  exit 1
fi
if [[ ! "${TARGET_GID}" =~ ^[0-9]+$ ]]; then
  echo "[rosmontis] ERROR: Invalid QQ_GID '${TARGET_GID}' (must be numeric)" >&2
  exit 1
fi

if [[ -d /app ]]; then
  USER_HOME="/app"
else
  USER_HOME="$(getent passwd "${TARGET_UID}" | cut -d: -f6 || true)"
  USER_HOME="${USER_HOME:-/tmp}"
fi

export HOME="${USER_HOME}"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-${TARGET_UID}}"
export ROSMONTIS_TEMP_DIR="${ROSMONTIS_TEMP_DIR:-/tmp/rosmontis_tmp}"
export ROSMONTIS_CONFIG_DIR="${ROSMONTIS_CONFIG_DIR:-${DATA_DIR}/config}"

mkdir -p \
  "${HOME}/.config/QQ" \
  "${HOME}/.fluxbox" \
  "${HOME}/.local/share" \
  "${XDG_RUNTIME_DIR}" \
  "${ROSMONTIS_TEMP_DIR}" \
  "${ROSMONTIS_CONFIG_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"
find "${XDG_RUNTIME_DIR}" -maxdepth 1 -type s -name 'mojo.*.*.sock' -delete 2>/dev/null || true

if [[ "$(id -u)" == "0" ]]; then
  chown -R "${TARGET_UID}:${TARGET_GID}" \
    "${HOME}/.config" \
    "${HOME}/.fluxbox" \
    "${HOME}/.local" \
    "${DATA_DIR}" \
    "${XDG_RUNTIME_DIR}" \
    "${ROSMONTIS_TEMP_DIR}" \
    "${ROSMONTIS_CONFIG_DIR}" 2>/dev/null || true
  if [[ -d /app ]]; then
    chown "${TARGET_UID}:${TARGET_GID}" /app 2>/dev/null || true
  fi
fi

# Helper: run command as ${TARGET_UID}:${TARGET_GID} without shell injection
run_as_target_user() {
  if [[ "$(id -u)" == "0" ]]; then
    if command -v gosu >/dev/null 2>&1; then
      gosu "${TARGET_UID}:${TARGET_GID}" env -u LD_PRELOAD HOME="${HOME}" "$@"
    elif command -v setpriv >/dev/null 2>&1; then
      if getent passwd "${TARGET_UID}" >/dev/null 2>&1; then
        setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --init-groups env -u LD_PRELOAD HOME="${HOME}" "$@"
      else
        setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --clear-groups env -u LD_PRELOAD HOME="${HOME}" "$@"
      fi
    else
      local target_user
      target_user="$(getent passwd "${TARGET_UID}" | cut -d: -f1 || true)"
      target_user="${target_user:-ubuntu}"
      su -s /bin/bash "${target_user}" -- -c 'export HOME="$1"; unset LD_PRELOAD; shift; exec "$@"' _ "${HOME}" "$@"
    fi
  else
    env -u LD_PRELOAD HOME="${HOME}" "$@"
  fi
}

# Start Xvfb and Fluxbox WM as non-root (${TARGET_UID}:${TARGET_GID})
export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
if [[ ! "${DISPLAY_NUM}" =~ ^[0-9]+$ ]]; then
  echo "[rosmontis] ERROR: Invalid DISPLAY '${DISPLAY}'" >&2
  exit 1
fi

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" || true
  run_as_target_user Xvfb "${DISPLAY}" -screen 0 "${ROSMONTIS_SCREEN:-1280x800x24}" -ac +extension GLX +render -noreset >/dev/null 2>&1 &
  XVFB_PID=$!
  XVFB_READY=0
  for ((i = 0; i < 50; i++)); do
    if [[ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]]; then
      XVFB_READY=1
      break
    fi
    if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
      echo "[rosmontis] ERROR: Xvfb (PID ${XVFB_PID}) exited prematurely before ${DISPLAY} socket became ready." >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ "${XVFB_READY}" -ne 1 ]]; then
    echo "[rosmontis] ERROR: Timed out after 5s waiting for Xvfb socket /tmp/.X11-unix/X${DISPLAY_NUM}." >&2
    exit 1
  fi
fi

if command -v fluxbox >/dev/null 2>&1 && ! pgrep -x fluxbox >/dev/null 2>&1; then
  run_as_target_user fluxbox >/dev/null 2>&1 &
fi

# Optional x11vnc + noVNC (:6081) for visual QR login / debugging
rm -f /tmp/.vnc/passwd 2>/dev/null || true
if [[ -n "${VNC_PASSWD:-}" ]] && command -v x11vnc >/dev/null 2>&1; then
  VNC_DIR="${XDG_RUNTIME_DIR}/vnc"
  VNC_PASSWD_FILE="${VNC_DIR}/passwd"
  mkdir -p "${VNC_DIR}"
  chmod 700 "${VNC_DIR}"
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "${TARGET_UID}:${TARGET_GID}" "${VNC_DIR}"
  fi
  (
    umask 077
    run_as_target_user x11vnc -storepasswd "${VNC_PASSWD}" "${VNC_PASSWD_FILE}" >/dev/null 2>&1
  ) || true
  unset VNC_PASSWD

  if [[ -s "${VNC_PASSWD_FILE}" ]]; then
    chmod 600 "${VNC_PASSWD_FILE}"
    if [[ "$(id -u)" == "0" ]]; then
      chown "${TARGET_UID}:${TARGET_GID}" "${VNC_PASSWD_FILE}"
    fi

    X11VNC_BIND_ARGS=("-localhost")
    if [[ "${ROSMONTIS_EXPOSE_RAW_VNC:-0}" == "1" ]]; then
      if [[ -n "${VNC_BIND_HOST:-}" ]]; then
        X11VNC_BIND_ARGS=("-listen" "${VNC_BIND_HOST}")
      else
        X11VNC_BIND_ARGS=()
      fi
    elif [[ -n "${VNC_BIND_HOST:-}" ]] && [[ "${VNC_BIND_HOST}" != "127.0.0.1" ]] && [[ "${VNC_BIND_HOST}" != "localhost" ]]; then
      X11VNC_BIND_ARGS=("-listen" "${VNC_BIND_HOST}")
    fi

    run_as_target_user x11vnc -display "${DISPLAY}" -rfbauth "${VNC_PASSWD_FILE}" -rfbport 5900 "${X11VNC_BIND_ARGS[@]}" -forever -shared >/dev/null 2>&1 &
    if command -v websockify >/dev/null 2>&1 && [[ -d /usr/share/novnc ]]; then
      run_as_target_user websockify --web=/usr/share/novnc "${NOVNC_PORT:-6081}" 127.0.0.1:5900 >/dev/null 2>&1 &
      echo "[rosmontis] noVNC desktop available on port ${NOVNC_PORT:-6081}"
    fi
  else
    echo "[rosmontis] WARNING: Failed to initialize VNC password file; skipping x11vnc." >&2
  fi
fi
unset VNC_PASSWD || true

QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
QQ_ARGS=(
  "--no-sandbox"
  "--disable-gpu"
  "--disable-software-rasterizer"
  "--disable-gpu-compositing"
  "--disable-dev-shm-usage"
)

echo "[rosmontis] Starting official ${QQ_BIN} under UID:GID ${TARGET_UID}:${TARGET_GID} (zero native hooks)..."

if [[ "$(id -u)" == "0" ]]; then
  if command -v gosu >/dev/null 2>&1; then
    exec gosu "${TARGET_UID}:${TARGET_GID}" env -u LD_PRELOAD HOME="${HOME}" "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    if getent passwd "${TARGET_UID}" >/dev/null 2>&1; then
      exec setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --init-groups env -u LD_PRELOAD HOME="${HOME}" "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
    else
      exec setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --clear-groups env -u LD_PRELOAD HOME="${HOME}" "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
    fi
  else
    TARGET_USER="$(getent passwd "${TARGET_UID}" | cut -d: -f1 || true)"
    TARGET_USER="${TARGET_USER:-ubuntu}"
    exec su -s /bin/bash "${TARGET_USER}" -- -c 'export HOME="$1"; unset LD_PRELOAD; shift; exec "$@"' _ "${HOME}" "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
  fi
else
  unset LD_PRELOAD
  exec "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
fi
