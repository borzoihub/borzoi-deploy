# voltini-bugfixer

Autonomous resolver for Voltini support cases. Polls
`borzoihub/voltini-support`, triages each case, fixes it across the pre-cloned
code repos using the Claude Agent SDK, runs/writes tests, self-reviews until
clean, opens a PR, and updates the customer-facing issue status — unattended.

**Internal maintainer tool. Runs on a dedicated headless box, never on a
customer Hub.** See [CLAUDE.md](./CLAUDE.md) for architecture and
[CODING_STYLE.md](./CODING_STYLE.md) for conventions.

## Run with Docker (recommended)

From the `borzoi-deploy` repo root, on a fresh Linux box:

```bash
git pull

# 1. Configure
cp agent-worker/.env.example agent-worker/.env
$EDITOR agent-worker/.env                       # CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, etc.

# 2. npm registry auth for `npm ci` (BuildKit secret, never baked into image).
#    Registry is GitHub Packages today, so this is a GitHub PAT (packages:read).
printf '%s' "<npm-registry-token>" > agent-worker/.npmtoken

# 3. Clone the repos the bot may fix into the mounted repos dir
mkdir -p agent-data/repos
git -C agent-data/repos clone https://github.com/borzoihub/borzoi-backend.git
# ...clone any other repos you want it to work on

# 4. Start (auto-restarts on boot via restart: unless-stopped)
docker compose -f docker-compose.agent.yml up -d --build
docker compose -f docker-compose.agent.yml logs -f
```

**First run:** set `DRY_RUN=1` in `.env` and open a throwaway test issue — the
bot does everything except the customer-facing GitHub mutations (it logs the
`gh` commands it would run). Flip to `DRY_RUN=0` once you've watched it work.

## Run locally (dev)

```bash
cd agent-worker
npm install                 # @digistrada scope resolves via your ~/.npmrc
cp .env.example .env        # point REPOS_DIR / STATE_DB at local paths
npm start                   # or: npm run dev   (tsx watch)
npm test                    # mocha + chai
npm run typecheck
```
