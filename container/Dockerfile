# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium + Python (for a-mem MCP)
RUN apt-get update && apt-get install -y \
    chromium \
    poppler-utils \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Google Data libraries — used by ~/.google-data/bin/*.mjs scripts
# (GA4 Data API + googleapis for YouTube Analytics & Data API v3).
# NODE_PATH=/usr/local/lib/node_modules (set below) makes them resolvable
# from any working directory, so scripts in the read-only mount can import them.
RUN npm install -g @google-analytics/data googleapis

# --- a-mem MCP (semantic memory over ChromaDB + Ollama) ---
# HuggingFace cache lives inside the image so the sentence-transformers
# embedding model is always available without network access at runtime.
ENV HF_HOME=/opt/a-mem/hf-cache
ENV PATH="/opt/doc-tools/.venv/bin:/opt/a-mem/.venv/bin:${PATH}"

# Copy a-mem source (git submodule at container/a-mem-mcp/) before pip install
# so layer caching works well — source changes bust the install, but base deps
# stay cached.
COPY a-mem-mcp/ /opt/a-mem-mcp/
COPY doc-tools/ /opt/doc-tools/

RUN python3 -m venv /opt/a-mem/.venv \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir \
         --index-url https://download.pytorch.org/whl/cpu \
         torch \
    && /opt/a-mem/.venv/bin/pip install --no-cache-dir \
         -e /opt/a-mem-mcp \
         ollama \
    && /opt/a-mem/.venv/bin/python -c \
         "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')" \
    && python3 -m venv /opt/doc-tools/.venv \
    && /opt/doc-tools/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/doc-tools/.venv/bin/pip install --no-cache-dir 'markitdown[all]' \
    && /opt/doc-tools/.venv/bin/pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu docling \
    && mkdir -p /opt/doc-tools/.venv/lib/python3.11/site-packages/rapidocr/models \
    && chmod -R a+rX /opt/a-mem /opt/a-mem-mcp /opt/doc-tools \
    && chmod -R a+rwX /opt/doc-tools/.venv/lib/python3.11/site-packages/rapidocr/models

# context-mode MCP plugin (path resolved at runtime via createRequire).
# NODE_PATH makes globally-installed packages (context-mode, agent-browser,
# @anthropic-ai/claude-code) resolvable from any working directory — without
# this, require.resolve('context-mode/...') from /app/dist/index.js fails
# because default resolution doesn't traverse /usr/local/lib/node_modules.
RUN npm install -g context-mode
ENV NODE_PATH=/usr/local/lib/node_modules

# --- Dev tools layer ---
# Added for the AVP-Outreach Madison variant; harmless for other Madisons.
# Kept as a separate layer so the heavy a-mem / doc-tools layers stay cached
# when these versions bump.
RUN apt-get update && apt-get install -y \
    ripgrep \
    fd-find \
    jq \
    fzf \
    build-essential \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (pinned binary release) — simpler than maintaining its apt repo
# key + source.list inside the Dockerfile.
RUN ARCH=$(dpkg --print-architecture) \
    && GH_VERSION=2.62.0 \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv /tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh*

# uv + uvx (Astral Python package manager) — pinned binary release.
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) UV_ARCH=x86_64-unknown-linux-gnu ;; \
         arm64) UV_ARCH=aarch64-unknown-linux-gnu ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && UV_VERSION=0.5.4 \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_ARCH}.tar.gz" -o /tmp/uv.tar.gz \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && mv /tmp/uv-${UV_ARCH}/uv /tmp/uv-${UV_ARCH}/uvx /usr/local/bin/ \
    && rm -rf /tmp/uv*

# Bake a default SSH config so `git@gitlab.com` uses the per-group mounted
# key when present. NanoClaw forces additional mounts under
# /workspace/extra/, so the IdentityFile path points there — groups that
# mount their gitlab key as containerPath ".ssh/gitlab" get it at
# /workspace/extra/.ssh/gitlab. Groups that don't mount the key are
# unaffected: git push to gitlab.com simply won't work for them.
RUN mkdir -p /home/node/.ssh \
    && printf 'Host gitlab.com\n  IdentityFile /workspace/extra/.ssh/gitlab\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' > /home/node/.ssh/config \
    && chmod 700 /home/node/.ssh \
    && chmod 600 /home/node/.ssh/config \
    && chown -R node:node /home/node/.ssh

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
