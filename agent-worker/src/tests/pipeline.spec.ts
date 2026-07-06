import { expect } from "chai";
import { slugify, branchName, slugFromBranch, mentionsBot, feedbackForBot } from "../pipeline.js";
import {
  triageSystemPrompt,
  prFeedbackSystemPrompt,
  implementSystemPrompt,
  resumeWithAnswerPrompt,
} from "../prompts.js";
import type { PrComment, IssueDetail } from "../github.js";

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

describe("branchName", () => {
  it("files a verified bug under bugfix/, dropping any installation name", () => {
    expect(branchName(30, "bugfix", "incorrect-case-title-in-support-list")).to.equal(
      "bugfix/30-incorrect-case-title-in-support-list",
    );
  });

  it("maps feature → features/ and improvement → improvements/", () => {
    expect(branchName(7, "feature", "add-export-button")).to.equal("features/7-add-export-button");
    expect(branchName(9, "improvement", "clearer-error-copy")).to.equal(
      "improvements/9-clearer-error-copy",
    );
  });

  it("re-slugifies the triage slug as a safety net", () => {
    expect(branchName(12, "bugfix", "Fel: Ärendetitel!!")).to.equal("bugfix/12-fel-rendetitel");
  });
});

describe("slugFromBranch", () => {
  it("strips the prefix and issue number", () => {
    expect(slugFromBranch("bugfix/30-incorrect-case-title")).to.equal("incorrect-case-title");
    expect(slugFromBranch("features/7-add-export-button")).to.equal("add-export-button");
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

describe("prFeedbackSystemPrompt", () => {
  const issue: IssueDetail = {
    number: 42,
    title: "Wrong label",
    labels: [],
    state: "closed",
    body: "The button says the wrong thing.",
    comments: [],
  };
  const feedback: PrComment[] = [
    { id: "c1", author: "maint", body: "@voltini-bot tweak the copy", kind: "conversation" },
  ];

  it("instructs the session to merge the default branch and resolve conflicts first", () => {
    const prompt = prFeedbackSystemPrompt(issue, undefined, feedback, "main");
    // The base branch is named in the merge commands.
    expect(prompt).to.include("git merge origin/main");
    expect(prompt).to.include("git fetch origin main");
    // Conflicts must be resolved, never left as markers or aborted.
    expect(prompt).to.match(/resolve/i);
    expect(prompt).to.match(/never .*merge --abort/i);
    expect(prompt).to.include("<<<<<<<");
  });

  it("uses whatever base branch it is given", () => {
    const prompt = prFeedbackSystemPrompt(issue, undefined, feedback, "develop");
    expect(prompt).to.include("git merge origin/develop");
    expect(prompt).to.not.include("git merge origin/main");
  });
});

describe("implementSystemPrompt", () => {
  const issue: IssueDetail = {
    number: 7,
    title: "Bad reading",
    labels: [],
    state: "open",
    body: "Values look off.",
    comments: [],
  };

  it("does NOT tell fresh work to merge the base (nothing to continue from)", () => {
    const prompt = implementSystemPrompt(issue, undefined, undefined, "main");
    expect(prompt).to.not.include("git merge origin/main");
  });

  it("tells a resumed session (prior work present) to merge the latest base first", () => {
    const prompt = implementSystemPrompt(
      issue,
      undefined,
      "Commits already on this branch:\nabc123 wip",
      "main",
    );
    expect(prompt).to.include("git fetch origin main");
    expect(prompt).to.include("git merge origin/main");
    expect(prompt).to.match(/never .*merge --abort/i);
    // Uncommitted work must be committed before the merge can proceed.
    expect(prompt).to.match(/[Cc]ommit any uncommitted changes/);
  });

  it("names the given base branch in the merge instruction", () => {
    const prompt = implementSystemPrompt(issue, undefined, "abc123 wip", "develop");
    expect(prompt).to.include("git merge origin/develop");
    expect(prompt).to.not.include("git merge origin/main");
  });
});

describe("resumeWithAnswerPrompt", () => {
  it("merges the latest base before continuing, and carries the human's answer", () => {
    const prompt = resumeWithAnswerPrompt("Use the kWh field, not Wh.", "main");
    expect(prompt).to.include("Use the kWh field, not Wh.");
    expect(prompt).to.include("git merge origin/main");
    expect(prompt).to.match(/never .*merge --abort/i);
  });

  it("names the given base branch", () => {
    const prompt = resumeWithAnswerPrompt("ok", "develop");
    expect(prompt).to.include("git merge origin/develop");
    expect(prompt).to.not.include("git merge origin/main");
  });
});
