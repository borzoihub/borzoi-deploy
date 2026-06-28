# syntax=docker/dockerfile:1.7
#
# Voltini support-case resolver. Internal maintainer tool — runs on a dedicated
# headless box, NEVER on a customer Hub. Started via docker-compose.agent.yml.
#
# Runs via tsx (not compiled node): some transitive deps ship ESM bare
# specifiers that Node's strict resolver rejects; tsx resolves them leniently.
# Mirrors the borzoi-backend image.
FROM node:22-bookworm-slim
WORKDIR /app

# git + gh: the agent shells out to both inside the cloned repos.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# The repos are mounted from the host (different uid); allow git to use them.
RUN git config --system --add safe.directory '*'

COPY package*.json ./

# Install with a BuildKit secret holding the npm registry auth token — never
# baked into a layer. The registry below happens to be GitHub Packages today, so
# the token is currently a GitHub PAT (packages:read); point the registry URL
# elsewhere and any matching npm credential works just as well.
RUN --mount=type=secret,id=npm_token \
    if [ -f /run/secrets/npm_token ]; then \
      printf "//npm.pkg.github.com/:_authToken=%s\n@borzoihub:registry=https://npm.pkg.github.com\n@digistrada:registry=https://npm.pkg.github.com\n" \
        "$(cat /run/secrets/npm_token)" > .npmrc; \
    fi && \
    npm ci && \
    rm -f .npmrc

COPY . .

ENV NODE_ENV=production
# REPOS_DIR / STATE_DB point at the mounted /data volume (see compose file).
ENTRYPOINT ["npx", "tsx", "src/main.ts"]
