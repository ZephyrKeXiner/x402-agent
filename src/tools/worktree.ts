import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "perf_hooks";
import os from "node:os";

// ─── Types ──────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isCurrent: boolean;
  isMain: boolean;
}

export type WorktreeAction = "create" | "list" | "remove" | "switch";

// ─── Helpers ────────────────────────────────────────────────────────

const CMD_TIMEOUT = 30_000;

/**
 * Run a git subcommand safely using execFileSync (no shell, no injection).
 * All arguments are passed as an array so user-controlled values can never
 * be interpreted as shell metacharacters.
 */
function git(args: string[], options?: { cwd?: string }): string {
  const start = performance.now();
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      timeout: CMD_TIMEOUT,
      cwd: options?.cwd ?? process.cwd(),
    }).trim();
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(
      `[git] ${args.join(" ").slice(0, 60)} executed in ${duration}ms`,
    );
  }
}

/**
 * Run a gh (GitHub CLI) subcommand safely using execFileSync (no shell).
 */
function gh(args: string[], options?: { cwd?: string }): string {
  const start = performance.now();
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: CMD_TIMEOUT,
      cwd: options?.cwd ?? process.cwd(),
    }).trim();
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(
      `[gh] ${args.join(" ").slice(0, 60)} executed in ${duration}ms`,
    );
  }
}

function getCurrentBranch(): string {
  return git(["branch", "--show-current"]);
}

function getRepoRoot(): string {
  return git(["rev-parse", "--show-toplevel"]);
}

function checkGitRepo(): void {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(
      "Not inside a git repository. Worktree operations require a git repo.",
    );
  }
}

/** Derive a worktree path from the repo root and branch name. */
function deriveWorktreePath(branch: string): string {
  const root = getRepoRoot();
  const parentDir = path.dirname(root);
  const repoName = path.basename(root);
  // Sanitize branch name for directory
  const safeBranch = branch.replace(/[^\w./-]/g, "-");
  return path.join(parentDir, `${repoName}-${safeBranch}`);
}

// ─── Core operations ────────────────────────────────────────────────

/**
 * List all git worktrees for the current repository.
 */
export function listWorktrees(): WorktreeInfo[] {
  checkGitRepo();
  const start = performance.now();

  try {
    const output = git(["worktree", "list", "--porcelain"]);
    const realCwd = realpathSync(process.cwd());
    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        current.path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line
          .slice("branch ".length)
          .replace("refs/heads/", "");
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.slice("HEAD ".length).slice(0, 7);
      } else if (line === "") {
        if (current.path) {
          worktrees.push({
            path: current.path!,
            branch: current.branch || "(detached HEAD)",
            commit: current.commit || "unknown",
            isCurrent: current.path === realCwd || current.path === process.cwd(),
            isMain: worktrees.length === 0,
          });
        }
        current = {};
      }
    }

    // Handle last entry without trailing newline
    if (current.path) {
      worktrees.push({
        path: current.path!,
        branch: current.branch || "(detached HEAD)",
        commit: current.commit || "unknown",
        isCurrent: current.path === realCwd || current.path === process.cwd(),
        isMain: worktrees.length === 0,
      });
    }

    return worktrees;
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[listWorktrees] executed in ${duration}ms`);
  }
}

/**
 * Create a new git worktree for a branch.
 *
 * - If the branch already exists: check it out in a new worktree.
 * - If the branch does not exist: create it from `baseBranch` (or current HEAD).
 *
 * After creation the process working directory is **not** changed – call
 * `switchWorktree` separately or pass `switch: true`.
 */
export function createWorktree(
  branch: string,
  baseBranch?: string,
  switchTo: boolean = false,
): { path: string; branch: string; switched: boolean } {
  checkGitRepo();
  const start = performance.now();

  try {
    // Check if branch already exists
    const existingBranches = git(["branch", "--list"])
      .split("\n")
      .map((b) => b.replace(/^\*?\s+/, "").trim());
    const branchExists = existingBranches.includes(branch);

    const worktreePath = deriveWorktreePath(branch);

    // Make sure the worktree path doesn't already exist
    if (existsSync(worktreePath)) {
      throw new Error(
        `Directory "${worktreePath}" already exists. Remove it or choose a different branch name.`,
      );
    }

    if (branchExists) {
      // Branch exists – just create worktree from it
      git(["worktree", "add", worktreePath, branch]);
    } else {
      // Create a new branch from base
      const base = baseBranch || getCurrentBranch();
      git(["worktree", "add", "-b", branch, worktreePath, base]);
    }

    let switched = false;
    if (switchTo) {
      process.chdir(worktreePath);
      switched = true;
    }

    return { path: worktreePath, branch, switched };
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[createWorktree] executed in ${duration}ms`);
  }
}

