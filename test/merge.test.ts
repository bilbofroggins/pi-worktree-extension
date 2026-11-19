import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git.js";
import { createLease, removeLease } from "../src/leases.js";
import {
  autoCommitMessage,
  bringTargetIntoWorktree,
  commitWorktreeChanges,
  defaultSquashMessage,
  planMerge,
  squashMerge,
} from "../src/merge.js";
import { prepareWorktree } from "../src/worktrees.js";

async function makeRepository(): Promise<{ root: string; repo: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-merge-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  await runGit(["init", "-b", "main"], repo);
  await runGit(["config", "user.name", "Test User"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "line one\nline two\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, home };
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await runGit(["add", file], cwd);
  await runGit(["commit", "-m", message], cwd);
}

async function head(cwd: string): Promise<string> {
  return (await runGit(["rev-parse", "HEAD"], cwd)).stdout.trim();
}

async function status(cwd: string): Promise<string> {
  return (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], cwd)).stdout;
}

async function squashMsgExists(cwd: string): Promise<boolean> {
  return lstat(join(cwd, ".git", "SQUASH_MSG")).then(() => true, () => false);
}

test("default squash message keeps a single commit's message and lists several", () => {
  const one = [{ oid: "1", subject: "Add parser", body: "Details here.\n" }];
  assert.equal(defaultSquashMessage("task", one), "Add parser\n\nDetails here.");
  const auto = { oid: "3", subject: autoCommitMessage("task"), body: "" };
  assert.equal(defaultSquashMessage("task", [...one, auto]), "Add parser\n\nDetails here.");
  const two = [...one, { oid: "2", subject: "Fix tests", body: "" }];
  assert.equal(defaultSquashMessage("task", two), "Squash worktree task\n\n- Add parser\n- Fix tests");
  assert.equal(defaultSquashMessage("task", [auto]), "Squash worktree task");
});

