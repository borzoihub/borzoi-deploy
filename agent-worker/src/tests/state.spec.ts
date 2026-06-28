import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { StateStore } from "../state.js";

/** In-memory SQLite so each test starts clean. */
function freshStore(): StateStore {
  return new StateStore(":memory:");
}

describe("StateStore", () => {
  it("ensure() creates a NEW row and is idempotent", () => {
    const store = freshStore();
    const first = store.ensure(42, "EV charging miscalculation");
    expect(first.phase).to.equal("NEW");
    expect(first.title).to.equal("EV charging miscalculation");

    // Calling again must not reset the phase if it has advanced.
    store.update(42, { phase: "WORKING" });
    const second = store.ensure(42, "EV charging miscalculation");
    expect(second.phase).to.equal("WORKING");
    store.close();
  });

  it("update() patches only provided case fields and leaves others intact", () => {
    const store = freshStore();
    store.ensure(7, "Title");
    store.update(7, { slug: "fix-thing" });
    store.update(7, { phase: "WORKING" });

    const row = store.get(7)!;
    expect(row.phase).to.equal("WORKING");
    expect(row.slug).to.equal("fix-thing");
    expect(row.title).to.equal("Title");
    store.close();
  });

  it("allInPhase() filters cases by phase", () => {
    const store = freshStore();
    store.ensure(1, "a");
    store.ensure(2, "b");
    store.ensure(3, "c");
    store.update(2, { phase: "BLOCKED" });

    const blocked = store.allInPhase("BLOCKED");
    expect(blocked.map((r) => r.issueNumber)).to.deep.equal([2]);

    const newOnes = store.allInPhase("NEW");
    expect(newOnes.map((r) => r.issueNumber)).to.deep.equal([1, 3]);
    store.close();
  });
});

describe("StateStore — per-repo sub-tasks", () => {
  it("ensureRepoTask() creates a BRANCH sub-task and is idempotent", () => {
    const store = freshStore();
    store.ensure(10, "Cross-repo bug");
    const first = store.ensureRepoTask(10, "borzoi-backend", { scope: "fix calc", branch: "features/10-x" });
    expect(first.phase).to.equal("BRANCH");
    expect(first.scope).to.equal("fix calc");
    expect(first.branch).to.equal("features/10-x");

    store.updateRepoTask(10, "borzoi-backend", { phase: "IMPLEMENT" });
    const again = store.ensureRepoTask(10, "borzoi-backend", { scope: "ignored" });
    expect(again.phase).to.equal("IMPLEMENT");
    expect(again.scope).to.equal("fix calc");
    store.close();
  });

  it("tracks several repos independently for one case", () => {
    const store = freshStore();
    store.ensure(11, "Spans backend + frontend");
    store.ensureRepoTask(11, "borzoi-backend", { scope: "a", branch: "b" });
    store.ensureRepoTask(11, "borzoi-frontend", { scope: "c", branch: "b" });

    store.updateRepoTask(11, "borzoi-backend", { phase: "DONE", prUrl: "http://pr/1" });
    store.updateRepoTask(11, "borzoi-frontend", { phase: "BLOCKED", sessionId: "s2", blockedCommentId: "c2" });

    const tasks = store.getRepoTasks(11);
    expect(tasks.map((t) => t.repoKey)).to.deep.equal(["borzoi-backend", "borzoi-frontend"]);
    expect(store.getRepoTask(11, "borzoi-backend")!.prUrl).to.equal("http://pr/1");
    expect(store.getRepoTask(11, "borzoi-frontend")!.phase).to.equal("BLOCKED");
    store.close();
  });

  it("counts per-repo test attempts across updates", () => {
    const store = freshStore();
    store.ensure(12, "x");
    store.ensureRepoTask(12, "borzoi-backend", {});
    expect(store.getRepoTask(12, "borzoi-backend")!.testAttempts).to.equal(0);
    store.updateRepoTask(12, "borzoi-backend", {
      testAttempts: store.getRepoTask(12, "borzoi-backend")!.testAttempts + 1,
    });
    store.updateRepoTask(12, "borzoi-backend", {
      testAttempts: store.getRepoTask(12, "borzoi-backend")!.testAttempts + 1,
    });
    expect(store.getRepoTask(12, "borzoi-backend")!.testAttempts).to.equal(2);
    store.close();
  });

  it("persists the review-incomplete flag as a boolean", () => {
    const store = freshStore();
    store.ensure(13, "y");
    store.ensureRepoTask(13, "borzoi-frontend", {});
    expect(store.getRepoTask(13, "borzoi-frontend")!.reviewIncomplete).to.equal(false);
    store.updateRepoTask(13, "borzoi-frontend", { reviewIncomplete: true });
    expect(store.getRepoTask(13, "borzoi-frontend")!.reviewIncomplete).to.equal(true);
    store.close();
  });
});

