import { expect } from "chai";
import { StateStore } from "../state.js";

/**
 * The StateStore is now a thin HTTP client over the central backend's
 * `/api/support/agent/*` endpoints. These tests run it against an in-memory
 * mock `fetch` that mirrors the backend contract (support-agent.service.ts), so
 * they validate the client's URL/method/body mapping AND the same behaviour the
 * old SQLite store guaranteed (idempotent upsert, partial patch, phase filter,
 * atomic cost with a lifetime total).
 */

interface RepoTask {
  repoKey: string;
  scope: string | null;
  phase: string;
  branch: string | null;
  resumePhase: string | null;
  sessionId: string | null;
  blockedCommentId: string | null;
  testAttempts: number;
  reviewIters: number;
  prUrl: string | null;
  error: string | null;
  costUsd: number;
  reviewIncomplete: boolean;
  prWatchClosed: boolean;
  fixSummary: string | null;
  updatedAt: string;
}

interface Case {
  issueNumber: number;
  phase: string | null;
  title: string | null;
  error: string | null;
  costUsd: number;
  lifetimeCostUsd: number;
  needsHumanCommentId: string | null;
  solutionSummary: string | null;
  updatedAt: string | null;
  repoTasks: Map<string, RepoTask>;
}

/** A minimal in-memory backend behind a mock `fetch`. */
function mockBackend(): typeof fetch {
  const cases = new Map<number, Case>();

  const caseDto = (c: Case) => ({
    issueNumber: c.issueNumber,
    phase: c.phase,
    title: c.title,
    error: c.error,
    costUsd: c.costUsd,
    lifetimeCostUsd: c.lifetimeCostUsd,
    needsHumanCommentId: c.needsHumanCommentId,
    solutionSummary: c.solutionSummary,
    updatedAt: c.updatedAt,
    repoTasks: [...c.repoTasks.values()].sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
  });

  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status });

  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parts = url.pathname.replace(/^\/api\/support\/agent\//, "").split("/");
    // parts: ["cases"] | ["cases", n] | ["cases", n, "cost"] | ["cases", n, "repos", key]

    if (parts[0] !== "cases") return json({}, 404);

    if (parts.length === 1) {
      // GET /cases?phase=
      const phase = url.searchParams.get("phase");
      const list = [...cases.values()]
        .filter((c) => c.phase != null && (!phase || c.phase === phase))
        .sort((a, b) => a.issueNumber - b.issueNumber)
        .map(caseDto);
      return json(list);
    }

    const n = Number(parts[1]);
    const existing = cases.get(n);

    if (parts.length === 2 && method === "PUT") {
      // ensure
      if (!existing) {
        cases.set(n, {
          issueNumber: n,
          phase: "NEW",
          title: body?.title ?? null,
          error: null,
          costUsd: 0,
          lifetimeCostUsd: 0,
          needsHumanCommentId: null,
          solutionSummary: null,
          updatedAt: "t",
          repoTasks: new Map(),
        });
      }
      return json(caseDto(cases.get(n)!));
    }

    if (parts.length === 2 && method === "GET") {
      return existing ? json(caseDto(existing)) : json({}, 404);
    }

    if (parts.length === 2 && method === "PATCH") {
      if (!existing) return json({}, 404);
      for (const k of ["phase", "title", "error", "costUsd", "lifetimeCostUsd", "needsHumanCommentId", "solutionSummary"]) {
        if (body[k] !== undefined) (existing as unknown as Record<string, unknown>)[k] = body[k];
      }
      return json(caseDto(existing));
    }

    if (parts.length === 3 && parts[2] === "cost" && method === "POST") {
      if (!existing) return json({}, 404);
      const delta = Number(body?.deltaUsd ?? 0);
      if (delta > 0) {
        existing.costUsd += delta;
        existing.lifetimeCostUsd += delta;
      }
      let repoCostUsd: number | null = null;
      if (body?.repoKey) {
        const t = existing.repoTasks.get(body.repoKey);
        if (t) {
          if (delta > 0) t.costUsd += delta;
          repoCostUsd = t.costUsd;
        }
      }
      return json({ costUsd: existing.costUsd, lifetimeCostUsd: existing.lifetimeCostUsd, repoCostUsd });
    }

    if (parts.length === 4 && parts[2] === "repos") {
      const repoKey = decodeURIComponent(parts[3]!);
      if (!existing) return json({}, 404);
      if (method === "PUT") {
        if (!existing.repoTasks.has(repoKey)) {
          existing.repoTasks.set(repoKey, {
            repoKey,
            scope: body?.scope ?? null,
            phase: "BRANCH",
            branch: body?.branch ?? null,
            resumePhase: null,
            sessionId: null,
            blockedCommentId: null,
            testAttempts: 0,
            reviewIters: 0,
            prUrl: null,
            error: null,
            costUsd: 0,
            reviewIncomplete: false,
            prWatchClosed: false,
            fixSummary: null,
            updatedAt: "t",
          });
        }
        return json(existing.repoTasks.get(repoKey));
      }
      if (method === "PATCH") {
        const t = existing.repoTasks.get(repoKey);
        if (!t) return json({}, 404);
        Object.assign(t, body);
        return json(t);
      }
    }

    return json({}, 404);
  }) as typeof fetch;
}

let originalFetch: typeof fetch;
function freshStore(): StateStore {
  globalThis.fetch = mockBackend();
  return new StateStore("https://central.test", "tok");
}

before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

