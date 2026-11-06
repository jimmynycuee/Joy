# The agent container for untrusted repositories (T4.5): Claude Code, Codex, git and node, nothing else.
# Build with `pnpm joy container-build`; log the CLIs in with `pnpm joy container-login claude|codex`.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# The CLIs are distributed as global npm packages.
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
# Joy mounts a login folder of its own here; the owner's real home is never mounted.
ENV HOME=/joy-home
WORKDIR /joy-home
