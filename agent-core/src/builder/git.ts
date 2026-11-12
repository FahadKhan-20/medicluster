import type { ProcessRunner } from "./types.js";

export class GitClient {
  constructor(private runner: ProcessRunner) {}

  /** Create a git worktree at worktreeDir with a new branch branched from baseRef (default HEAD). */
  async createWorktree(repoRoot: string, branch: string, worktreeDir: string, baseRef = "HEAD"): Promise<void> {
    const res = await this.runner.run(
      "git",
      ["worktree", "add", "-b", branch, worktreeDir, baseRef],
      { cwd: repoRoot }
    );
    if (res.exitCode !== 0) {
      // If branch already exists, try checking it out into the worktree
      if (res.stderr.includes("already exists")) {
        const fallback = await this.runner.run(
          "git",
          ["worktree", "add", worktreeDir, branch],
          { cwd: repoRoot }
        );
        if (fallback.exitCode === 0) return;
      }
      throw new Error(`git worktree add failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  /** Get commit SHA of HEAD in the given directory. */
  async getHeadCommit(cwd: string): Promise<string> {
    const res = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout.trim();
  }

  /** Get diff stat against base commit. */
  async getDiffStat(cwd: string, baseCommit?: string): Promise<string> {
    const args = baseCommit
      ? ["diff", "--stat", `${baseCommit}..HEAD`]
      : ["diff", "--stat", "HEAD~1..HEAD"];
    const res = await this.runner.run("git", args, { cwd });
    if (res.exitCode === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
    // Also check unstaged/staged diff if HEAD has no diff
    const unstaged = await this.runner.run("git", ["diff", "--stat"], { cwd });
    return unstaged.stdout.trim() || "0 files changed";
  }

  /** Stage all changes and commit if working tree is dirty. Returns true if a commit was created. */
  async ensureCommitted(cwd: string, message: string): Promise<boolean> {
    const status = await this.runner.run("git", ["status", "--porcelain"], { cwd });
    if (!status.stdout.trim()) {
      return false; // working tree clean
    }
    await this.runner.run("git", ["add", "-A"], { cwd });
    const commit = await this.runner.run(
      "git",
      ["commit", "-m", message],
      { cwd }
    );
    return commit.exitCode === 0;
  }

  /** Remove worktree (optional cleanup). */
  async removeWorktree(repoRoot: string, worktreeDir: string): Promise<void> {
    await this.runner.run("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoRoot });
  }
}
