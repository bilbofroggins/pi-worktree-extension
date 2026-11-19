import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLease, listLiveLeases, removeLease } from "../src/leases.js";
import { recordPath, recordsDirectory } from "../src/metadata.js";
import {
  describeLoss,
  listManaged,
  planRemoval,
  prepareWorktree,
  removalSnapshot,
  removeManaged,
  resolveRepository,
  rollbackCreated,
} from "../src/worktrees.js";
import { runGit } from "../src/git.js";

async function makeRepository(): Promise<{ root: string; repo: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-integration-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  await runGit(["init", "-b", "main"], repo);
  await runGit(["config", "user.name", "Test User"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, home };
}

test("create, reuse, list, and remove use real Git worktrees", async () => {
  const fixture = await makeRepository();
  try {
    const fromSubdirectory = join(fixture.repo, "nested", "directory");
    await mkdir(fromSubdirectory, { recursive: true });
    const created = await prepareWorktree(fromSubdirectory, "task-one", { trustProject: false, home: fixture.home });
    assert.equal(created.created, true);
    assert.match(created.warning ?? "", /origin\/HEAD.*using current HEAD/);
    assert.equal(created.record.path, join(fixture.repo, ".pi", "worktrees", "task-one"));
    assert.equal((await runGit(["branch", "--show-current"], created.record.path)).stdout.trim(), "worktree-task-one");

    const reused = await prepareWorktree(fixture.repo, "task-one", { trustProject: false, home: fixture.home });
    assert.equal(reused.created, false);
    assert.deepEqual(reused.record, created.record);

    const listed = await listManaged(await resolveRepository(fixture.repo));
    assert.equal(listed.invalid.length, 0);
    assert.equal(listed.valid.length, 1);
    assert.equal(listed.valid[0]?.clean, true);

    const exclude = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((line) => line === "/.pi/worktrees/").length, 1);
    await prepareWorktree(fixture.repo, "task-one", { trustProject: false, home: fixture.home });
    const excludeAgain = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    assert.equal(excludeAgain.split("\n").filter((line) => line === "/.pi/worktrees/").length, 1);

    const removed = await removeManaged(await resolveRepository(fixture.repo), "task-one", fixture.repo);
    assert.equal(removed.record.branch, "worktree-task-one");
    assert.equal(removed.branchDeleted, true);
    assert.deepEqual(removed.remoteBranches, []);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-task-one"], fixture.repo));
    assert.equal((await runGit(["worktree", "list", "--porcelain", "-z"], fixture.repo)).stdout.includes(created.record.path), false);
    await assert.rejects(readFile(recordPath(created.repo.commonDir, "task-one")), /ENOENT/);
    // The name is immediately reusable because the branch went with the checkout.
    assert.equal((await prepareWorktree(fixture.repo, "task-one", { trustProject: false, home: fixture.home })).created, true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("creation from a dirty source warns and leaves the source alone; reuse permits a dirty target", async () => {
  const fixture = await makeRepository();
  try {
    await writeFile(join(fixture.repo, "dirty.txt"), "dirty\n");
    await writeFile(join(fixture.repo, "README.md"), "edited\n");
    const fromDirty = await prepareWorktree(fixture.repo, "dirty-source", { trustProject: false, home: fixture.home });
    assert.equal(fromDirty.created, true);
    assert.match(fromDirty.warning ?? "", /Uncommitted changes in .* stay there/);
    assert.equal(await readFile(join(fixture.repo, "dirty.txt"), "utf8"), "dirty\n");
    assert.equal(await readFile(join(fixture.repo, "README.md"), "utf8"), "edited\n");
    await assert.rejects(readFile(join(fromDirty.record.path, "dirty.txt")), /ENOENT/);
    assert.equal(await readFile(join(fromDirty.record.path, "README.md"), "utf8"), "fixture\n");
    await rm(join(fixture.repo, "dirty.txt"));
    await runGit(["checkout", "--", "README.md"], fixture.repo);

    const created = await prepareWorktree(fixture.repo, "reusable", { trustProject: false, home: fixture.home });
    await writeFile(join(created.record.path, "change.txt"), "keep me\n");
    const reused = await prepareWorktree(fixture.repo, "reusable", { trustProject: false, home: fixture.home });
    assert.equal(reused.created, false);
    await assert.rejects(removeManaged(await resolveRepository(fixture.repo), "reusable", fixture.repo), /1 uncommitted file change; nothing was removed/);
    assert.equal(await readFile(join(created.record.path, "change.txt"), "utf8"), "keep me\n");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("removal reports lost work and deletes only the exact state that was confirmed", async () => {
  const fixture = await makeRepository();
  const options = { trustProject: false, home: fixture.home };
  try {
    const created = await prepareWorktree(fixture.repo, "work", options);
    const repo = await resolveRepository(fixture.repo);
    await writeFile(join(created.record.path, "a.txt"), "a\n");
    await runGit(["add", "a.txt"], created.record.path);
    await runGit(["commit", "-m", "a"], created.record.path);
    await writeFile(join(created.record.path, "b.txt"), "b\n");

    const plan = await planRemoval(repo, "work", fixture.repo);
    assert.equal(plan.uniqueCommits, 1);
    assert.equal(plan.dirtyFiles, 1);
    assert.equal(describeLoss(plan), "1 uncommitted file change and 1 commit that no other branch contains");
    await assert.rejects(removeManaged(repo, "work", fixture.repo), /nothing was removed/);

    // Anything that changes after the user agreed blocks removal.
    await writeFile(join(created.record.path, "c.txt"), "c\n");
    await assert.rejects(removeManaged(repo, "work", fixture.repo, { confirmed: removalSnapshot(plan) }), /changed after it was checked/);
    assert.equal(await readFile(join(created.record.path, "c.txt"), "utf8"), "c\n");

    const removed = await removeManaged(repo, "work", fixture.repo, { confirmed: removalSnapshot(await planRemoval(repo, "work", fixture.repo)) });
    assert.equal(removed.branchDeleted, true);
    await assert.rejects(lstat(created.record.path), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-work"], fixture.repo));

    // Commits that a remote-tracking branch already holds are not "lost", and remote branches are kept.
    const pushed = await prepareWorktree(fixture.repo, "pushed", options);
    await writeFile(join(pushed.record.path, "p.txt"), "p\n");
    await runGit(["add", "p.txt"], pushed.record.path);
    await runGit(["commit", "-m", "p"], pushed.record.path);
    await runGit(["update-ref", "refs/remotes/origin/worktree-pushed", "refs/heads/worktree-pushed"], fixture.repo);
    assert.equal((await planRemoval(repo, "pushed", fixture.repo)).uniqueCommits, 0);
    const removedPushed = await removeManaged(repo, "pushed", fixture.repo);
    assert.deepEqual(removedPushed.remoteBranches, ["origin/worktree-pushed"]);
    await runGit(["show-ref", "--verify", "refs/remotes/origin/worktree-pushed"], fixture.repo);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("removal refuses the active worktree and cleans up after a deleted checkout directory", async () => {
  const fixture = await makeRepository();
  const options = { trustProject: false, home: fixture.home };
  try {
    const active = await prepareWorktree(fixture.repo, "active", options);
    const nested = join(active.record.path, "sub");
    await mkdir(nested);
    await assert.rejects(removeManaged(await resolveRepository(nested), "active", nested), /Run \/worktree-exit first/);

    // Directory deleted by hand: Git still lists it (as prunable) until removal cleans it up.
    const gone = await prepareWorktree(fixture.repo, "gone", options);
    await rm(gone.record.path, { recursive: true, force: true });
    const repo = await resolveRepository(fixture.repo);
    const plan = await planRemoval(repo, "gone", fixture.repo);
    assert.equal(plan.registered, true);
    assert.equal(plan.checkoutPresent, false);
    assert.equal(describeLoss(plan), undefined);
    assert.equal((await removeManaged(repo, "gone", fixture.repo)).branchDeleted, true);
    assert.equal((await runGit(["worktree", "list", "--porcelain"], fixture.repo)).stdout.includes(gone.record.path), false);
    await assert.rejects(readFile(recordPath(repo.commonDir, "gone")), /ENOENT/);

    // Directory deleted and already pruned from Git: only the branch and metadata remain.
    const pruned = await prepareWorktree(fixture.repo, "pruned", options);
    await rm(pruned.record.path, { recursive: true, force: true });
    await runGit(["worktree", "prune"], fixture.repo);
    const prunedPlan = await planRemoval(await resolveRepository(fixture.repo), "pruned", fixture.repo);
    assert.equal(prunedPlan.registered, false);
    assert.equal((await removeManaged(await resolveRepository(fixture.repo), "pruned", fixture.repo)).branchDeleted, true);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-pruned"], fixture.repo));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("ignored files match Git worktree removal behavior", async () => {
  const fixture = await makeRepository();
  const options = { trustProject: false, home: fixture.home };
  try {
    await writeFile(join(fixture.repo, ".gitignore"), "*.ignored\n");
    await runGit(["add", ".gitignore"], fixture.repo);
    await runGit(["commit", "-m", "ignore fixture"], fixture.repo);
    await writeFile(join(fixture.repo, "source.ignored"), "local source setup\n");

    const removable = await prepareWorktree(fixture.repo, "ignored-target", options);
    await writeFile(join(removable.record.path, "target.ignored"), "generated output\n");
    await removeManaged(await resolveRepository(fixture.repo), "ignored-target", fixture.repo);
    await assert.rejects(readFile(join(removable.record.path, "target.ignored")), /ENOENT/);

    const rollback = await prepareWorktree(fixture.repo, "ignored-rollback", options);
    await writeFile(join(rollback.record.path, "target.ignored"), "generated output\n");
    assert.equal((await rollbackCreated(rollback)).removed, true);
    await assert.rejects(readFile(join(rollback.record.path, "target.ignored")), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("another live Pi process's lease blocks removal; this process's leftover lease does not", async () => {
  const fixture = await makeRepository();
  try {
    const prepared = await prepareWorktree(fixture.repo, "leased", { trustProject: false, home: fixture.home });
    // The test runner's parent process stands in for another live Pi session.
    await createLease(prepared.repo.commonDir, prepared.record.name, process.ppid);
    await assert.rejects(removeManaged(await resolveRepository(fixture.repo), "leased", fixture.repo), new RegExp(`in use by another Pi session: PID ${process.ppid}`));
    await removeLease(prepared.repo.commonDir, prepared.record.name, process.ppid);

    // This process is outside the worktree, so its own lease is stale and is cleaned up.
    await createLease(prepared.repo.commonDir, prepared.record.name, process.pid);
    await removeManaged(await resolveRepository(fixture.repo), "leased", fixture.repo);
    assert.deepEqual(await listLiveLeases(prepared.repo.commonDir, "leased"), []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("managed layout rejects symlinks, tracked paths, case/branch collisions, and metadata mismatch", async (t) => {
  await t.test("symlinked project .pi", async () => {
    const fixture = await makeRepository();
    try {
      const outside = join(fixture.root, "outside");
      await mkdir(outside);
      await symlink(outside, join(fixture.repo, ".pi"));
      await assert.rejects(prepareWorktree(fixture.repo, "unsafe", { trustProject: false, home: fixture.home }), /must not be a symlink/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("tracked managed path", async () => {
    const fixture = await makeRepository();
    try {
      await mkdir(join(fixture.repo, ".pi", "worktrees"), { recursive: true });
      await writeFile(join(fixture.repo, ".pi", "worktrees", "tracked.txt"), "tracked\n");
      await runGit(["add", ".pi/worktrees/tracked.txt"], fixture.repo);
      await runGit(["commit", "-m", "tracked unsafe path"], fixture.repo);
      await assert.rejects(prepareWorktree(fixture.repo, "unsafe", { trustProject: false, home: fixture.home }), /contains tracked paths/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("case and branch collisions", async () => {
    const fixture = await makeRepository();
    try {
      await mkdir(join(fixture.repo, ".pi", "worktrees", "Task"), { recursive: true });
      await assert.rejects(prepareWorktree(fixture.repo, "task", { trustProject: false, home: fixture.home }), /case-insensitive path collision/);
      await rm(join(fixture.repo, ".pi", "worktrees", "Task"), { recursive: true });
      await runGit(["branch", "worktree-collision"], fixture.repo);
      await assert.rejects(prepareWorktree(fixture.repo, "collision", { trustProject: false, home: fixture.home }), /collides.*without a validated managed worktree/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("metadata mismatch", async () => {
    const fixture = await makeRepository();
    try {
      const prepared = await prepareWorktree(fixture.repo, "metadata", { trustProject: false, home: fixture.home });
      await writeFile(recordPath(prepared.repo.commonDir, "metadata"), `${JSON.stringify({ ...prepared.record, primaryRoot: "/wrong" })}\n`);
      await assert.rejects(prepareWorktree(fixture.repo, "metadata", { trustProject: false, home: fixture.home }), /does not match.*managed layout/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("prepare failure preserves checkout and branch when safe removal cannot be proven", async () => {
  const fixture = await makeRepository();
  try {
    const repo = await resolveRepository(fixture.repo);
    await mkdir(recordsDirectory(repo.commonDir), { recursive: true });
    const hook = join(fixture.repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/usr/bin/env bash\ntouch "$PWD/recovery.txt"\nrmdir ${JSON.stringify(recordsDirectory(repo.commonDir))}\nprintf 'blocks metadata directory\\n' > ${JSON.stringify(recordsDirectory(repo.commonDir))}\n`);
    await chmod(hook, 0o755);

    await assert.rejects(
      prepareWorktree(fixture.repo, "cleanup-failure", { trustProject: false, home: fixture.home }),
      /Preserved checkout .*cleanup-failure.*branch worktree-cleanup-failure/,
    );
    const target = join(fixture.repo, ".pi", "worktrees", "cleanup-failure");
    assert.equal((await lstat(target)).isDirectory(), true);
    assert.equal(await readFile(join(target, "recovery.txt"), "utf8"), "");
    assert.equal(await runGit(["show-ref", "--verify", "refs/heads/worktree-cleanup-failure"], fixture.repo).then(() => true), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
