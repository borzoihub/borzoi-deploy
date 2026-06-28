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
        │              repo not cloned ─────────► WAIT (retry every tick until cloned)
        ▼ fixable
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
| `main.ts` | Startup (config, gh auth, labels, journal↔GitHub reconcile) + the poll loop. |
| `config.ts` | Strict env loading; throws on any missing required value. |
| `github.ts` | `gh` CLI wrapper, status derivation, comment polling. |
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
`MAX_REVIEW_ITERS`, `MAX_TEST_ATTEMPTS`, `MAX_IMPLEMENT_TURNS`,
`MAX_BUDGET_PER_CASE_USD`, `STATE_DB`).
The worker refuses to start if `CLAUDE_CODE_OAUTH_TOKEN` or `MODEL`
is missing.

### Per-case cost budget

`MAX_BUDGET_PER_CASE_USD` is the **primary** runaway guard: a hard ceiling on the
notional API cost of resolving one case, summed across every Agent SDK session it
runs. The per-session turn caps (`MAX_IMPLEMENT_TURNS`, and the read-pass turn
constants in `triage.ts` / `implement.ts` / `review.ts`) are now only a secondary
backstop, kept generous so the budget binds first. Each session is given the
case's *remaining* envelope as its `maxBudgetUsd`, so spend can't exceed the
ceiling. Cost is "notional" (billing is via a Claude subscription, not per-token),
but it's a faithful proxy for tokens spent — the real scarce resource against the
plan's rolling/weekly caps.

Cost is persisted in the journal and logged as a running `$spent / $budget`
line. Two case-level columns: `cost_usd` is the **current attempt** (what the
envelope is measured against; reset to 0 on a `/retry`), and `lifetime_cost_usd`
is the **durable per-bug total** across all attempts (use this one to report what
a bug cost). Per-repo `cost_usd` gives the breakdown by repo. When the envelope
is exhausted, phases **hard-fail** to needs-human (triage, implement,
test-verify, review-fix — their output is a precondition to shipping), **except**
the advisory review read-pass, which **soft-fails**: the
already-implemented-and-tested work still ships and the case closes resolved with
a caveat that the automated review didn't finish (`review_incomplete`). The SDK
emits a result *and then throws* on `error_max_budget_usd` / `error_max_turns`;
`claude.ts` normalises both into a clean `limitHit` signal (see the
`agent-sdk-budget-throws` note).

### Re-running a needs-human case (`/retry`)

A parked needs-human case is re-armed when an **authorized maintainer** comments
`/retry` (the constant `RETRY_COMMAND`) after the bot's hand-off comment.
Authorization = **write/maintain/admin on the support repo**, checked live via
`gh api repos/<repo>/collaborators/<login>/permission` (`role_name`). This is the
gate because customers are never repo collaborators, so they can't trigger a
re-run; org membership is deliberately NOT used (a private member reads as 404
and the membership endpoint is often 403 to a PAT, which would wrongly deny real
maintainers). `pipeline.retryIfRequested` (polled each tick for NEEDS_HUMAN
cases) gives the case a **fresh budget envelope** (resets `cost_usd`, keeps
`lifetime_cost_usd`), un-sticks given-up repo sub-tasks, drops both labels to land
on `NEW`, and lets the normal recover→work path continue with the new budget.

**Idempotency** is a 👀 reaction the bot adds to the `/retry` comment when it acts
(`acknowledgeCommand`); `findUnhandledCommand` skips any command it has already
reacted to. So each `/retry` fires exactly once — across ticks, restarts, and
multiple stacked `/retry` comments — and the maintainer gets a visible "picked it
up" signal. The `needs_human_comment_id` anchor scopes the scan to the current
hand-off; a null anchor (a case parked before this feature existed) scans all
comments and relies on the reaction marker, so legacy cases stay `/retry`-able.

Repos are **not** configured — a human pre-clones the workable repos into
`REPOS_DIR` (symlinks are followed); any git repo found there is fair game. If a
case needs a repo that isn't present, the bot keeps the case active and **retries
every tick until the repo is cloned** — it self-heals rather than parking.

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
