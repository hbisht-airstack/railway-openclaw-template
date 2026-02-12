# =============================================================================
# Stage 1: Build Openclaw from source
# Runs IN PARALLEL with Stage 2 (Docker BuildKit parallelizes independent stages)
# =============================================================================
FROM node:22-bookworm AS openclaw-build

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

ARG OPENCLAW_GIT_REF=main
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch workspace protocol references in extension package.json files
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

# Use cache mount for pnpm store — massively speeds up repeated builds
RUN pnpm install --no-frozen-lockfile
RUN pnpm build

ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build

# Extract mcporter skill here (avoids a second git clone in runtime stage)
RUN mkdir -p /opt/openclaw-skills \
  && if [ -d skills/mcporter ]; then cp -r skills/mcporter /opt/openclaw-skills/; fi


# =============================================================================
# Stage 2: Runtime system dependencies (Homebrew, apt packages)
# Runs IN PARALLEL with Stage 1
# =============================================================================
FROM node:22-bookworm AS runtime-deps

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential procps file git python3 pkg-config sudo \
  && rm -rf /var/lib/apt/lists/*

# Install Homebrew (must run as non-root user, then hand ownership to root)
RUN useradd -m -s /bin/bash linuxbrew \
  && echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER linuxbrew
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

USER root
RUN chown -R root:root /home/linuxbrew/.linuxbrew


# =============================================================================
# Stage 3: Final runtime image
# Depends on both Stage 1 and Stage 2 (starts after both complete)
# =============================================================================
FROM runtime-deps

ENV NODE_ENV=production
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

WORKDIR /app

# Wrapper deps (cached unless package.json / lockfile change)
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

# Install MCPorter CLI so the mcporter skill can execute it
RUN npm install -g mcporter mcp-remote

# Copy built openclaw + mcporter skill from build stage (no second git clone)
COPY --from=openclaw-build /openclaw /openclaw
COPY --from=openclaw-build /opt/openclaw-skills /opt/openclaw-skills

# Provide openclaw executable on PATH
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

# Copy wrapper source (last — changes most often, preserves cache above)
COPY src ./src

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
