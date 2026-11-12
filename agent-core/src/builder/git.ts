import fs from "node:fs";
import path from "node:path";
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

  /**
   * Block git push/merge from the worktree:
   * Enables extensions.worktreeConfig, sets remote.*.pushurl=no_push,
   * remote.pushdefault=no_push, and core.hooksPath to an empty dir.
   */
  async configureWorktreeSecurity(worktreeDir: string): Promise<void> {
    // 1. Enable worktree-specific config
    await this.runner.run(
      "git",
      ["config", "extensions.worktreeConfig", "true"],
      { cwd: worktreeDir }
    );

    // 2. Discover remotes and set pushurl=no_push
    const remotesRes = await this.runner.run("git", ["remote"], { cwd: worktreeDir });
    const remotes = remotesRes.stdout
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    if (remotes.length === 0) {
      remotes.push("origin");
    }

    for (const remote of remotes) {
      await this.runner.run(
        "git",
        ["config", "--worktree", `remote.${remote}.pushurl`, "no_push"],
        { cwd: worktreeDir }
      );
    }
    await this.runner.run(
      "git",
      ["config", "--worktree", "remote.pushdefault", "no_push"],
      { cwd: worktreeDir }
    );
    await this.runner.run(
      "git",
      ["config", "--worktree", "remote.*.pushurl", "no_push"],
      { cwd: worktreeDir }
    );

    // 3. Set core.hooksPath to an empty directory
    const emptyHooksDir = path.join(worktreeDir, ".empty_hooks");
    try {
      fs.mkdirSync(emptyHooksDir, { recursive: true });
    } catch {
      // ignore
    }
    await this.runner.run(
      "git",
      ["config", "--worktree", "core.hooksPath", emptyHooksDir],
      { cwd: worktreeDir }
    );
  }

  /** Get commit SHA of HEAD in the given directory. */
  async getHeadCommit(cwd: string): Promise<string> {
    const res = await this.runner.run("git", ["rev-parse", "HEAD"], { cwd });
    if (res.exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${res.stderr || res.stdout}`);
    }
    return res.stdout.trim();
  }

  /** Get snapshot of all branch refs in the given repo. */
  async getBranchRefs(cwd: string): Promise<Map<string, string>> {
    const res = await this.runner.run(
      "git",
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"],
      { cwd }
    );
    const map = new Map<string, string>();
    if (res.exitCode === 0) {
      const lines = res.stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [ref, sha] = trimmed.split(" ");
        if (ref && sha) {
          map.set(ref, sha);
        }
      }
    }
    return map;
  }

  /** Verify that main repo HEAD and all branch refs other than allowedBranch are unchanged. */
  async verifyMainRepoRefs(
    beforeHead: string,
    beforeRefs: Map<string, string>,
    repoRoot: string,
    allowedBranch: string
  ): Promise<{ ok: boolean; reason?: string; details?: any }> {
    const afterHead = await this.getHeadCommit(repoRoot);
    if (afterHead !== beforeHead) {
      return {
        ok: false,
        reason: "main_repo_head_changed",
        details: { beforeHead, afterHead },
      };
    }

    const afterRefs = await this.getBranchRefs(repoRoot);
    const allowedRefName = allowedBranch.startsWith("refs/heads/")
      ? allowedBranch
      : `refs/heads/${allowedBranch}`;

    // Check all refs that existed before: must still exist and have the same SHA
    for (const [ref, sha] of beforeRefs.entries()) {
      if (ref === allowedRefName) continue;
      const currentSha = afterRefs.get(ref);
      if (!currentSha) {
        return {
          ok: false,
          reason: "main_repo_ref_deleted",
          details: { ref },
        };
      }
      if (currentSha !== sha) {
        return {
          ok: false,
          reason: "main_repo_ref_modified",
          details: { ref, beforeSha: sha, afterSha: currentSha },
        };
      }
    }

    // Check any newly created refs: only allowedBranch is permitted
    for (const [ref, sha] of afterRefs.entries()) {
      if (!beforeRefs.has(ref) && ref !== allowedRefName) {
        return {
          ok: false,
          reason: "unexpected_ref_created",
          details: { ref, sha },
        };
      }
    }

    return { ok: true };
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