/**
 * Remove an existing worktree.  Uses `--force` if normal remove fails
 * (e.g. uncommitted changes).
 */
export function removeWorktree(worktreePath: string): string {
  checkGitRepo();
  const start = performance.now();

  try {
    // If we're currently IN the worktree being removed, switch back to main first
    // Use path-separator-aware comparison to avoid false positives
    // (e.g. /home/user/my should NOT match /home/user/myrepo)
    const cwd = process.cwd();
    if (cwd === worktreePath || cwd.startsWith(worktreePath + path.sep)) {
      const worktrees = listWorktrees();
      const mainTree = worktrees.find((w) => w.isMain);
      if (mainTree) {
        process.chdir(mainTree.path);
      }
    }

    try {
      git(["worktree", "remove", worktreePath]);
    } catch {
      git(["worktree", "remove", "--force", worktreePath]);
    }

    // Prune stale worktree metadata
    git(["worktree", "prune"]);

    return `Worktree at "${worktreePath}" removed successfully.`;
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[removeWorktree] executed in ${duration}ms`);
  }
}

/**
 * Switch the process working directory to an existing worktree.
 */
export function switchWorktree(worktreePath: string): string {
  checkGitRepo();
  const start = performance.now();

  try {
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree path does not exist: ${worktreePath}`);
    }

    // Verify it's actually a worktree of this repo
    const worktrees = listWorktrees();
    const target = worktrees.find((w) => w.path === worktreePath);
    if (!target) {
      throw new Error(
        `"${worktreePath}" is not a worktree of this repository.`,
      );
    }

    if (target.isCurrent) {
      return `Already on worktree at "${worktreePath}" (branch: ${target.branch}).`;
    }

    process.chdir(worktreePath);
    return `Switched to worktree at "${worktreePath}" (branch: ${target.branch}).`;
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[switchWorktree] executed in ${duration}ms`);
  }
}

// ─── Pull Request ───────────────────────────────────────────────────

/**
 * Create a GitHub Pull Request.
 *
 * Steps:
 *  1. (optional) `git push -u origin HEAD` if `push` is true.
 *  2. `gh pr create ...` using execFileSync (no shell, no injection).
 *
 * Returns the PR URL on success.
 */
export function createPullRequest(options: {
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  push?: boolean;
}): string {
  checkGitRepo();
  const start = performance.now();

  try {
    const { title, body, base, head, draft, push = true } = options;

    // 1. Push the current branch if requested
    if (push) {
      try {
        const branch = head || getCurrentBranch();
        git(["push", "-u", "origin", branch]);
      } catch (e: any) {
        throw new Error(`Failed to push branch: ${e.message || e}`);
      }
    }

    // 2. Build gh pr create argument array (no shell – injection-safe)
    const ghArgs: string[] = ["pr", "create", "--title", title];
    let tmpFile: string | undefined;

    if (body) {
      // Write body to a temp file to avoid any shell-escaping issues.
      // Temp file is cleaned up after gh finishes reading it.
      tmpFile = path.join(os.tmpdir(), `coda-pr-body-${Date.now()}.md`);
      writeFileSync(tmpFile, body, { encoding: "utf-8" });
      ghArgs.push("--body-file", tmpFile);
    } else {
      ghArgs.push("--body", "");
    }

    if (base) ghArgs.push("--base", base);
    if (head) ghArgs.push("--head", head);
    if (draft) ghArgs.push("--draft");

    try {
      const output = gh(ghArgs);
      return output;
    } catch (e: any) {
      const stderr = e.stderr || "";
      if (stderr.includes("not found") || e.message.includes("ENOENT")) {
        throw new Error(
          "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
        );
      }
      if (
        stderr.includes("not authenticated") ||
        stderr.includes("authentication required")
      ) {
        throw new Error(
          "GitHub CLI is not authenticated. Run `gh auth login` first.",
        );
      }
      throw new Error(`Failed to create PR: ${stderr || e.message}`);
    } finally {
      if (tmpFile) {
        try { unlinkSync(tmpFile); } catch { /* best-effort */ }
      }
    }
  } finally {
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[createPullRequest] executed in ${duration}ms`);
  }
}

// ─── Formatting helpers ─────────────────────────────────────────────

export function formatWorktreeList(worktrees: WorktreeInfo[]): string {
  if (worktrees.length === 0) {
    return "No worktrees found.";
  }

  const lines = worktrees.map((w) => {
    const marker = w.isCurrent ? "→ " : "  ";
    const main = w.isMain ? " [main]" : "";
    const current = w.isCurrent ? " ★ current" : "";
    return [
      `${marker}${w.branch}${main}${current}`,
      `   path: ${w.path}`,
      `   commit: ${w.commit}`,
    ].join("\n");
  });

  return `Git Worktrees (${worktrees.length}):\n${lines.join("\n")}`;
}
