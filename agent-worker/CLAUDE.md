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
  actionable. This is reversible: an authorized maintainer can override it by
  @-mentioning the bot on the issue (see *Overriding a won't-fix / re-arming via
  @-mention* below).

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

The case journal lives **centrally** in `voltini.energy-backend` (the worker
keeps no local DB); `state.ts` is a thin async HTTP client over its
`/api/support/agent/*` endpoints, authenticated with the agent-worker service
token. A restart resumes in place by reading central. GitHub labels remain the
customer-facing source of truth. Central is now a hard dependency — if it's
unreachable a tick fails and retries rather than advancing on stale state.

```
NEW ── triage ──► not fixable ─────────────────► WONTFIX (close, Avvisad)
        │                                          └─ maintainer @-mention reopens + re-arms
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

### Post-completion PR feedback

After a case is DONE, each tick also watches its opened PR(s) for a maintainer
comment that **@-mentions the bot** (`BOT_GH_LOGIN`) — top-level *or* inline on
the diff. On finding one, the bot reopens a session on the PR branch
(`syncWorktreeToRemoteBranch`), makes the requested change, runs tests, pushes to
the **existing** PR branch, and replies on the PR. The support issue stays
**closed** — this is a developer-side refinement, so the customer is not
re-notified. Gates and safety:

- **Trigger** is the @-mention; ordinary review chatter is ignored.
- **Authorization:** write/maintain/admin on the *code repo where the PR lives*
  (`isAuthorizedMaintainer(login, codeRepoSlug)`) — customers can't trigger it.
- **Idempotency** is the same 👀-reaction marker as `/retry`; the bot reacts
  FIRST, then acts, so a mid-session crash needs a human rather than re-spending.
- **Fresh budget envelope** per feedback round (resets `cost_usd`, keeps
  `lifetime_cost_usd`), exactly like `/retry`.
- A merged/closed PR can't be amended: the bot replies saying so and sets the
  per-sub-task `pr_watch_closed` flag to stop polling that PR forever.
- The 5-perspective review is skipped for follow-ups (the maintainer is the
  reviewer); tests still gate the push.

---

## Module map (`src/`)

| File | Responsibility |
| --- | --- |
| `main.ts` | Startup (config, gh auth, labels, journal↔GitHub reconcile) + the poll loop. |
| `config.ts` | Strict env loading; throws on any missing required value. |
| `github.ts` | `gh` CLI wrapper, status derivation, issue + PR comment polling, reactions. |
| `repos.ts` | Discover pre-cloned repos in `REPOS_DIR`; git worktree create/remove/sync. |
| `state.ts` | Central case-journal HTTP client (over voltini.energy-backend's `/api/support/agent/*`). |
| `claude.ts` | Agent SDK `query()` wrapper (cwd, model, bypass, resume, structured output). |
| `askHuman.ts` | The `ask_human` MCP tool + parked-state signalling. |
| `triage.ts` | Triage session → `{ fixable, repoKey, reason }`. |
| `implement.ts` | Implement session + independent test-verify + PR-feedback session. |
| `review.ts` | Adapted `!perfect-review` (5 perspectives) + the fix session. |
| `pr.ts` | `git push` + `gh pr create`; PR-url parsing + branch push for follow-ups. |
| `pipeline.ts` | The per-case state machine; all customer-facing gates live here. |
| `prompts.ts` | Every prompt the bot uses, in one reviewable place. |

---

## Configuration

All config is env-only (no committed secrets). See `.env.example` for the full
list: `CLAUDE_CODE_OAUTH_TOKEN` / `MODEL`, `GH_TOKEN` / `BOT_GH_LOGIN` /
`SUPPORT_REPO`, `REPOS_DIR`, the central-backend connection
(`CENTRAL_API_BASE_URL` / `AGENT_WORKER_TOKEN`), and the behaviour knobs
(`POLL_INTERVAL_SEC`, `MAX_REVIEW_ITERS`, `MAX_TEST_ATTEMPTS`,
`MAX_IMPLEMENT_TURNS`, `MAX_BUDGET_PER_CASE_USD`).
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

Cost is persisted centrally (on the `support_case` row) and logged as a running
`$spent / $budget` line. Two case-level columns: `cost_usd` is the **current
attempt** (what the envelope is measured against; reset to 0 on a `/retry`), and
`lifetime_cost_usd` is the **durable per-bug total** across all attempts (use
this one to report what a bug cost). The per-repo `support_case_repo_task.cost_usd`
gives the breakdown by repo. The `addCost` endpoint applies both in one atomic
transaction and returns the new totals (so the worker needs no follow-up read). When the envelope
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

### Overriding a won't-fix / re-arming via @-mention

The issue-side equivalent of the post-completion PR-feedback loop. An authorized
maintainer can re-arm a terminal case — **won't-fix** *or* **needs-human** — by
**@-mentioning the bot** (`BOT_GH_LOGIN`) on the issue itself with what to do.
This is how a human overrides a won't-fix the bot got wrong: the close reflects
the bot's *own* judgement that the case isn't actionable, and a maintainer
outranks that.

`pipeline.rearmOnIssueMention` (polled each tick for WONTFIX + NEEDS_HUMAN cases;
won't-fix issues are *closed*, so they're pulled from the journal, not the open
list) **reopens** a closed won't-fix issue (dropping the `wontfix` label), gives
the case a **fresh budget envelope** (resets `cost_usd`, keeps
`lifetime_cost_usd`), un-sticks given-up sub-tasks, drops to `NEW`, and re-runs
it. Crucially, the maintainer's comment is handed to **triage as an authoritative
override directive** (`maintainerOverrideBlock` in `prompts.ts`) so triage
investigates and identifies the repo(s) instead of re-closing won't-fix — it only
returns not-fixable again if there's genuinely no code surface, and must say why.

Authorization, the @-mention word-boundary match (`findUnhandledMention`), the
👀-reaction idempotency marker, and the close-comment anchor all mirror `/retry`
and the PR-feedback loop. `/retry` (command, fresh attempt, no guidance) and an
@-mention (carries an instruction + can reopen a won't-fix) coexist; a plain
`/retry` doesn't @-mention the bot, so they never fire on the same comment.

Repos are **not** configured — a human pre-clones the workable repos into
`REPOS_DIR` (symlinks are followed); any git repo found there is fair game. If a
case needs a repo that isn't present, the bot keeps the case active and **retries
every tick until the repo is cloned** — it self-heals rather than parking.

---

## Commands

- `npm start` — run the worker (via tsx).
- `npm run dev` — run with tsx watch.
- `npm run backfill` — one-shot: seed central from existing GitHub history
  (case phases + PR links for every open/closed support issue). Run once when
  switching to central state. Cost/solution are NOT recoverable for historical
  cases (they only lived in the discarded local SQLite) — they show $0/empty and
  are captured in full for new work. See `src/backfill.ts`.
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
