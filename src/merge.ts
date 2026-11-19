import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { GitError, runGit } from "./git.js";
import { listLiveLeases, withWorktreeLock } from "./leases.js";
import type { WorktreeRecord } from "./metadata.js";
import { findManaged, resolveRepository, type RepositoryContext } from "./worktrees.js";

/** Commits run hooks and merges touch many files, so they get more time than plain queries. */
const MERGE_TIMEOUT_MS = 120_000;

export interface MergeCommit {
  oid: string;
  subject: string;
  body: string;
}

export interface MergePlan {
  repo: RepositoryContext;
  record: WorktreeRecord;
  /** Full ref of the branch checked out in the primary checkout, e.g. refs/heads/main. */
  targetRef: string;
  /** Short name of that branch, e.g. main. */
  target: string;
  branchOid: string;
  /** Tracked changes plus non-ignored untracked files in the worktree. */
  dirtyFiles: number;
  /** Commits on the worktree branch that the target lacks, merges included. */
  commitCount: number;
  /** The same commits without merges, oldest first, for the default message. */
  commits: MergeCommit[];
}

export type SquashResult =
  | { status: "merged"; oid: string }
  | { status: "no-changes" }
  | { status: "conflict"; files: string[] };

export function autoCommitMessage(name: string): string {
  return `Uncommitted changes from worktree ${name}`;
}

