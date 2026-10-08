# Copyright 2026 IOG.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Builds the fee sponsor service into an image that carries the compiled
# service, its production dependencies and the blueprint of the contract
# build it serves, and no configuration: every value the service needs,
# the mnemonic above all, comes from the environment the container is
# started with, and the service refuses to start without it.

# The base image is pinned by digest in both stages so that a build is
# reproducible; dependabot proposes the bumps.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder

# better-sqlite3, the only native addon, ships its prebuilt binaries for
# linux amd64 and arm64 inside the package and compiles nothing. npm ci
# still runs node-gyp for it: the lockfile does not carry the package's
# gypfile flag, so npm sees its binding.gyp and schedules a rebuild, which
# only configures, finds the prebuilt binary and builds nothing. python3
# runs that configure step and make the empty build; no compiler is used.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# The dependencies are installed before the sources are copied, so that a
# change to the service alone reuses the installed layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY contract ./contract

# Once compiled, the development dependencies are removed so the runtime
# stage copies production dependencies only.
RUN npm run build \
    && npm prune --omit=dev

# ---
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

LABEL org.opencontainers.image.source=https://github.com/Biglup/cardano-account-custody-fee-sponsor
LABEL org.opencontainers.image.description="Fee sponsor service for the Cardano account custody contract"
LABEL org.opencontainers.image.licenses=Apache-2.0

# Build arguments rather than ENV, so that the apt-get step runs without
# prompts and the final image carries no environment beyond its own two
# defaults below.
ARG DEBCONF_NONINTERACTIVE_SEEN=true
ARG DEBIAN_FRONTEND=noninteractive

# tini reaps and forwards signals to node; the certificates let the
# service reach the provider over TLS.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 60000 nonroot \
    && useradd --no-log-init --create-home \
        --uid 60000 \
        --gid 60000 \
        --shell /sbin/nologin \
        nonroot

WORKDIR /app

COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/contract/plutus.json ./contract/plutus.json

# The sqlite database is the service's only state; it lives on a volume
# the operator keeps, which the service user must be able to write.
RUN mkdir /data \
    && chown nonroot:nonroot /data
VOLUME ["/data"]

# The only defaults the image carries: where the database lives on the
# volume and which port is exposed. Everything else is the operator's.
ENV DATABASE_PATH=/data/sponsor.sqlite
ENV PORT=8787
EXPOSE 8787

# The health route answers once the service has synced the pool and is
# listening, so a container that cannot reach its provider never turns
# healthy; node's own fetch keeps curl out of the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"]

USER nonroot

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "dist/main.js"]