describe("StateStore", () => {
  it("ensure() creates a NEW row and is idempotent", async () => {
    const store = freshStore();
    const first = await store.ensure(42, "EV charging miscalculation");
    expect(first.phase).to.equal("NEW");
    expect(first.title).to.equal("EV charging miscalculation");

    await store.update(42, { phase: "WORKING" });
    const second = await store.ensure(42, "EV charging miscalculation");
    expect(second.phase).to.equal("WORKING");
  });

  it("update() patches only provided case fields and leaves others intact", async () => {
    const store = freshStore();
    await store.ensure(7, "Title");
    await store.update(7, { phase: "WORKING" });

    const row = (await store.get(7))!;
    expect(row.phase).to.equal("WORKING");
    expect(row.title).to.equal("Title");
  });

  it("allInPhase() filters cases by phase", async () => {
    const store = freshStore();
    await store.ensure(1, "a");
    await store.ensure(2, "b");
    await store.ensure(3, "c");
    await store.update(2, { phase: "BLOCKED" });

    const blocked = await store.allInPhase("BLOCKED");
    expect(blocked.map((r) => r.issueNumber)).to.deep.equal([2]);

    const newOnes = await store.allInPhase("NEW");
    expect(newOnes.map((r) => r.issueNumber)).to.deep.equal([1, 3]);
  });

  it("get() returns undefined for an unknown case", async () => {
    const store = freshStore();
    expect(await store.get(999)).to.equal(undefined);
  });
});

describe("StateStore — per-repo sub-tasks", () => {
  it("ensureRepoTask() creates a BRANCH sub-task and is idempotent", async () => {
    const store = freshStore();
    await store.ensure(10, "Cross-repo bug");
    const first = await store.ensureRepoTask(10, "borzoi-backend", { scope: "fix calc", branch: "features/10-x" });
    expect(first.phase).to.equal("BRANCH");
    expect(first.scope).to.equal("fix calc");
    expect(first.branch).to.equal("features/10-x");

    await store.updateRepoTask(10, "borzoi-backend", { phase: "IMPLEMENT" });
    const again = await store.ensureRepoTask(10, "borzoi-backend", { scope: "ignored" });
    expect(again.phase).to.equal("IMPLEMENT");
    expect(again.scope).to.equal("fix calc");
  });

  it("tracks several repos independently for one case", async () => {
    const store = freshStore();
    await store.ensure(11, "Spans backend + frontend");
    await store.ensureRepoTask(11, "borzoi-backend", { scope: "a", branch: "b" });
    await store.ensureRepoTask(11, "borzoi-frontend", { scope: "c", branch: "b" });

    await store.updateRepoTask(11, "borzoi-backend", { phase: "DONE", prUrl: "http://pr/1" });
    await store.updateRepoTask(11, "borzoi-frontend", { phase: "BLOCKED", sessionId: "s2", blockedCommentId: "c2" });

    const tasks = await store.getRepoTasks(11);
    expect(tasks.map((t) => t.repoKey)).to.deep.equal(["borzoi-backend", "borzoi-frontend"]);
    expect((await store.getRepoTask(11, "borzoi-backend"))!.prUrl).to.equal("http://pr/1");
    expect((await store.getRepoTask(11, "borzoi-frontend"))!.phase).to.equal("BLOCKED");
  });

  it("persists the review-incomplete flag as a boolean", async () => {
    const store = freshStore();
    await store.ensure(13, "y");
    await store.ensureRepoTask(13, "borzoi-frontend", {});
    expect((await store.getRepoTask(13, "borzoi-frontend"))!.reviewIncomplete).to.equal(false);
    await store.updateRepoTask(13, "borzoi-frontend", { reviewIncomplete: true });
    expect((await store.getRepoTask(13, "borzoi-frontend"))!.reviewIncomplete).to.equal(true);
  });
});

describe("StateStore — cost accounting", () => {
  it("addCost() accumulates on the case and the named repo and returns the new total", async () => {
    const store = freshStore();
    await store.ensure(21, "z");
    await store.ensureRepoTask(21, "borzoi-backend", {});
    await store.ensureRepoTask(21, "borzoi-frontend", {});

    await store.addCost(21, "borzoi-backend", 1.25);
    const total = await store.addCost(21, "borzoi-backend", 0.75);
    expect(total).to.be.closeTo(2.0, 1e-9);
    await store.addCost(21, "borzoi-frontend", 2.0);

    expect((await store.get(21))!.costUsd).to.be.closeTo(4.0, 1e-9);
    expect((await store.getRepoTask(21, "borzoi-backend"))!.costUsd).to.be.closeTo(2.0, 1e-9);
    expect((await store.getRepoTask(21, "borzoi-frontend"))!.costUsd).to.be.closeTo(2.0, 1e-9);
  });

  it("keeps a lifetime total that survives a budget reset (a /retry)", async () => {
    const store = freshStore();
    await store.ensure(24, "z");
    await store.addCost(24, null, 10);
    expect((await store.get(24))!.costUsd).to.be.closeTo(10, 1e-9);
    expect((await store.get(24))!.lifetimeCostUsd).to.be.closeTo(10, 1e-9);

    await store.update(24, { costUsd: 0 });
    await store.addCost(24, null, 3);
    expect((await store.get(24))!.costUsd).to.be.closeTo(3, 1e-9);
    expect((await store.get(24))!.lifetimeCostUsd).to.be.closeTo(13, 1e-9);
  });

  it("addCost() ignores non-positive deltas", async () => {
    const store = freshStore();
    await store.ensure(23, "z");
    await store.addCost(23, null, 0);
    await store.addCost(23, null, -5);
    expect((await store.get(23))!.costUsd).to.equal(0);
  });
});
