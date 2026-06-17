import { execFileSync } from "node:child_process";

/** Run git in `cwd`, returning trimmed stdout. Throws on failure. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface Version {
  sha: string;
  /** Commit timestamp (unix seconds). */
  ts: number;
  subject: string;
}

/** Commits touching any of `paths` (relative to cwd), newest first. */
export function listVersions(cwd: string, paths: string[]): Version[] {
  try {
    const out = git(cwd, ["log", "-n", "60", "--format=%H%x09%ct%x09%s", "--", ...paths]);
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [sha, ts, ...rest] = line.split("\t");
      return { sha: sha!, ts: Number(ts), subject: rest.join("\t") };
    });
  } catch {
    return [];
  }
}

/** Path from repo root to cwd (e.g. "templates/brain-starter/"), or "". */
export function repoPrefix(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-prefix"]);
  } catch {
    return "";
  }
}

/** File contents at a commit (repo-root-relative path), or null if absent. */
export function fileAtSha(cwd: string, sha: string, repoRelPath: string): string | null {
  try {
    return execFileSync("git", ["show", `${sha}:${repoRelPath}`], { cwd, encoding: "utf8" });
  } catch {
    return null;
  }
}

export function commitPaths(cwd: string, paths: string[], message: string): void {
  git(cwd, ["add", ...paths]);
  git(cwd, ["commit", "-m", message]);
}

/** Restore `paths` (cwd-relative) to their state at `sha` in the working tree. */
export function checkoutPaths(cwd: string, sha: string, paths: string[]): void {
  for (const p of paths) {
    try {
      git(cwd, ["checkout", sha, "--", p]);
    } catch {
      /* path may not exist at that commit — skip */
    }
  }
}
