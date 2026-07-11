# syntax=docker/dockerfile:1.7

# Build-time ARGs that participate in FROM substitutions or cross-stage usage
# must be declared in the global scope (before any FROM). They still need to
# be re-declared inside the stages that consume them in RUN / LABEL / ENV —
# global ARGs are only visible to FROM lines.
ARG BUILD_FROM
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

# ─── Stage 1 — install server deps (tsx is RUNTIME, not just dev) ─────────────
# Uses Docker Hub's multi-arch node:22-alpine; HA Supervisor's build runs on
# the target arch so we never cross-compile. There is no server compile step —
# the server runs raw TypeScript via tsx, so tsx MUST stay a real dependency
# (do NOT `npm ci --omit=dev` it away) or startup breaks.
#
# NOTE: no `web/` build stage in v0.1 — the browser terminal (`/console`) is a
# self-contained xterm.js page vendored from node_modules, so there is no Vite
# SPA to bundle yet (that arrives in a later phase). Stage 3 copies only the
# server + its node_modules, matching that.
FROM node:22-alpine AS serverdeps
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci


# ─── Stage 2 — Home Assistant add-on runtime ─────────────────────────────────
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# HA base images are Alpine + s6-overlay + bashio. Add Node 22 (Alpine 3.21+
# main repo) and a CA bundle for outbound TLS.
RUN apk add --no-cache nodejs npm ca-certificates tzdata

ENV NODE_ENV=production \
    PORT=8788 \
    HOST=0.0.0.0 \
    DB_PATH=/data/zwave.db

WORKDIR /app
COPY server/ ./server/
COPY --from=serverdeps /build/server/node_modules ./server/node_modules

# s6 service runner — bashio translates HA Options into env vars at start time.
# The s6 service dir uses a HYPHEN (zwave-tui); the add-on slug uses an
# underscore (zwave_tui). Do not conflate them.
COPY rootfs/ /
RUN chmod a+x /etc/services.d/zwave-tui/run

# Web + API on 8788; telnet TUI on 2324.
EXPOSE 8788 2324

# Add-on metadata — re-declare the ARGs we need inside this stage so LABEL
# can substitute them.
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION
LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.source="https://github.com/${BUILD_REPOSITORY}" \
    org.opencontainers.image.revision="${BUILD_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.licenses="MIT"

# Promote the build metadata to runtime ENV so /api/version reports the real
# release instead of "dev". These were ARG-only (consumed by LABEL above) and
# therefore absent from the running process's environment, so
# process.env.BUILD_VERSION would otherwise always be undefined.
ENV BUILD_VERSION=${BUILD_VERSION} \
    BUILD_DATE=${BUILD_DATE} \
    BUILD_REF=${BUILD_REF}
