import { LABEL_IN_PROGRESS, LABEL_NEEDS_HUMAN, LABEL_WONTFIX } from "./github.js";
import type { Phase } from "./state.js";

/**
 * Map GitHub's true state (open/closed + labels) to the central journal's case
 * phase. GitHub is the real source of truth; the central journal is a resume
 * cache that can drift (a human relabels/reopens directly, or a crash leaves it
 * mid-phase). Used both by the startup reconcile and the one-shot backfill.
 *
 * Two phases are NOT representable on GitHub and are preserved when GitHub still
 * agrees the case is open + in-progress:
 *  - BLOCKED carries the Agent SDK sessionId needed to resume a parked question;
 *    on GitHub it looks identical to ordinary in-progress work.
 *  - NEEDS_HUMAN is an open issue wearing the needs-human label.
 */
export function phaseFromGitHub(
  gh: { state: "open" | "closed"; labels: string[] },
  current: Phase,
): Phase {
  const set = new Set(gh.labels.map((l) => l.toLowerCase()));
  if (gh.state === "closed") {
    // A won't-fix close always carries the wontfix label (closeWontFix).
    if (set.has(LABEL_WONTFIX) || set.has("duplicate")) return "WONTFIX";
    // `closed + needs-human` is a CONTRADICTION — a needs-human hand-off must
    // live on an OPEN issue (see needsHumanCase). It shouldn't occur now that the
    // bot reopens before flagging, but a manual close or a legacy #36-style row
    // can produce it. Preserve the hand-off (NEEDS_HUMAN) rather than silently
    // reading the close as resolved/DONE — the caller (reconcile) reopens + warns.
    if (set.has(LABEL_NEEDS_HUMAN)) return "NEEDS_HUMAN";
    // Anything else closed is a resolved (or human "completed") close.
    return "DONE";
  }
  if (set.has(LABEL_NEEDS_HUMAN)) return "NEEDS_HUMAN";
  if (set.has(LABEL_IN_PROGRESS)) {
    // in-progress can't distinguish active work from a parked Q&A — keep BLOCKED
    // so its sessionId survives the restart.
    return current === "BLOCKED" ? "BLOCKED" : "WORKING";
  }
  return "NEW";
}
