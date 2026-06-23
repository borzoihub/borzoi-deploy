import { expect } from "chai";
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
});
