FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Optional override URL (must be https://); when empty, automatically resolves & signs the latest official Tencent Linux QQ .deb for the build architecture
ARG QQ_DEB_URL=""
# Optional SHA-256 checksum for /tmp/linuxqq.deb; verified when non-empty
ARG QQ_DEB_SHA256=""
# Set to "1" in reproducible/production builds to require a pinned QQ_DEB_SHA256
ARG REQUIRE_QQ_DEB_SHA256="0"

RUN if [ "${REQUIRE_QQ_DEB_SHA256}" = "1" ] && [ -z "${QQ_DEB_SHA256}" ]; then \
      echo "ERROR: QQ_DEB_SHA256 is required when REQUIRE_QQ_DEB_SHA256=1" >&2; \
      exit 1; \
    fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dbus \
    dbus-x11 \
    fluxbox \
    fonts-noto-cjk \
    gosu \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0t64 \
    libnotify4 \
    libnss3 \
    libpango-1.0-0 \
    libsecret-1-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    nodejs \
    novnc \
    procps \
    tini \
    websockify \
    x11vnc \
    xdg-utils \
    xvfb \
  && DEB_ARCH="$(dpkg --print-architecture)" \
  && RAW_QQ_URL="${QQ_DEB_URL}" \
  && if [ -z "${RAW_QQ_URL}" ]; then \
       PC_CFG="$(curl --proto '=https' --tlsv1.2 -fsSL https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json || curl --proto '=https' --tlsv1.2 -fsSL https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json)" \
       && RAW_QQ_URL="$(printf '%s' "${PC_CFG}" | DEB_ARCH="${DEB_ARCH}" node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).Linux||{}; const a=process.env.DEB_ARCH; const u=a==="arm64"?c.armDownloadUrl?.deb:a==="loongarch64"?(c.loongarchDownloadUrl?.deb||c.loongarchDownloadUrl):a==="mips64el"?(c.mipsDownloadUrl?.deb||c.mipsDownloadUrl):c.x64DownloadUrl?.deb; if(!u)process.exit(1); process.stdout.write(u);')"; \
     fi \
  && RESOLVED_QQ_URL="${RAW_QQ_URL}" \
  && case "${RAW_QQ_URL}" in \
       https://qqdl.gtimg.cn/*) \
         case "${RAW_QQ_URL}" in \
           *sign=*) ;; \
           *) \
             SIGN_BODY="$(RAW_QQ_URL="${RAW_QQ_URL}" node -e 'process.stdout.write(JSON.stringify({url:process.env.RAW_QQ_URL}))')" \
             && SIGN_RESP="$(curl --proto '=https' --tlsv1.2 -fsSL -X POST https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign -H 'Content-Type: application/json' -H 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' -d "${SIGN_BODY}")" \
             && RESOLVED_QQ_URL="$(printf '%s' "${SIGN_RESP}" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); if(r.retcode!==0||!r.data?.url)process.exit(1); process.stdout.write(r.data.url);')" \
             ;; \
         esac \
         ;; \
     esac \
  && case "${RESOLVED_QQ_URL}" in \
       https://*) ;; \
       *) \
         echo "ERROR: Refusing non-HTTPS QQ .deb URL: ${RESOLVED_QQ_URL}" >&2; \
         exit 1; \
         ;; \
     esac \
  && curl --proto '=https' --tlsv1.2 -fsSL "${RESOLVED_QQ_URL}" -o /tmp/linuxqq.deb \
  && COMPUTED_SHA256="$(sha256sum /tmp/linuxqq.deb | cut -d' ' -f1)" \
  && echo "[rosmontis] Downloaded /tmp/linuxqq.deb SHA-256: ${COMPUTED_SHA256}" \
  && if [ -n "${QQ_DEB_SHA256}" ]; then \
       printf '%s  /tmp/linuxqq.deb\n' "${QQ_DEB_SHA256}" | sha256sum -c -; \
     fi \
  && apt-get install -y --no-install-recommends /tmp/linuxqq.deb \
  && rm -f /tmp/linuxqq.deb \
  && rm -rf /var/lib/apt/lists/*

RUN (getent group 1000 >/dev/null || groupadd -g 1000 rosmontis) \
  && (id -u 1000 >/dev/null 2>&1 || useradd -u 1000 -g 1000 -d /app -s /bin/bash -M rosmontis) \
  && mkdir -p /app/.config /app/.fluxbox /app/.local/share /app/data/config /opt/rosmontis /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chown -R 1000:1000 /app

COPY src /opt/rosmontis/src
COPY scripts /opt/rosmontis/scripts
RUN chmod +x /opt/rosmontis/scripts/*.sh \
  && bash /opt/rosmontis/scripts/install_bridge.sh

WORKDIR /app
EXPOSE 3000 3001 6081

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD bash -c 'pgrep -f "${QQ_BIN:-/opt/QQ/qq}" >/dev/null || exit 1; if [ "${ROSMONTIS_HTTP_ENABLE:-1}" = "0" ]; then exit 0; fi; PORT="${ROSMONTIS_HTTP_PORT:-${ONEBOT_HTTP_PORT:-${XIAO_BRIDGE_HTTP_PORT:-3000}}}"; CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${PORT}/health" || true)"; [ "${CODE}" = "200" ] || [ "${CODE}" = "401" ] || [ "${CODE}" = "403" ]'

ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/opt/rosmontis/scripts/entrypoint.sh"]