export function defaultSquashMessage(name: string, commits: readonly MergeCommit[]): string {
  const meaningful = commits.filter((commit) => commit.subject !== autoCommitMessage(name));
  const [only] = meaningful;
  if (only && meaningful.length === 1) return [only.subject, only.body.trim()].filter((part) => part.length > 0).join("\n\n");
  const title = `Squash worktree ${name}`;
  if (meaningful.length === 0) return title;
  return `${title}\n\n${meaningful.map((commit) => `- ${commit.subject}`).join("\n")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function gitPath(cwd: string, name: string): Promise<string> {
  return resolve(cwd, (await runGit(["rev-parse", "--git-path", name], cwd)).stdout.trim());
}

const IN_PROGRESS: ReadonlyArray<[marker: string, description: string]> = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
];

async function assertNoOperationInProgress(cwd: string, label: string): Promise<void> {
  for (const [marker, description] of IN_PROGRESS) {
    if (await exists(await gitPath(cwd, marker))) throw new Error(`${label} has an unfinished ${description}; finish or abort it first`);
  }
  const unmerged = await unmergedFiles(cwd);
  if (unmerged.length > 0) throw new Error(`${label} has unresolved conflicts in ${unmerged.join(", ")}; resolve and commit them first`);
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  return (await runGit(["diff", "--name-only", "--diff-filter=U"], cwd)).stdout.split("\n").filter((line) => line.length > 0);
}

async function currentBranchRef(primaryRoot: string): Promise<string> {
  try {
    return (await runGit(["symbolic-ref", "--quiet", "HEAD"], primaryRoot)).stdout.trim();
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1 && !error.killed) {
      throw new Error(`The main checkout (${primaryRoot}) is on a detached HEAD; check out the branch to merge into first`);
    }
    throw error;
  }
}

/**
 * Git cannot reliably restore uncommitted changes when it backs out of a failed merge
 * (see the warning under `git merge --abort`), so tracked changes in the target block merging.
 * Untracked files are fine: Git refuses to overwrite them and leaves them alone on reset.
 */
async function assertTargetReady(primaryRoot: string): Promise<void> {
  await assertNoOperationInProgress(primaryRoot, `The main checkout (${primaryRoot})`);
  if ((await runGit(["status", "--porcelain=v1", "--untracked-files=no"], primaryRoot)).stdout.length > 0) {
    throw new Error(
      `The main checkout (${primaryRoot}) has uncommitted changes to tracked files. ` +
      "Commit or stash them first: Git cannot reliably restore them if the merge has to be backed out",
    );
  }
}

async function tip(cwd: string, ref: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd)).stdout.trim();
}

/** Check that a managed worktree can be squash-merged into the primary checkout's branch. */
export async function planMerge(cwd: string, name: string): Promise<MergePlan> {
  const repo = await resolveRepository(cwd);
  const record = await findManaged(repo, name);
  const primary = repo.primaryRoot;

  const targetRef = await currentBranchRef(primary);
  const target = targetRef.replace(/^refs\/heads\//, "");
  await assertTargetReady(primary);
  await assertNoOperationInProgress(record.path, `Worktree ${name}`);

  const others = (await listLiveLeases(repo.commonDir, name)).filter((lease) => lease.pid !== process.pid);
  if (others.length > 0) {
    const owners = others.map((lease) => lease.pid === undefined ? `${lease.path} (${lease.detail ?? "ambiguous owner"})` : `PID ${lease.pid}`).join(", ");
    throw new Error(`Worktree ${name} is in use by another Pi session (${owners}). Exit or quit that session first`);
  }

  const status = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], record.path)).stdout;
  const branchRef = `refs/heads/${record.branch}`;
  const range = `${targetRef}..${branchRef}`;
  const commitCount = Number((await runGit(["rev-list", "--count", range], primary)).stdout.trim());
  const log = (await runGit(["log", "--reverse", "--no-merges", "--format=%H%x00%s%x00%b%x1e", range], primary)).stdout;
  const commits = log.split("\x1e").map((entry) => entry.replace(/^\n/, "")).filter((entry) => entry.length > 0).map((entry) => {
    const [oid = "", subject = "", body = ""] = entry.split("\x00");
    return { oid, subject, body };
  });

  return {
    repo,
    record,
    targetRef,
    target,
    branchOid: await tip(primary, branchRef),
    dirtyFiles: status.split("\n").filter((line) => line.length > 0).length,
    commitCount,
    commits,
  };
}

/** Commit everything in the worktree, including untracked files that are not ignored. */
export async function commitWorktreeChanges(record: WorktreeRecord): Promise<void> {
  await runGit(["add", "--all"], record.path, MERGE_TIMEOUT_MS);
  await runGit(["commit", "--message", autoCommitMessage(record.name)], record.path, MERGE_TIMEOUT_MS);
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await runGit(["diff", "--cached", "--quiet"], cwd);
    return false;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1 && !error.killed) return true;
    throw error;
  }
}

/** Put the primary checkout back the way it was before `git merge --squash`. */
async function backOutSquash(primaryRoot: string): Promise<void> {
  await runGit(["reset", "--merge"], primaryRoot, MERGE_TIMEOUT_MS);
  await rm(await gitPath(primaryRoot, "SQUASH_MSG"), { force: true });
}

/**
 * Squash the worktree branch into the primary checkout's branch as one commit.
 * On conflict or a failed commit (for example a hook), the primary checkout is restored.
 */
export async function squashMerge(plan: MergePlan, message: string): Promise<SquashResult> {
  const primary = plan.repo.primaryRoot;
  const branchRef = `refs/heads/${plan.record.branch}`;
  return withWorktreeLock(plan.repo.commonDir, plan.record.name, async () => {
    // Prompts ran without the lock, so confirm nothing moved underneath them.
    if ((await tip(primary, branchRef)) !== plan.branchOid) {
      throw new Error(`Branch ${plan.record.branch} changed after it was checked; nothing was merged. Run /worktree-merge again`);
    }
    if ((await currentBranchRef(primary)) !== plan.targetRef) {
      throw new Error(`The main checkout is no longer on ${plan.target}; nothing was merged. Run /worktree-merge again`);
    }
    await assertTargetReady(primary);

    try {
      await runGit(["merge", "--squash", branchRef], primary, MERGE_TIMEOUT_MS);
    } catch (error) {
      const files = await unmergedFiles(primary);
      await backOutSquash(primary);
      if (files.length > 0) return { status: "conflict", files };
      throw error;
    }

    if (!(await hasStagedChanges(primary))) {
      await backOutSquash(primary);
      return { status: "no-changes" };
    }

    try {
      await runGit(["commit", "--message", message], primary, MERGE_TIMEOUT_MS);
    } catch (error) {
      await backOutSquash(primary);
      throw new Error(`The squash commit failed, so ${plan.target} was left unchanged: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    await rm(await gitPath(primary, "SQUASH_MSG"), { force: true });
    return { status: "merged", oid: await tip(primary, "HEAD") };
  });
}

/**
 * Merge the target branch into the worktree so conflicts can be resolved there, away from
 * the main checkout. Returns the conflicted files; empty means it merged cleanly.
 */
export async function bringTargetIntoWorktree(plan: MergePlan): Promise<string[]> {
  try {
    const message = `Merge ${plan.target} into ${plan.record.branch}`;
    await runGit(["merge", "--no-edit", "--message", message, plan.targetRef], plan.record.path, MERGE_TIMEOUT_MS);
    return [];
  } catch (error) {
    const files = await unmergedFiles(plan.record.path);
    if (files.length > 0) return files;
    throw error;
  }
}
