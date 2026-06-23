import { expect } from "chai";
import { slugify } from "../pipeline.js";

describe("slugify", () => {
  it("produces a branch-safe slug from a case title", () => {
    expect(slugify("EV charging miscalculation")).to.equal("ev-charging-miscalculation");
  });

  it("collapses punctuation and trims separators", () => {
    expect(slugify("Battery won't discharge!! (peak hours)")).to.equal(
      "battery-won-t-discharge-peak-hours",
    );
  });

  it("caps length at 50 characters", () => {
    const long = "a".repeat(80);
    expect(slugify(long).length).to.equal(50);
  });

  it("falls back to 'fix' when the title has no usable characters", () => {
    expect(slugify("!!! ???")).to.equal("fix");
  });
});
