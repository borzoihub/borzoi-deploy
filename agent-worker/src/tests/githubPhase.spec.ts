import { expect } from "chai";
import { phaseFromGitHub } from "../githubPhase.js";
import type { Phase } from "../state.js";

/**
 * `phaseFromGitHub` maps GitHub truth (open/closed + labels) to a case phase for
 * the startup reconcile. The regression this guards is the #36 bug: a
 * `closed + needs-human` issue must NOT read as resolved/DONE — a needs-human
 * hand-off belongs on an open issue, so the contradiction preserves NEEDS_HUMAN
 * rather than silently resolving a case a human still owes attention to.
 */
describe("phaseFromGitHub", () => {
  const cases: Array<{
    name: string;
    state: "open" | "closed";
    labels: string[];
    current?: Phase;
    expected: Phase;
  }> = [
    { name: "open, no labels → NEW", state: "open", labels: [], expected: "NEW" },
    { name: "open + in-progress → WORKING", state: "open", labels: ["in-progress"], expected: "WORKING" },
    {
      name: "open + in-progress preserves BLOCKED (keeps sessionId)",
      state: "open",
      labels: ["in-progress"],
      current: "BLOCKED",
      expected: "BLOCKED",
    },
    { name: "open + needs-human → NEEDS_HUMAN", state: "open", labels: ["needs-human"], expected: "NEEDS_HUMAN" },
    { name: "closed, no labels → DONE", state: "closed", labels: [], expected: "DONE" },
    { name: "closed + wontfix → WONTFIX", state: "closed", labels: ["wontfix"], expected: "WONTFIX" },
    { name: "closed + duplicate → WONTFIX", state: "closed", labels: ["duplicate"], expected: "WONTFIX" },
    // The #36 regression: closed + needs-human is a contradiction; preserve the
    // hand-off instead of resolving it.
    {
      name: "closed + needs-human → NEEDS_HUMAN (not DONE)",
      state: "closed",
      labels: ["needs-human"],
      expected: "NEEDS_HUMAN",
    },
    {
      name: "closed + needs-human is case-insensitive",
      state: "closed",
      labels: ["Needs-Human"],
      expected: "NEEDS_HUMAN",
    },
    // A won't-fix close that also happens to carry needs-human is still WONTFIX
    // (wontfix wins — it's the deliberate terminal close).
    {
      name: "closed + wontfix + needs-human → WONTFIX",
      state: "closed",
      labels: ["wontfix", "needs-human"],
      expected: "WONTFIX",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(phaseFromGitHub({ state: c.state, labels: c.labels }, c.current ?? "NEW")).to.equal(c.expected);
    });
  }
});
