import { expect } from "chai";
import { slugify, mentionsBot, feedbackForBot } from "../pipeline.js";
import { triageSystemPrompt } from "../prompts.js";
import type { PrComment } from "../github.js";

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

describe("mentionsBot", () => {
  const bot = "voltini-bot";

  it("matches a plain @-mention", () => {
    expect(mentionsBot("hey @voltini-bot please fix the wording", bot)).to.equal(true);
  });

  it("is case-insensitive", () => {
    expect(mentionsBot("@Voltini-Bot fix this", bot)).to.equal(true);
  });

  it("ignores a comment without the mention", () => {
    expect(mentionsBot("the wording here is wrong", bot)).to.equal(false);
  });

  it("does not match a longer login that the bot name is a prefix of", () => {
    expect(mentionsBot("ping @voltini-bot-helper instead", bot)).to.equal(false);
  });
});

describe("feedbackForBot", () => {
  const bot = "voltini-bot";
  const make = (id: string, body: string, kind: PrComment["kind"] = "conversation"): PrComment => ({
    id,
    author: "maintainer",
    body,
    kind,
  });

  it("keeps only the comments that @-mention the bot", () => {
    const comments = [
      make("a", "@voltini-bot tweak the label"),
      make("b", "looks good to me"),
      make("c", "@voltini-bot also rename this var", "inline"),
    ];
    const picked = feedbackForBot(comments, bot);
    expect(picked.map((c) => c.id)).to.deep.equal(["a", "c"]);
  });

  it("returns an empty array when nothing mentions the bot", () => {
    expect(feedbackForBot([make("a", "nice work")], bot)).to.deep.equal([]);
  });
});

describe("triageSystemPrompt", () => {
  it("omits the maintainer-override block by default", () => {
    const prompt = triageSystemPrompt(["borzoi-backend"]);
    expect(prompt).to.not.match(/MAINTAINER OVERRIDE/i);
  });

  it("injects the maintainer instruction as an authoritative override", () => {
    const prompt = triageSystemPrompt(
      ["borzoi-backend"],
      "This is a real bug, please dig into the scheduler.",
    );
    expect(prompt).to.match(/MAINTAINER OVERRIDE IS IN EFFECT/);
    // The verbatim instruction is quoted so triage sees exactly what was asked.
    expect(prompt).to.include("> This is a real bug, please dig into the scheduler.");
    // It must push triage toward fixable rather than re-closing won't-fix.
    expect(prompt).to.match(/Treat the case as fixable/);
  });

  it("quotes a multi-line instruction across every line", () => {
    const prompt = triageSystemPrompt(["borzoi-backend"], "line one\nline two");
    expect(prompt).to.include("> line one\n> line two");
  });
});
