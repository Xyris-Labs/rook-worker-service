FROM oven/bun:latest

# Install baseline dev dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @openai/codex \
    && curl -fsSL https://go.dev/dl/go1.22.1.linux-amd64.tar.gz | tar -C /usr/local -xzf - \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Add Go to PATH
ENV PATH=$PATH:/usr/local/go/bin

# Set up working directory for persistent volume mount
WORKDIR /workspace

# Set up app directory for sidecar code
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install

# Copy source code
COPY src ./src

# Entrypoint
ENTRYPOINT ["bun", "run", "src/index.ts"]
