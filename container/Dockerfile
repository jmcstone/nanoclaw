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

# --- a-mem MCP (semantic memory over ChromaDB + Ollama) ---
# HuggingFace cache lives inside the image so the sentence-transformers
# embedding model is always available without network access at runtime.
ENV HF_HOME=/opt/a-mem/hf-cache
ENV PATH="/opt/a-mem/.venv/bin:${PATH}"

# Copy a-mem source (git submodule at container/a-mem-mcp/) before pip install
# so layer caching works well — source changes bust the install, but base deps
# stay cached.
COPY a-mem-mcp/ /opt/a-mem-mcp/

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
    && chmod -R a+rX /opt/a-mem /opt/a-mem-mcp

# context-mode MCP plugin (path resolved at runtime via createRequire)
RUN npm install -g context-mode

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