test("squash merge makes one commit on the main checkout's branch", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "feature", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "a.txt", "a\n", "Add a");
    await commitFile(wt.record.path, "b.txt", "b\n", "Add b");
    // Untracked files in the main checkout do not block a merge.
    await writeFile(join(fixture.repo, "scratch.txt"), "mine\n");
    const before = await head(fixture.repo);

    const plan = await planMerge(fixture.repo, "feature");
    assert.equal(plan.target, "main");
    assert.equal(plan.commitCount, 2);
    assert.deepEqual(plan.commits.map((commit) => commit.subject), ["Add a", "Add b"]);
    assert.equal(plan.dirtyFiles, 0);

    const result = await squashMerge(plan, "Feature work");
    assert.equal(result.status, "merged");
    const after = await head(fixture.repo);
    assert.equal(result.status === "merged" && result.oid, after);
    assert.equal((await runGit(["rev-parse", "HEAD^"], fixture.repo)).stdout.trim(), before);
    assert.equal((await runGit(["log", "-1", "--format=%B"], fixture.repo)).stdout.trim(), "Feature work");
    assert.equal(await readFile(join(fixture.repo, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(fixture.repo, "b.txt"), "utf8"), "b\n");
    assert.equal(await status(fixture.repo), "?? scratch.txt\n");
    assert.equal(await squashMsgExists(fixture.repo), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("uncommitted worktree changes are committed, including untracked files", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "dirty", { trustProject: false, home: fixture.home });
    await writeFile(join(wt.record.path, "README.md"), "changed\n");
    await writeFile(join(wt.record.path, "new.txt"), "new\n");
    const plan = await planMerge(fixture.repo, "dirty");
    assert.equal(plan.dirtyFiles, 2);
    assert.equal(plan.commitCount, 0);

    await commitWorktreeChanges(plan.record);
    const replanned = await planMerge(fixture.repo, "dirty");
    assert.equal(replanned.dirtyFiles, 0);
    assert.equal(replanned.commitCount, 1);
    assert.equal(replanned.commits[0]?.subject, autoCommitMessage("dirty"));
    assert.equal((await squashMerge(replanned, "Dirty work")).status, "merged");
    assert.equal(await readFile(join(fixture.repo, "new.txt"), "utf8"), "new\n");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a conflict leaves the main checkout untouched and can be resolved in the worktree", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "clash", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "README.md", "line one\nworktree\n", "Worktree edit");
    await commitFile(wt.record.path, "other.txt", "other\n", "Other file");
    await commitFile(fixture.repo, "README.md", "line one\nmain\n", "Main edit");
    await writeFile(join(fixture.repo, "untracked.txt"), "keep\n");
    const before = await head(fixture.repo);

    const plan = await planMerge(fixture.repo, "clash");
    const result = await squashMerge(plan, "Clash");
    assert.deepEqual(result, { status: "conflict", files: ["README.md"] });
    assert.equal(await head(fixture.repo), before);
    assert.equal(await status(fixture.repo), "?? untracked.txt\n");
    assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "line one\nmain\n");
    await assert.rejects(lstat(join(fixture.repo, "other.txt")), /ENOENT/);
    assert.equal(await squashMsgExists(fixture.repo), false);

    assert.deepEqual(await bringTargetIntoWorktree(plan), ["README.md"]);
    // An unfinished merge in the worktree blocks merging until it is committed.
    await assert.rejects(planMerge(fixture.repo, "clash"), /Worktree clash has an unfinished merge/);
    await writeFile(join(wt.record.path, "README.md"), "line one\nmain and worktree\n");
    await runGit(["add", "README.md"], wt.record.path);
    await runGit(["commit", "--no-edit"], wt.record.path);
    assert.equal((await runGit(["log", "-1", "--format=%s"], wt.record.path)).stdout.trim(), "Merge main into worktree-clash");

    const retry = await planMerge(fixture.repo, "clash");
    assert.equal(retry.commitCount, 3);
    assert.deepEqual(retry.commits.map((commit) => commit.subject), ["Worktree edit", "Other file"]);
    assert.equal((await squashMerge(retry, "Clash resolved")).status, "merged");
    assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "line one\nmain and worktree\n");
    assert.equal(await readFile(join(fixture.repo, "other.txt"), "utf8"), "other\n");
    assert.equal((await runGit(["rev-list", "--count", `${before}..HEAD`], fixture.repo)).stdout.trim(), "1");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("changes already on the target produce no commit", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "same", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "same.txt", "same\n", "Same change");
    await commitFile(fixture.repo, "same.txt", "same\n", "Same change on main");
    const before = await head(fixture.repo);
    const plan = await planMerge(fixture.repo, "same");
    assert.equal(plan.commitCount, 1);
    assert.deepEqual(await squashMerge(plan, "Same"), { status: "no-changes" });
    assert.equal(await head(fixture.repo), before);
    assert.equal(await status(fixture.repo), "");
    assert.equal(await squashMsgExists(fixture.repo), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a failing commit hook leaves the target branch and checkout unchanged", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "hooked", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "h.txt", "h\n", "Add h");
    const hook = join(fixture.repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const before = await head(fixture.repo);

    await assert.rejects(squashMerge(await planMerge(fixture.repo, "hooked"), "Hooked"), /squash commit failed.*lint failed/s);
    assert.equal(await head(fixture.repo), before);
    assert.equal(await status(fixture.repo), "");
    assert.equal(await squashMsgExists(fixture.repo), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("an untracked file in the main checkout that the worktree would overwrite blocks the merge", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "overlap", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "notes.txt", "from worktree\n", "Add notes");
    await writeFile(join(fixture.repo, "notes.txt"), "local only\n");
    const before = await head(fixture.repo);
    await assert.rejects(squashMerge(await planMerge(fixture.repo, "overlap"), "Overlap"), /would be overwritten/);
    assert.equal(await readFile(join(fixture.repo, "notes.txt"), "utf8"), "local only\n");
    assert.equal(await head(fixture.repo), before);
    assert.equal(await status(fixture.repo), "?? notes.txt\n");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("merge refuses an unsafe main checkout, another session's worktree, and a moved branch", async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "guarded", { trustProject: false, home: fixture.home });
    await commitFile(wt.record.path, "g.txt", "g\n", "Add g");

    await writeFile(join(fixture.repo, "README.md"), "edited\n");
    await assert.rejects(planMerge(fixture.repo, "guarded"), /uncommitted changes to tracked files/);
    await runGit(["checkout", "--", "README.md"], fixture.repo);

    await runGit(["checkout", "--detach"], fixture.repo);
    await assert.rejects(planMerge(fixture.repo, "guarded"), /detached HEAD/);
    await runGit(["checkout", "main"], fixture.repo);

    await createLease(wt.repo.commonDir, "guarded", process.ppid);
    await assert.rejects(planMerge(fixture.repo, "guarded"), new RegExp(`in use by another Pi session \\(PID ${process.ppid}\\)`));
    await removeLease(wt.repo.commonDir, "guarded", process.ppid);
    // This process's own lease is the session doing the merge.
    await createLease(wt.repo.commonDir, "guarded", process.pid);
    const plan = await planMerge(wt.record.path, "guarded");
    await removeLease(wt.repo.commonDir, "guarded", process.pid);

    await commitFile(wt.record.path, "late.txt", "late\n", "Late commit");
    await assert.rejects(squashMerge(plan, "Guarded"), /changed after it was checked; nothing was merged/);
    await assert.rejects(lstat(join(fixture.repo, "g.txt")), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
