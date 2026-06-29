import { expect } from "chai";
import { parsePrNumber } from "../pr.js";

describe("parsePrNumber", () => {
  it("extracts the number from a standard PR url", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/42")).to.equal(42);
  });

  it("ignores trailing path segments and anchors", () => {
    expect(parsePrNumber("https://github.com/owner/repo/pull/7/files#r123")).to.equal(7);
  });

  it("throws on a url with no /pull/<n> segment", () => {
    expect(() => parsePrNumber("https://github.com/owner/repo/issues/9")).to.throw();
  });
});
