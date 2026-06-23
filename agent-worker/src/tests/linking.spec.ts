import { expect } from "chai";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageName, dependsOn } from "../linking.js";

/** Write a package.json into a fresh temp dir and return its path. */
function repoDir(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "vbf-link-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

describe("linking — dependency detection", () => {
  const dirs: string[] = [];
  const track = (d: string) => (dirs.push(d), d);
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("reads the published package name from a repo", () => {
    const dir = track(repoDir({ name: "@borzoihub/borzoi-common" }));
    expect(packageName(dir)).to.equal("@borzoihub/borzoi-common");
  });

  it("returns undefined when there is no package.json", () => {
    expect(packageName(join(tmpdir(), "definitely-not-a-repo-xyz"))).to.equal(undefined);
  });

  it("detects a runtime dependency on a sibling package", () => {
    const backend = track(
      repoDir({
        name: "@borzoihub/borzoi-backend",
        dependencies: { "@borzoihub/borzoi-common": "1.0.385" },
      }),
    );
    expect(dependsOn(backend, "@borzoihub/borzoi-common")).to.equal(true);
  });

  it("detects dev/peer dependencies too", () => {
    const dev = track(repoDir({ name: "a", devDependencies: { "x-common": "1" } }));
    const peer = track(repoDir({ name: "b", peerDependencies: { "y-common": "1" } }));
    expect(dependsOn(dev, "x-common")).to.equal(true);
    expect(dependsOn(peer, "y-common")).to.equal(true);
  });

  it("returns false when the package is not a dependency", () => {
    const frontend = track(
      repoDir({ name: "@borzoihub/borzoi-frontend", dependencies: { react: "18" } }),
    );
    expect(dependsOn(frontend, "@borzoihub/borzoi-common")).to.equal(false);
  });
});
