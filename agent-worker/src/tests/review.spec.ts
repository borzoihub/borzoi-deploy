import { expect } from "chai";
import { isBlocking, formatFindings, type Finding } from "../review.js";

describe("review gating", () => {
  it("treats Critical and Important as blocking, Minor as not", () => {
    expect(isBlocking({ severity: "Critical", file: "a.ts", title: "t", detail: "d" })).to.be.true;
    expect(isBlocking({ severity: "Important", file: "a.ts", title: "t", detail: "d" })).to.be.true;
    expect(isBlocking({ severity: "Minor", file: "a.ts", title: "t", detail: "d" })).to.be.false;
  });

  it("a diff with only Minor findings has no blocking findings (review is clean)", () => {
    const findings: Finding[] = [
      { severity: "Minor", file: "a.ts", title: "nit", detail: "rename" },
      { severity: "Minor", file: "b.ts", title: "nit2", detail: "spacing" },
    ];
    expect(findings.filter(isBlocking)).to.have.length(0);
  });

  it("formatFindings numbers each finding and includes severity, file, and detail", () => {
    const findings: Finding[] = [
      { severity: "Critical", file: "lp.ts", title: "kW/kWh mixup", detail: "multiply by slot hours" },
    ];
    const text = formatFindings(findings);
    expect(text).to.contain("1.");
    expect(text).to.contain("[Critical]");
    expect(text).to.contain("lp.ts");
    expect(text).to.contain("multiply by slot hours");
  });
});