describe("StateStore — cost accounting", () => {
  it("starts cases and repos at zero cost", () => {
    const store = freshStore();
    store.ensure(20, "z");
    store.ensureRepoTask(20, "borzoi-backend", {});
    expect(store.get(20)!.costUsd).to.equal(0);
    expect(store.getRepoTask(20, "borzoi-backend")!.costUsd).to.equal(0);
    store.close();
  });

  it("addCost() accumulates on the case and the named repo", () => {
    const store = freshStore();
    store.ensure(21, "z");
    store.ensureRepoTask(21, "borzoi-backend", {});
    store.ensureRepoTask(21, "borzoi-frontend", {});

    store.addCost(21, "borzoi-backend", 1.25);
    store.addCost(21, "borzoi-backend", 0.75);
    store.addCost(21, "borzoi-frontend", 2.0);

    // Case total sums every session across both repos…
    expect(store.get(21)!.costUsd).to.be.closeTo(4.0, 1e-9);
    // …while each repo carries only its own.
    expect(store.getRepoTask(21, "borzoi-backend")!.costUsd).to.be.closeTo(2.0, 1e-9);
    expect(store.getRepoTask(21, "borzoi-frontend")!.costUsd).to.be.closeTo(2.0, 1e-9);
    store.close();
  });

  it("addCost() with no repo charges the case only (e.g. triage)", () => {
    const store = freshStore();
    store.ensure(22, "z");
    store.addCost(22, null, 0.5);
    expect(store.get(22)!.costUsd).to.be.closeTo(0.5, 1e-9);
    store.close();
  });

  it("keeps a lifetime total that survives a budget reset (a /retry)", () => {
    const store = freshStore();
    store.ensure(24, "z");
    store.addCost(24, null, 10);
    expect(store.get(24)!.costUsd).to.be.closeTo(10, 1e-9);
    expect(store.get(24)!.lifetimeCostUsd).to.be.closeTo(10, 1e-9);

    // Re-arm: reset only the current-attempt counter.
    store.update(24, { costUsd: 0 });
    store.addCost(24, null, 3);
    expect(store.get(24)!.costUsd).to.be.closeTo(3, 1e-9); // fresh envelope
    expect(store.get(24)!.lifetimeCostUsd).to.be.closeTo(13, 1e-9); // total preserved
    store.close();
  });

  it("persists the needs-human retry anchor comment id", () => {
    const store = freshStore();
    store.ensure(25, "z");
    expect(store.get(25)!.needsHumanCommentId).to.equal(null);
    store.update(25, { needsHumanCommentId: "IC_123" });
    expect(store.get(25)!.needsHumanCommentId).to.equal("IC_123");
    store.close();
  });

  it("addCost() ignores non-positive deltas", () => {
    const store = freshStore();
    store.ensure(23, "z");
    store.addCost(23, null, 0);
    store.addCost(23, null, -5);
    expect(store.get(23)!.costUsd).to.equal(0);
    store.close();
  });

  it("migrates an older DB that lacks the new columns", () => {
    // Simulate a pre-budget journal on disk: create the tables WITHOUT the new
    // columns + seed a row, close, then open a StateStore on the same file and
    // confirm it backfills the columns rather than throwing.
    const dir = mkdtempSync(join(tmpdir(), "voltini-state-"));
    const dbPath = join(dir, "old.sqlite");
    try {
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE cases (
          issue_number INTEGER PRIMARY KEY, phase TEXT NOT NULL, slug TEXT,
          title TEXT, error TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE case_repos (
          issue_number INTEGER NOT NULL, repo_key TEXT NOT NULL, scope TEXT,
          phase TEXT NOT NULL, branch TEXT, resume_phase TEXT, session_id TEXT,
          blocked_comment_id TEXT, test_attempts INTEGER NOT NULL DEFAULT 0,
          review_iters INTEGER NOT NULL DEFAULT 0, pr_url TEXT, error TEXT,
          updated_at TEXT NOT NULL, PRIMARY KEY (issue_number, repo_key)
        );
        INSERT INTO cases (issue_number, phase, updated_at) VALUES (99, 'WORKING', '2026-01-01 00:00:00');
        INSERT INTO case_repos (issue_number, repo_key, phase, updated_at)
          VALUES (99, 'borzoi-backend', 'IMPLEMENT', '2026-01-01 00:00:00');
      `);
      old.close();

      const store = new StateStore(dbPath);
      // Old rows read back with the new columns defaulted, and accept charges.
      expect(store.get(99)!.costUsd).to.equal(0);
      expect(store.get(99)!.lifetimeCostUsd).to.equal(0);
      expect(store.get(99)!.needsHumanCommentId).to.equal(null);
      expect(store.getRepoTask(99, "borzoi-backend")!.reviewIncomplete).to.equal(false);
      store.addCost(99, "borzoi-backend", 3.5);
      expect(store.get(99)!.costUsd).to.be.closeTo(3.5, 1e-9);
      expect(store.get(99)!.lifetimeCostUsd).to.be.closeTo(3.5, 1e-9);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
