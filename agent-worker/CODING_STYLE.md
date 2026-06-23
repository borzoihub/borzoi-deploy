# Coding Style — voltini-bugfixer

> **Philosophy** (inherited from the TheWorks/Voltini suite): readability over
> brevity; code is self-documenting through clear naming and structure; type
> safety is paramount.

This project follows the suite-wide conventions in
`../../borzoi-common/CODING_STYLE.md` (common TypeScript patterns) and
`../../borzoi-backend/CODING_STYLE.md` (service/error patterns). This file
records only what is **specific to this worker** or where it deliberately
diverges, so a reader who knows the suite knows what to expect here.

---

## Inherited conventions (apply unchanged)

- **English-only identifiers.** Files, classes, functions, variables, types,
  test names, comments, log messages — all English, regardless of the product's
  Swedish UI. (See `../../theworks-common/CLAUDE.md`.)
- **Naming:** `camelCase` values, `PascalCase` types/classes, `UPPER_SNAKE_CASE`
  constants, `I`-prefixed interfaces for data shapes, `Helper` suffix for static
  utility classes, `Service`/`Runner`/`Store` suffixes for stateful classes.
- **No obvious comments.** Explain *why*, not *what*.
- **Readability first:** prefer array methods over `for` loops; early-return
  guard clauses; template literals; `async/await` over `.then()`; optional
  chaining + nullish coalescing for genuine optionality.
- **Avoid `any`; use `unknown` + a type guard.** Be aggressive with generics and
  `Omit`/`Partial`/`Pick`.
- **No magic-constant fallbacks.** Every value that drives a decision must come
  from config, a documented derivation, or an explicit caller contract — else
  **fail loudly**. `config.ts` throws on any missing required env var rather than
  defaulting. A silent default that makes the bot act against a customer-facing
  issue is a defect.

## Dates & durations — always via `DateHelper`

Never construct or format dates by hand, and never use raw millisecond
constants. Use `DateHelper` from `@digistrada/theworks-common`:

```ts
import { DateHelper } from "@digistrada/theworks-common";

DateHelper.setLocale("sv-SE");                                    // once at startup
const intervalMs = DateHelper.duration(120, "seconds").asMilliseconds();
const stamp = DateHelper.format(new Date(), "YYYY-MM-DD HH:mm:ss");
```

---

## Project-specific divergences

This is a standalone long-running worker, **not** a tsoa/Express/TypeORM
backend. Two suite patterns therefore do **not** apply:

1. **No DI container.** The suite backends use `di.container.ts`; that is
   overkill here. Dependencies are wired once in a composition root (`main.ts`)
   and passed via constructor (e.g. `new Pipeline({ config, github, state,
   runner })`). Keep this shape — explicit constructor injection, no globals.

2. **No `IStatus` error objects.** There is no HTTP layer, so there is nothing
   to translate `IStatus` for. Throw plain `Error` with a clear, specific
   message (name the missing input / failing case). The poll loop in `main.ts`
   is the single catch boundary: it logs, records the error on the case row, and
   moves on so one bad case can't kill the worker.

### Runtime: ESM via tsx

The project is ESM (`"type": "module"`) and runs through **tsx** in dev and prod
(`npm start` → `tsx src/main.ts`). This matches borzoi-backend and is required:
the Claude Agent SDK is ESM-only and `theworks-common`'s bundle uses ESM bare
specifiers that Node's strict resolver rejects but tsx resolves leniently.
`tsconfig` uses `moduleResolution: Bundler` to mirror that runtime. Relative
imports carry `.js` extensions (allowed under Bundler) for forward-compat.

### Structured agent output

When a session must return data the code reasons over (triage verdict, test
result, review findings), define a **zod schema**, pass
`z.toJSONSchema(schema)` as the session's `outputSchema`, and re-validate the
returned `structured_output` with the same schema (`safeParse`) before trusting
it. Never parse free-form agent prose for control flow.

### Customer-facing actions are gated, not incidental

Every `gh` mutation that changes a support issue (label, close, comment) is a
customer-facing action. Such calls live only in `pipeline.ts` at the documented
gates and go through `github.ts`, which honours `DRY_RUN`. Do not scatter issue
mutations across modules, and never auto-close on low confidence — fall back to
`needs-human`.

---

## Writing unit tests

Tests use **mocha + chai** in `src/tests/**/*.spec.ts` (run with `npm test`).
Follow the suite testing philosophy from `../../borzoi-backend/CODING_STYLE.md`
("Writing Unit Tests"):

- **Test intent, not behaviour.** Ask "would this still pass if the logic were
  subtly broken?" If yes, it's too weak.
- **Every `it` has a meaningful assertion**; never silently skip with an early
  return — assert the precondition instead.
- **Exact expected values**, not wide ranges; explain non-obvious values with an
  inline calculation.
- **One scenario per `it`**; descriptions must match what is tested.
- **Round-trip / exhaustive coverage** for any codec or mapping driven by a
  source-of-truth list (e.g. `deriveStatus` over the full label/state matrix) so
  a new case can't silently slip past.

What to unit-test here: the pure, deterministic logic — `deriveStatus`,
`typeLabel`, comment-author filtering, the state-store resume transitions, slug
generation, review blocking/clean gating. The agent sessions themselves (triage,
implement, review) are not unit-tested — they are exercised with `DRY_RUN=1`
against a throwaway issue end to end.
