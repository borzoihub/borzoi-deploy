# voltini-bugfixer — autonomous support-case resolver

An internal maintainer tool that resolves customer support cases end to end,
unattended, on a headless Linux box. It polls the Voltini support tracker,
triages each case, fixes it across the pre-cloned code repos using the Claude
Agent SDK, runs and writes tests, self-reviews until clean, opens a pull
request, and updates the customer-facing issue status.

Lives in `borzoi-deploy` so a fresh box can `git pull` → install → drop in an
`.env` → run. It is delivered as a **separate** Docker compose file
(`../docker-compose.agent.yml`) and must **never** run on a customer Raspberry
Pi — it runs on a dedicated dev/ops machine.

For coding conventions, see `CODING_STYLE.md`.
For the support-case lifecycle and exact `gh` recipes, see
`../../voltini-support/CLAUDE.md` (canonical) and
`../../voltini.energy-backend/docs/SUPPORT_CASES.md`.

---

## Where this fits in the Voltini ecosystem

Customer bug reports filed from the Voltini app's AI chat land as GitHub issues
on **`borzoihub/voltini-support`** (the support tracker). Their status is
visible to the homeowner in the app, and a status change pushes a notification.
This tool takes over the human triage→fix→PR→status loop for cases that can be
resolved autonomously.

> **Naming note.** `borzoi-*` is the historical name for what is marketed as
> **Voltini**. Repo names are kept; code identifiers stay English; customer-
> facing text says "Voltini", never "Borzoi".

### Customer-facing autonomy

Changing a support issue's labels/state is a customer-facing action (it pushes a
notification). This bot is **authorized to do that autonomously** — overriding
the usual "ask a human first" rule — but only at gated points:

- `in-progress` (→ *Under utredning*) when it starts work after triage.
- close as resolved (→ *Löst*) **only** after tests pass, review is clean, and a
  PR exists.
- close as won't-fix (→ *Avvisad*) **only** when triage finds the case not
  actionable.

Anything uncertain (tests won't pass, review won't converge, the right repo
isn't cloned, an error) falls back to a `needs-human` label + comment — it never
auto-closes on low confidence. That gate is the safety substitute for the human
confirmation step.

---

## Execution engine

The bot drives Claude headlessly via the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`, the `query()` API) — multi-turn agent
sessions running inside a repo worktree with permissions bypassed, so they can
edit files, run bash/git/gh/npm unattended. Structured outputs (triage verdict,
test result, review findings) use the SDK's `outputFormat` with zod-derived JSON
schemas. The SDK authenticates against a **Claude subscription** (Pro/Max) using
a long-lived OAuth token — no per-token API/Bedrock billing. The token is minted
once with `claude setup-token` (on any machine with a browser, logged into the
subscription), set as `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, and surfaced into the
environment by `main.ts` for the SDK. The first-party model id is set via
`MODEL` (e.g. `claude-opus-4-8`).

> `theworks-be/AiService` is a single-shot Bedrock `Converse` wrapper — it
> cannot drive an agentic coding loop, so it is intentionally not used here. We
> reuse `@digistrada/theworks-common` for date/duration handling.
>
> **Subscription caveats.** The token expires (~1 year) — regenerate before it
> lapses. Subscription plans carry 5-hour rolling *and* weekly usage caps; this
> pipeline is token-heavy per case (triage + implement + test + 5-perspective
> review + fix loops on Opus), so a busy queue can hit them. Consider a cheaper
> model for triage/test-verify if that becomes a problem.

---

## Pipeline (per case)

A SQLite journal (`state.ts`) records each case's phase so a restart resumes in
place; GitHub labels remain the customer-facing source of truth.

```
NEW ── triage ──► not fixable ─────────────────► WONTFIX (close, Avvisad)
        │              repo not cloned ─────────► NEEDS_HUMAN
        ▼ fixable + repo present
BRANCH  (add in-progress; git worktree off default branch: features/<id>-<slug>)
        ▼
IMPLEMENT  (autonomous fix + tests + commit; may park on ask_human → BLOCKED)
        ▼
TEST  (independent verify; on fail, re-implement up to MAX_TEST_ATTEMPTS)
        ▼
REVIEW  (5-perspective review; blocking findings → fix → re-review,
         up to MAX_REVIEW_ITERS; Minor/nitpicks skipped)
        ▼
PR  (git push + gh pr create against the default branch)
        ▼
DONE  (close resolved, Löst; comment PR link; remove worktree)
```

**Human-in-the-loop:** the implement/review sessions have an `ask_human` MCP
tool. Calling it aborts the session; the orchestrator posts the question as an
issue comment and parks the case (BLOCKED). Each poll tick checks BLOCKED cases
for a reply by a non-bot author after the question comment, then resumes the
saved Agent SDK session with the answer.

---

## Module map (`src/`)

| File | Responsibility |
| --- | --- |
| `main.ts` | Startup (config, gh auth, labels) + the poll loop. |
| `config.ts` | Strict env loading; throws on any missing required value. |
| `github.ts` | `gh` CLI wrapper, status derivation, comment polling. Mutations honour `DRY_RUN`. |
| `repos.ts` | Discover pre-cloned repos in `REPOS_DIR`; git worktree create/remove. |
| `state.ts` | SQLite resume journal (one row per issue). |
| `claude.ts` | Agent SDK `query()` wrapper (cwd, model, bypass, resume, structured output). |
| `askHuman.ts` | The `ask_human` MCP tool + parked-state signalling. |
| `triage.ts` | Triage session → `{ fixable, repoKey, reason }`. |
| `implement.ts` | Implement session + independent test-verify session. |
| `review.ts` | Adapted `!perfect-review` (5 perspectives) + the fix session. |
| `pr.ts` | `git push` + `gh pr create`. |
| `pipeline.ts` | The per-case state machine; all customer-facing gates live here. |
| `prompts.ts` | Every prompt the bot uses, in one reviewable place. |

---

## Configuration

All config is env-only (no committed secrets). See `.env.example` for the full
list: `CLAUDE_CODE_OAUTH_TOKEN` / `MODEL`, `GH_TOKEN` / `BOT_GH_LOGIN` /
`SUPPORT_REPO`, `REPOS_DIR`, and the behaviour knobs (`POLL_INTERVAL_SEC`,
`MAX_REVIEW_ITERS`, `MAX_TEST_ATTEMPTS`, `MAX_IMPLEMENT_TURNS`, `STATE_DB`,
`DRY_RUN`). The worker refuses to start if `CLAUDE_CODE_OAUTH_TOKEN` or `MODEL`
is missing.

Repos are **not** configured — a human pre-clones the workable repos into
`REPOS_DIR`; any git repo found there is fair game. If a case needs a repo
that isn't present, the bot parks it as `needs-human`.

---

## Commands

- `npm start` — run the worker (via tsx).
- `npm run dev` — run with tsx watch.
- `npm test` — mocha + chai unit tests (`src/tests/**/*.spec.ts`).
- `npm run typecheck` — `tsc --noEmit`.

Deployment: `docker compose -f ../docker-compose.agent.yml up -d --build`
(BuildKit secret `npm_token` for npm registry auth; `restart: unless-stopped`
auto-starts on boot). See the compose file header for the fresh-box runbook.

---

## Shared package workflow

`@digistrada/theworks-common` is consumed from the GitHub npm registry (the
`@digistrada` scope is mapped in `~/.npmrc` locally and via the BuildKit
`npm_token` secret in Docker). Use it for date/duration handling — never hand-roll
dates. To change it, follow its own deploy/sync workflow in
`../../theworks-common/CLAUDE.md`.
