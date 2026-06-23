import { expect } from "chai";
import { deriveStatus, typeLabel, type SupportStatus } from "../github.js";

/**
 * deriveStatus mirrors the central state machine. The key invariant: `in-progress`
 * is checked FIRST, so an open issue with that label reads as in_progress, and a
 * closed issue must have had it removed for the close reason to win. We cover the
 * full state/reason/label matrix so a new branch can't silently change a mapping.
 */
describe("deriveStatus", () => {
  const cases: Array<{
    name: string;
    state: string;
    reason: string | null;
    labels: string[];
    expected: SupportStatus;
  }> = [
    { name: "open, no label", state: "open", reason: null, labels: [], expected: "received" },
    {
      name: "open + in-progress",
      state: "open",
      reason: null,
      labels: ["in-progress"],
      expected: "in_progress",
    },
    {
      name: "open + in-progress is case-insensitive",
      state: "open",
      reason: null,
      labels: ["In-Progress"],
      expected: "in_progress",
    },
    {
      name: "closed completed → resolved",
      state: "closed",
      reason: "completed",
      labels: [],
      expected: "resolved",
    },
    {
      name: "closed with duplicate label → duplicate",
      state: "closed",
      reason: "not_planned",
      labels: ["duplicate"],
      expected: "duplicate",
    },
    {
      name: "closed with duplicate reason → duplicate",
      state: "closed",
      reason: "duplicate",
      labels: [],
      expected: "duplicate",
    },
    {
      name: "closed not_planned → rejected",
      state: "closed",
      reason: "not_planned",
      labels: ["wontfix"],
      expected: "rejected",
    },
    {
      name: "duplicate wins over completed",
      state: "closed",
      reason: "completed",
      labels: ["duplicate"],
      expected: "duplicate",
    },
  ];

  cases.forEach((c) => {
    it(`${c.name} → ${c.expected}`, () => {
      expect(deriveStatus(c.state, c.reason, c.labels)).to.equal(c.expected);
    });
  });

  it("only consults in-progress for OPEN issues (closed+completed is resolved even if the label lingers)", () => {
    // Mirrors the central state machine: in-progress decides status only while
    // open. Once closed, the close reason wins. We still remove in-progress on
    // close as hygiene, but the derived status does not depend on it.
    expect(deriveStatus("closed", "completed", ["in-progress"])).to.equal("resolved");
    expect(deriveStatus("open", null, ["in-progress"])).to.equal("in_progress");
  });
});

describe("typeLabel", () => {
  it("returns the type: label when present", () => {
    expect(typeLabel(["in-progress", "type:core-bug"])).to.equal("type:core-bug");
  });

  it("returns undefined when no type: label exists", () => {
    expect(typeLabel(["in-progress", "needs-human"])).to.equal(undefined);
  });
});
