import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * Cross-repo local linking.
 *
 * Voltini repos depend on each other through published `*-common` packages
 * (e.g. borzoi-backend depends on `@borzoihub/borzoi-common`). When one support
 * case fixes BOTH a shared package and a consumer of it, the consumer's tests
 * must run against the sibling's *unpublished* local change — not the version on
 * the registry. So before we implement/test a consumer, we build each provider
 * sibling and install it into the consumer worktree with `--no-save`, which
 * overrides node_modules without touching package.json (the link must never end
 * up in the PR diff).
 *
 * The orchestrator guarantees a provider is fully implemented (its sub-task is
 * DONE) before a consumer that depends on it is linked — see pipeline ordering.
 */

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

/** The npm package name a repo publishes (what consumers depend on). */
export function packageName(dir: string): string | undefined {
  return readPackageJson(dir)?.name;
}

/** Does `consumerDir` declare a dependency on the npm package `pkg`? */
export function dependsOn(consumerDir: string, pkg: string): boolean {
  const p = readPackageJson(consumerDir);
  if (!p) return false;
  return Boolean(
    p.dependencies?.[pkg] ??
      p.devDependencies?.[pkg] ??
      p.peerDependencies?.[pkg] ??
      p.optionalDependencies?.[pkg],
  );
}

function npm(args: string[], cwd: string, config: Config): void {
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: config.ghToken },
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  });
}

/**
 * Build a provider worktree (install deps + run its build, if any) so its
 * compiled output exists, then install it into the consumer worktree as a
 * local override. Returns true on success; logs and returns false on failure
 * so the caller can route the case to needs-human rather than test against a
 * half-linked dependency.
 */
export function buildAndLink(
  consumerWorktree: string,
  consumerRepoKey: string,
  providerWorktree: string,
  providerRepoKey: string,
  config: Config,
): boolean {
  const pkg = packageName(providerWorktree);
  if (!pkg) {
    console.warn(`[link] ${providerRepoKey} has no package.json name — cannot link into ${consumerRepoKey}.`);
    return false;
  }
  if (!dependsOn(consumerWorktree, pkg)) {
    // Not actually a dependency — nothing to link, and that's fine.
    return true;
  }

  console.log(`[link] Building ${providerRepoKey} (${pkg}) and linking it into ${consumerRepoKey}…`);
  try {
    const provPkg = readPackageJson(providerWorktree);
    // Install the provider's own deps if it hasn't been installed yet.
    if (!existsSync(join(providerWorktree, "node_modules"))) {
      npm(["install", "--no-audit", "--no-fund"], providerWorktree, config);
    }
    // Build it if it has a build script, so dist/ exists for consumers.
    if (provPkg?.scripts?.["build"]) {
      npm(["run", "build"], providerWorktree, config);
    }
    // Override the consumer's copy in node_modules without editing its
    // package.json (so the local link never shows up in the PR diff).
    npm(["install", providerWorktree, "--no-save", "--no-audit", "--no-fund"], consumerWorktree, config);
    console.log(`[link] Linked ${pkg} → ${consumerRepoKey}.`);
    return true;
  } catch (e) {
    console.warn(`[link] Failed to build/link ${providerRepoKey} into ${consumerRepoKey}: ${String(e)}`);
    return false;
  }
}
