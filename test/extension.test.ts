import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piWorktreeExtension from "../src/extension.js";
import { runGit } from "../src/git.js";
import { listLiveLeases } from "../src/leases.js";
import { prepareWorktree, resolveRepository } from "../src/worktrees.js";

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (typed: string) => Promise<Array<{ value: string; label: string; description?: string }> | null>;
}

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;

function registerExtension(): { commands: Map<string, RegisteredCommand>; events: Map<string, EventHandler> } {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, EventHandler>();
  const api = {
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    on(name: string, handler: EventHandler) { events.set(name, handler); },
  };
  piWorktreeExtension(api as unknown as ExtensionAPI);
  return { commands, events };
}

async function makeRepository(): Promise<{ root: string; repo: string; home: string; sessions: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-extension-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const sessions = join(root, "sessions");
  await mkdir(repo);
  await mkdir(home);
  await mkdir(sessions);
  await runGit(["init", "-b", "main"], repo);
  await runGit(["config", "user.name", "Test User"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, home, sessions };
}

interface DialogAnswers {
  /**
   * Answer for each confirm dialog by title; unlisted titles answer false. Select dialogs list
   * the safe choice first and the action last, so true picks the last entry and false the first.
   */
  confirm?: (title: string) => boolean;
  /** Result of the editor dialog; defaults to cancelling. */
  editor?: (title: string, prefill: string | undefined) => string | undefined;
}

function makeContext(
  cwd: string,
  manager: SessionManager,
  notifications: Array<{ message: string; level: string }>,
  switchSession: ExtensionCommandContext["switchSession"],
  confirms: string[],
  answers: DialogAnswers = {},
): ExtensionCommandContext {
  const ui = {
    notify(message: string, level: string) { notifications.push({ message, level }); },
    setStatus() {},
    confirm(title: string) { confirms.push(title); return Promise.resolve(answers.confirm?.(title) ?? false); },
    select(title: string, options: string[]) { confirms.push(title); return Promise.resolve(answers.confirm?.(title) ? options.at(-1) : options[0]); },
    editor(title: string, prefill?: string) { return Promise.resolve(answers.editor?.(title, prefill)); },
  };
  return {
    cwd,
    sessionManager: manager,
    ui,
    hasUI: true,
    mode: "tui",
    waitForIdle: async () => {},
    switchSession,
    isProjectTrusted: () => false,
  } as unknown as ExtensionCommandContext;
}

function replacementContext(
  cwd: string,
  manager: SessionManager,
  messages: unknown[],
  notifications: Array<{ message: string; level: string }> = [],
): ExtensionCommandContext & { sendMessage: (message: unknown) => Promise<void> } {
  return {
    cwd,
    sessionManager: manager,
    ui: { setStatus() {}, notify(message: string, level: string) { notifications.push({ message, level }); } },
    sendMessage: async (message: unknown) => { messages.push(message); },
  } as unknown as ExtensionCommandContext & { sendMessage: (message: unknown) => Promise<void> };
}

test("registers commands and switches from the exact non-final active leaf using only replacement context", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const { commands, events } = registerExtension();
    assert.deepEqual([...commands.keys()].sort(), ["worktree", "worktree-exit", "worktree-list", "worktree-merge", "worktree-remove"]);
    assert.ok(events.has("session_start"));
    assert.ok(events.has("session_shutdown"));

    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never); // Assistant persistence flushes the real JSONL fixture.
    const selectedLeaf = source.appendCustomEntry("selected", { value: 1 });
    source.appendCustomEntry("physically-last", { value: 2 });
    source.branch(selectedLeaf); // Active leaf is deliberately not the last JSONL entry.
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const replacementMessages: unknown[] = [];
    let switchedFile = "";
    const replacementNotifications: Array<{ message: string; level: string }> = [];
    const switchSession: ExtensionCommandContext["switchSession"] = async (targetFile, options) => {
      switchedFile = targetFile;
      const target = SessionManager.open(targetFile);
      await options?.withSession?.(replacementContext(target.getCwd(), target, replacementMessages, replacementNotifications) as never);
      return { cancelled: false };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, confirms);
    await writeFile(join(fixture.repo, "README.md"), "uncommitted\n");
    await commands.get("worktree")?.handler("exact-leaf", ctx);
    await runGit(["checkout", "--", "README.md"], fixture.repo);
    // Creation warnings reach the replacement session, which is the one the user sees.
    assert.deepEqual(notifications, []);
    assert.equal(replacementNotifications.length, 1);
    assert.equal(replacementNotifications[0]?.level, "warning");
    assert.match(replacementNotifications[0]?.message ?? "", /origin\/HEAD.*Uncommitted changes in .* stay there/);

    assert.ok(switchedFile, JSON.stringify(notifications));
    const target = SessionManager.open(switchedFile);
    const transition = target.getEntries().at(-1);
    assert.equal(transition?.type, "custom");
    assert.equal(transition?.parentId, selectedLeaf);
    assert.equal(target.getCwd(), join(fixture.repo, ".pi", "worktrees", "exact-leaf"));
    // The clone stays in the custom session directory so `pi --continue` from the worktree resumes it.
    assert.equal(join(switchedFile, ".."), fixture.sessions);
    assert.equal(SessionManager.continueRecent(target.getCwd(), fixture.sessions).getSessionFile(), switchedFile);
    assert.equal(replacementMessages.length, 1);
    assert.match(JSON.stringify(replacementMessages[0]), /Revalidate all filesystem paths/);
    assert.equal(confirms.length, 0);

    // session_start adopts the transition lease. Shutdown keeps it continuously held
    // so replacement cannot expose a lease-free removal window.
    const shutdownCtx = makeContext(target.getCwd(), target, notifications, switchSession, confirms);
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, shutdownCtx);
    const targetRepo = await resolveRepository(target.getCwd());
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);
    await events.get("session_shutdown")?.({ type: "session_shutdown", reason: "resume" }, shutdownCtx);
    assert.equal(confirms.length, 0);
    assert.equal((await stat(target.getCwd())).isDirectory(), true);
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);

    // Native cross-cwd replacement establishes the destination first, then releases
    // the prior managed lease after the new session_start is live.
    const primaryManager = SessionManager.create(fixture.repo, fixture.sessions);
    const primaryCtx = makeContext(fixture.repo, primaryManager, notifications, switchSession, confirms);
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, primaryCtx);
    assert.deepEqual(await listLiveLeases(targetRepo.commonDir, "exact-leaf"), []);

    // Re-enter the managed runtime, then verify extension-managed exit also releases
    // the source lease only after replacement is live.
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, shutdownCtx);
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);
    let exitCwd = "";
    const exitSwitch: ExtensionCommandContext["switchSession"] = async (path, options) => {
      const replacementManager = SessionManager.open(path);
      exitCwd = replacementManager.getCwd();
      const replacement = makeContext(exitCwd, replacementManager, notifications, switchSession, confirms);
      await events.get("session_start")?.({ type: "session_start", reason: "resume" }, replacement);
      await options?.withSession?.(replacementContext(exitCwd, replacementManager, replacementMessages) as never);
      return { cancelled: false };
    };
    const exitCtx = makeContext(target.getCwd(), target, notifications, exitSwitch, confirms);
    await commands.get("worktree-exit")?.handler("", exitCtx);
    assert.equal(exitCwd, fixture.repo);
    assert.deepEqual(await listLiveLeases(targetRepo.commonDir, "exact-leaf"), []);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree enters an existing managed worktree without creating one and rejects mismatched metadata", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const target = await prepareWorktree(fixture.repo, "existing", { trustProject: false, home: fixture.home });
    const { commands } = registerExtension();
    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never);
    const notifications: Array<{ message: string; level: string }> = [];
    const replacementMessages: unknown[] = [];
    let switchedFile = "";
    const switchSession: ExtensionCommandContext["switchSession"] = async (path, options) => {
      switchedFile = path;
      const replacement = SessionManager.open(path);
      await options?.withSession?.(replacementContext(replacement.getCwd(), replacement, replacementMessages) as never);
      return { cancelled: false };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, []);

    const worktreesBefore = (await runGit(["worktree", "list", "--porcelain"], fixture.repo)).stdout;
    await commands.get("worktree")?.handler("existing", ctx);
    assert.equal(SessionManager.open(switchedFile).getCwd(), target.record.path);
    assert.equal(replacementMessages.length, 1);
    assert.deepEqual(notifications, []);
    assert.equal((await runGit(["worktree", "list", "--porcelain"], fixture.repo)).stdout, worktreesBefore);

    // Corrupted metadata: foo.json holds the valid record for "existing". Never enter it as foo.
    const records = join(fixture.repo, ".git", "pi-worktree", "records");
    await writeFile(join(records, "foo.json"), await readFile(join(records, "existing.json"), "utf8"));
    switchedFile = "";
    await commands.get("worktree")?.handler("foo", ctx);
    assert.equal(switchedFile, "");
    const mismatch = (notifications as Array<{ message: string; level: string }>).at(-1);
    assert.equal(mismatch?.level, "error");
    assert.match(mismatch?.message ?? "", /record name "existing" does not match "foo"/);
    assert.deepEqual(await listLiveLeases((await resolveRepository(fixture.repo)).commonDir, "foo"), []);
    await unlink(join(records, "foo.json"));
    assert.equal((await runGit(["worktree", "list", "--porcelain"], fixture.repo)).stdout, worktreesBefore);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree list hides invalid metadata records", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  try {
    const records = join(fixture.repo, ".git", "pi-worktree", "records");
    await mkdir(records, { recursive: true });
    await writeFile(join(records, "stale.json"), `${JSON.stringify({
      version: 1,
      name: "stale",
      primaryRoot: fixture.repo,
      path: join(fixture.repo, ".pi", "worktrees", "stale"),
      branch: "worktree-stale",
      baseOid: (await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim(),
      createdAt: new Date().toISOString(),
    })}\n`);

    await prepareWorktree(fixture.repo, "listed", { trustProject: false, home: fixture.home });

    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = makeContext(
      fixture.repo,
      SessionManager.create(fixture.repo, fixture.sessions),
      notifications,
      async () => ({ cancelled: false }),
      [],
    );
    await commands.get("worktree-list")?.handler("", ctx);

    assert.deepEqual(notifications, [{ message: "worktree: listed, branch: worktree-listed", level: "info" }]);

    await commands.get("worktree-remove")?.handler("listed", ctx);
    assert.deepEqual(notifications.at(-1), { message: "Deleted worktree listed and branch worktree-listed.", level: "info" });

    // A record whose checkout and branch are already gone is cleaned up too.
    await commands.get("worktree-remove")?.handler("stale", ctx);
    assert.deepEqual(notifications.at(-1), { message: "Deleted worktree stale.", level: "info" });
    await assert.rejects(stat(join(records, "stale.json")), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancelled switch reports the exact target session deletion failure and Git rollback separately", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const { commands } = registerExtension();
    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never);
    source.appendCustomEntry("source", {});
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    let targetFile = "";
    const switchSession: ExtensionCommandContext["switchSession"] = async (path) => {
      targetFile = path;
      await unlink(path);
      await mkdir(path);
      await writeFile(join(path, "blocks-removal"), "x");
      return { cancelled: true };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, confirms);
    await commands.get("worktree")?.handler("cancelled", ctx);

    assert.ok(targetFile, JSON.stringify(notifications));
    const notice = notifications.at(-1);
    assert.equal(notice?.level, "warning");
    assert.match(notice?.message ?? "", new RegExp(`Target session cleanup failed for ${targetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(notice?.message ?? "", /Full rollback completed/);
    assert.match(notice?.message ?? "", /checkout, branch, and metadata were rolled back/);
    await assert.rejects(stat(join(fixture.repo, ".pi", "worktrees", "cancelled")), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-cancelled"], fixture.repo));
    assert.equal(await readFile(join(targetFile, "blocks-removal"), "utf8"), "x");

    let cleanTargetFile = "";
    const cleanCancellation: ExtensionCommandContext["switchSession"] = async (path) => {
      cleanTargetFile = path;
      return { cancelled: true };
    };
    const cleanCtx = makeContext(fixture.repo, source, notifications, cleanCancellation, confirms);
    await commands.get("worktree")?.handler("cancelled-clean", cleanCtx);
    assert.match(notifications.at(-1)?.message ?? "", /Full rollback completed/);
    await assert.rejects(stat(cleanTargetFile), /ENOENT/);
    await assert.rejects(stat(join(fixture.repo, ".pi", "worktrees", "cancelled-clean")), /ENOENT/);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree works from a brand-new session before Pi writes its file", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(fixture.home, "agent");
  try {
    const { commands } = registerExtension();
    const switchTo = (switched: string[]): ExtensionCommandContext["switchSession"] => async (path, options) => {
      switched.push(path);
      const replacement = SessionManager.open(path);
      await options?.withSession?.(replacementContext(replacement.getCwd(), replacement, []) as never);
      return { cancelled: false };
    };

    // Custom session directory: only a user message exists, so nothing is on disk yet.
    const custom = SessionManager.create(fixture.repo, fixture.sessions);
    const userEntry = custom.appendMessage({ role: "user", content: "hello", timestamp: 0 } as never);
    await assert.rejects(stat(custom.getSessionFile()!), /ENOENT/);
    const notifications: Array<{ message: string; level: string }> = [];
    const customSwitched: string[] = [];
    await commands.get("worktree")?.handler("fresh", makeContext(fixture.repo, custom, notifications, switchTo(customSwitched), []));
    assert.deepEqual(notifications.filter((n) => n.level === "error"), []);
    const [customFile] = customSwitched;
    assert.ok(customFile);
    assert.equal(join(customFile, ".."), fixture.sessions);
    const customTarget = SessionManager.continueRecent(join(fixture.repo, ".pi", "worktrees", "fresh"), fixture.sessions);
    assert.equal(customTarget.getSessionFile(), customFile);
    assert.equal(customTarget.getEntry(userEntry)?.type, "message");
    assert.equal(customTarget.getEntries().at(-1)?.parentId, userEntry);

    // Default per-cwd session directory: an empty brand-new session.
    const fresh = SessionManager.create(fixture.repo);
    const defaultSwitched: string[] = [];
    await commands.get("worktree")?.handler("fresh-default", makeContext(fixture.repo, fresh, notifications, switchTo(defaultSwitched), []));
    assert.deepEqual(notifications.filter((n) => n.level === "error"), []);
    const defaultCwd = join(fixture.repo, ".pi", "worktrees", "fresh-default");
    assert.equal(SessionManager.continueRecent(defaultCwd).getSessionFile(), defaultSwitched[0]);
    assert.ok(defaultSwitched[0]?.startsWith(join(fixture.home, "agent", "sessions")));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function sessionDirEnv(sessions: string): () => void {
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  };
}

async function commitIn(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content);
  await runGit(["add", file], cwd);
  await runGit(["commit", "-m", message], cwd);
}

const noSwitch: ExtensionCommandContext["switchSession"] = async () => { throw new Error("unexpected session switch"); };

test("worktree-remove asks before discarding work and --force skips asking", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "doomed", { trustProject: false, home: fixture.home });
    await commitIn(wt.record.path, "work.txt", "work\n", "Work");
    await writeFile(join(wt.record.path, "draft.txt"), "draft\n");
    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const manager = SessionManager.create(fixture.repo, fixture.sessions);

    await commands.get("worktree-list")?.handler("", makeContext(fixture.repo, manager, notifications, noSwitch, confirms));
    assert.deepEqual(notifications.at(-1), { message: "worktree: doomed, branch: worktree-doomed (uncommitted changes)", level: "info" });

    await commands.get("worktree-remove")?.handler("doomed", makeContext(fixture.repo, manager, notifications, noSwitch, confirms));
    assert.deepEqual(confirms, ["Delete worktree doomed? It has 1 uncommitted file change and 1 commit that no other branch contains. This cannot be undone."]);
    assert.deepEqual(notifications.at(-1), { message: "Kept worktree doomed.", level: "info" });
    assert.equal(await readFile(join(wt.record.path, "draft.txt"), "utf8"), "draft\n");

    await commands.get("worktree-remove")?.handler("doomed --bogus", makeContext(fixture.repo, manager, notifications, noSwitch, confirms));
    assert.deepEqual(notifications.at(-1), { message: "Unknown option --bogus", level: "error" });

    await commands.get("worktree-remove")?.handler("--force doomed", makeContext(fixture.repo, manager, notifications, noSwitch, confirms));
    assert.equal(confirms.length, 1);
    assert.deepEqual(notifications.at(-1), { message: "Deleted worktree doomed and branch worktree-doomed.", level: "info" });
    await assert.rejects(stat(wt.record.path), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-doomed"], fixture.repo));

    const kept = await prepareWorktree(fixture.repo, "confirmed", { trustProject: false, home: fixture.home });
    await writeFile(join(kept.record.path, "draft.txt"), "draft\n");
    const yes = makeContext(fixture.repo, manager, notifications, noSwitch, confirms, { confirm: () => true });
    await commands.get("worktree-remove")?.handler("confirmed", yes);
    assert.deepEqual(notifications.at(-1), { message: "Deleted worktree confirmed and branch worktree-confirmed.", level: "info" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree-merge from the main checkout commits, squashes, and deletes the worktree", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const restore = sessionDirEnv(fixture.sessions);
  try {
    const wt = await prepareWorktree(fixture.repo, "outside", { trustProject: false, home: fixture.home });
    await commitIn(wt.record.path, "one.txt", "one\n", "Add one");
    await writeFile(join(wt.record.path, "two.txt"), "two\n");
    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];
    const manager = SessionManager.create(fixture.repo, fixture.sessions);
    const before = (await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim();

    // Cancelling the message editor changes nothing, not even the worktree's uncommitted files.
    const branchBefore = (await runGit(["rev-parse", "worktree-outside"], fixture.repo)).stdout.trim();
    const cancel = makeContext(fixture.repo, manager, notifications, noSwitch, [], { confirm: () => true, editor: () => "" });
    await commands.get("worktree-merge")?.handler("outside", cancel);
    assert.deepEqual(notifications.at(-1), { message: "Merge cancelled; nothing was changed.", level: "info" });
    assert.equal((await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim(), before);
    assert.equal((await runGit(["rev-parse", "worktree-outside"], fixture.repo)).stdout.trim(), branchBefore);
    assert.equal((await runGit(["status", "--porcelain"], wt.record.path)).stdout, "?? two.txt\n");

    const ctx = makeContext(fixture.repo, manager, notifications, noSwitch, confirms, {
      confirm: () => true,
      editor: (title, prefill) => { editorCalls.push({ title, prefill }); return "Outside work\n"; },
    });
    await commands.get("worktree-merge")?.handler("outside", ctx);
    assert.deepEqual(confirms, ["Commit changes in outside?"]);
    assert.deepEqual(editorCalls, [{
      title: "Squash worktree-outside into main: commit message",
      // The automatic "Uncommitted changes" commit is left out, so the one real commit's message is offered.
      prefill: "Add one",
    }]);
    const done = notifications.at(-1);
    assert.equal(done?.level, "info", JSON.stringify(notifications));
    assert.match(done?.message ?? "", /^Squash-merged worktree-outside into main as [0-9a-f]{12}\. Deleted worktree outside and branch worktree-outside\.$/);
    assert.equal((await runGit(["log", "-1", "--format=%B"], fixture.repo)).stdout.trim(), "Outside work");
    assert.equal((await runGit(["rev-parse", "HEAD^"], fixture.repo)).stdout.trim(), before);
    assert.equal(await readFile(join(fixture.repo, "two.txt"), "utf8"), "two\n");
    await assert.rejects(stat(wt.record.path), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-outside"], fixture.repo));
  } finally {
    restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree-merge conflicts leave main alone and move the conflict into the worktree", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  try {
    const wt = await prepareWorktree(fixture.repo, "clash", { trustProject: false, home: fixture.home });
    await commitIn(wt.record.path, "README.md", "worktree\n", "Worktree edit");
    await commitIn(fixture.repo, "README.md", "main\n", "Main edit");
    const before = (await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim();
    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const ctx = makeContext(fixture.repo, SessionManager.create(fixture.repo, fixture.sessions), notifications, noSwitch, confirms, {
      confirm: () => true,
      editor: (_title, prefill) => prefill,
    });

    await commands.get("worktree-merge")?.handler("clash", ctx);
    assert.deepEqual(confirms, ["Conflicts merging clash"]);
    assert.deepEqual(notifications.at(-1), {
      message: "Started merging main into worktree clash. Resolve the conflicts in README.md there. Use /worktree clash to work on them, commit the resolution, then run /worktree-merge clash again.",
      level: "warning",
    });
    assert.equal((await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim(), before);
    assert.equal((await runGit(["status", "--porcelain"], fixture.repo)).stdout, "");
    assert.match(await readFile(join(wt.record.path, "README.md"), "utf8"), /<<<<<<<[\s\S]*>>>>>>>/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree-merge from inside the worktree returns to the main checkout before deleting it", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const restore = sessionDirEnv(fixture.sessions);
  try {
    const wt = await prepareWorktree(fixture.repo, "inside", { trustProject: false, home: fixture.home });
    await commitIn(wt.record.path, "inside.txt", "inside\n", "Inside work");
    const { commands, events } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const replacementMessages: unknown[] = [];

    const source = SessionManager.create(wt.record.path, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never);
    const worktreeCtx = makeContext(wt.record.path, source, notifications, noSwitch, confirms);
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, worktreeCtx);
    assert.deepEqual((await listLiveLeases(wt.repo.commonDir, "inside")).map((lease) => lease.pid), [process.pid]);

    let switchedCwd = "";
    const exitSwitch: ExtensionCommandContext["switchSession"] = async (path, options) => {
      const replacementManager = SessionManager.open(path);
      switchedCwd = replacementManager.getCwd();
      // Pi runs the replacement's session_start before withSession.
      await events.get("session_start")?.({ type: "session_start", reason: "resume" }, makeContext(switchedCwd, replacementManager, notifications, noSwitch, confirms));
      await options?.withSession?.(replacementContext(switchedCwd, replacementManager, replacementMessages) as never);
      return { cancelled: false };
    };
    const ctx = makeContext(wt.record.path, source, notifications, exitSwitch, confirms, { editor: (_title, prefill) => prefill });
    await commands.get("worktree-merge")?.handler("", ctx);

    assert.deepEqual(notifications.filter((n) => n.level !== "info"), []);
    assert.equal(switchedCwd, fixture.repo);
    assert.equal((await runGit(["log", "-1", "--format=%s"], fixture.repo)).stdout.trim(), "Inside work");
    await assert.rejects(stat(wt.record.path), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-inside"], fixture.repo));
    assert.equal(replacementMessages.length, 1);
    const message = JSON.stringify(replacementMessages[0]);
    assert.match(message, /Revalidate all filesystem paths/);
    assert.match(message, /Squash-merged worktree-inside into main as [0-9a-f]{12}\. Deleted worktree inside and branch worktree-inside\./);
  } finally {
    restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree names are suggested as command arguments", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  try {
    const alpha = await prepareWorktree(fixture.repo, "alpha", { trustProject: false, home: fixture.home });
    await prepareWorktree(fixture.repo, "beta", { trustProject: false, home: fixture.home });
    await prepareWorktree(fixture.repo, "bravo", { trustProject: false, home: fixture.home });
    // Invalid metadata is never suggested.
    const records = join(fixture.repo, ".git", "pi-worktree", "records");
    await writeFile(join(records, "broken.json"), "{}\n");
    const { commands, events } = registerExtension();
    const complete = async (command: string, typed: string) =>
      (await commands.get(command)?.getArgumentCompletions?.(typed))?.map((item) => item.value) ?? null;
    const start = async (cwd: string) =>
      events.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext(cwd, SessionManager.create(cwd, fixture.sessions), [], noSwitch, []));

    await start(fixture.repo);
    assert.deepEqual(await complete("worktree", ""), ["alpha", "beta", "bravo"]);
    assert.deepEqual(await complete("worktree", "b"), ["beta", "bravo"]);
    assert.deepEqual(await complete("worktree", "br"), ["bravo"]);
    assert.equal(await complete("worktree", "z"), null);
    assert.equal(await complete("worktree", "alpha "), null);
    const [item] = (await commands.get("worktree")?.getArgumentCompletions?.("a")) ?? [];
    assert.match(item?.description ?? "", /^created \d{4}-\d{2}-\d{2}$/);
    // Flags typed before the name are kept, because Pi replaces everything after the command.
    assert.deepEqual(await complete("worktree-remove", "--force a"), ["--force alpha"]);
    assert.equal(await complete("worktree-remove", "--fo"), null);
    assert.deepEqual(await complete("worktree-merge", ""), ["alpha", "beta", "bravo"]);

    // Inside a worktree, switching to or removing it makes no sense, but merging it does.
    await start(join(alpha.record.path));
    assert.deepEqual(await complete("worktree", ""), ["beta", "bravo"]);
    assert.deepEqual(await complete("worktree-remove", ""), ["beta", "bravo"]);
    assert.deepEqual(await complete("worktree-merge", ""), ["alpha", "beta", "bravo"]);

    // Outside any repository there is nothing to suggest.
    await start(fixture.home);
    assert.equal(await complete("worktree", ""), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
