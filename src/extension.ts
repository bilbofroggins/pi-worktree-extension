import { rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createLease, removeLease } from "./leases.js";
import {
  bringTargetIntoWorktree,
  commitWorktreeChanges,
  defaultSquashMessage,
  planMerge,
  squashMerge,
  type MergePlan,
} from "./merge.js";
import { reportCmuxCwd, reportTerminalCwd } from "./terminal.js";
import {
  describeLoss,
  findCurrentManaged,
  findManaged,
  formatWorktreeIdentity,
  listManaged,
  planRemoval,
  prepareWorktree,
  removalSnapshot,
  removeManaged,
  resolveRepository,
  rollbackCreated,
  type PreparedWorktree,
  type RemovalResult,
  type RemovalSnapshot,
} from "./worktrees.js";

const STATUS_KEY = "pi-worktree";
const KEEP_LABEL = "Keep it";
const TRANSITION_TYPE = "pi-worktree-transition";
const ACTIVE_LEASE_STATE = Symbol.for("pi-worktree-extension.active-lease");

interface ActiveLeaseState {
  commonDir: string;
  name: string;
}

function getActiveLeaseState(): ActiveLeaseState | undefined {
  return (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE] as ActiveLeaseState | undefined;
}

function setActiveLeaseState(state: ActiveLeaseState | undefined): void {
  if (state) (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE] = state;
  else delete (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE];
}

interface SourceState {
  file: string;
  /** Present when Pi has not written the source JSONL yet (no assistant response). */
  unflushed?: { entries: unknown[] };
  /** Custom session directory, or undefined when the source uses Pi's per-cwd default. */
  sessionDir?: string;
  leaf: string | null;
  cwd: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The active --session-dir/PI_CODING_AGENT_SESSION_DIR, or undefined for Pi's per-cwd default. */
function customSessionDir(ctx: ExtensionCommandContext): string | undefined {
  const dir = ctx.sessionManager.getSessionDir();
  // Pi's default layout keeps each cwd's sessions in <agentDir>/sessions/--<encoded cwd>--/.
  return dirname(resolve(dir)) === resolve(getAgentDir(), "sessions") ? undefined : dir;
}

/** Capture the source exactly once after the runtime is idle. */
async function captureSource(ctx: ExtensionCommandContext): Promise<SourceState> {
  await ctx.waitForIdle();
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("A persisted session is required; save or start a persistent Pi session first");
  const manager = ctx.sessionManager;
  const sessionDir = customSessionDir(ctx);
  const fileStat = await stat(file).catch(() => undefined);
  // Pi defers writing a new session until the first assistant response, so a brand-new
  // session exists only in memory. Clone its in-memory entries instead of the file.
  const unflushed = fileStat === undefined ? { entries: manager.getEntries() } : undefined;
  if (fileStat && !fileStat.isFile()) throw new Error(`The current session file is not a regular file: ${file}`);
  return {
    file,
    ...(unflushed ? { unflushed } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    leaf: manager.getLeafId(),
    cwd: ctx.cwd,
  };
}

/** Write a forked session file for targetCwd, mirroring SessionManager.forkFrom. */
async function forkSession(source: SourceState, targetCwd: string): Promise<SessionManager> {
  if (!source.unflushed) return SessionManager.forkFrom(source.file, targetCwd, source.sessionDir);
  // Let Pi allocate the session id, directory, and file name exactly as it would for targetCwd.
  const allocated = SessionManager.create(targetCwd, source.sessionDir);
  const targetFile = allocated.getSessionFile();
  if (!targetFile) throw new Error("Pi did not allocate a target session file");
  // The source file is never written once the runtime switches, so no parentSession link.
  const header = allocated.getHeader();
  const lines = [header, ...source.unflushed.entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await writeFile(targetFile, lines, { flag: "wx" });
  return SessionManager.open(targetFile, allocated.getSessionDir(), targetCwd);
}

async function removeTargetSession(targetFile: string): Promise<string | undefined> {
  try {
    await rm(targetFile);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return errorMessage(error);
  }
}

type ReplacementContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>>[0];

interface TransitionOptions {
  prepared?: PreparedWorktree;
  sourceLeaseName?: string;
  targetLeaseName?: string;
  /**
   * Runs in the replacement session, after its session_start, before the transition message.
   * Whatever it returns is appended to that message so the model sees what happened.
   */
  afterSwitch?: (replacement: ReplacementContext) => Promise<string | undefined>;
}

async function buildSessionTransition(
  ctx: ExtensionCommandContext,
  source: SourceState,
  targetCwd: string,
  kind: "enter" | "exit",
  options: TransitionOptions = {},
): Promise<() => Promise<void>> {
  const targetManager = await forkSession(source, targetCwd);
  if (source.leaf === null) targetManager.resetLeaf();
  else targetManager.branch(source.leaf);
  targetManager.appendCustomEntry(TRANSITION_TYPE, {
    kind,
    from: source.cwd,
    to: targetCwd,
    sourceLeafId: source.leaf,
    transitionedAt: new Date().toISOString(),
  });
  const targetFile = targetManager.getSessionFile();
  if (!targetFile) throw new Error("Pi did not persist the forked target session");

  // Only immutable strings and prepared repository data cross the runtime replacement.
  const oldCwd = source.cwd;
  const newCwd = targetCwd;
  // Resolved now because afterSwitch may delete the source checkout.
  const commonDir = options.prepared?.repo.commonDir ?? (await resolveRepository(source.cwd)).commonDir;
  return async () => {
    const result = await ctx.switchSession(targetFile, {
      withSession: async (replacement) => {
        replacement.ui.setStatus(STATUS_KEY, kind === "enter" ? `worktree: ${newCwd.split("/").at(-1) ?? newCwd}` : undefined);
        let note: string | undefined;
        if (options.afterSwitch) {
          try { note = await options.afterSwitch(replacement); }
          catch (error) {
            note = errorMessage(error);
            replacement.ui.notify(note, "error");
          }
        }
        await replacement.sendMessage(
          {
            customType: TRANSITION_TYPE,
            content: `Pi worktree transition: cwd changed from ${oldCwd} to ${newCwd}. Revalidate all filesystem paths, repository state, and cwd-dependent assumptions before continuing.${note ? ` ${note}` : ""}`,
            display: true,
            details: { kind, from: oldCwd, to: newCwd },
          },
          { triggerTurn: false },
        );
      },
    });

    if (result.cancelled) {
      const sessionError = await removeTargetSession(targetFile);
      let leaseError: string | undefined;
      if (options.targetLeaseName && options.targetLeaseName !== options.sourceLeaseName) {
        try { await removeLease(commonDir, options.targetLeaseName); }
        catch (error) { leaseError = errorMessage(error); }
      }

      let gitRollbackSucceeded = !options.prepared?.created;
      let gitRecovery = "No newly-created Git checkout required rollback.";
      if (options.prepared?.created) {
        const rolledBack = await rollbackCreated(options.prepared);
        gitRollbackSucceeded = rolledBack.removed;
        gitRecovery = rolledBack.removed
          ? "The newly-created checkout, branch, and metadata were rolled back."
          : rolledBack.checkoutRemoved
            ? `Git rollback was partial: the checkout was removed, but branch or metadata cleanup failed (${rolledBack.reason ?? "unknown reason"}). Inspect branch ${options.prepared.record.branch} and metadata for ${options.prepared.record.name}.`
            : `The checkout was preserved because safe rollback could not be proven (${rolledBack.reason ?? "unknown reason"}). Recover it at ${options.prepared.record.path} on branch ${options.prepared.record.branch}.`;
      }

      const sessionRecovery = sessionError
        ? `Target session cleanup failed for ${targetFile}: ${sessionError}.`
        : `Target session clone ${targetFile} was removed.`;
      const leaseRecovery = leaseError ? ` Transition lease cleanup failed: ${leaseError}.` : "";
      const cleanupSucceeded = !sessionError && !leaseError && gitRollbackSucceeded;
      const fullRollback = cleanupSucceeded && Boolean(options.prepared?.created);
      ctx.ui.notify(
        `Session switch was cancelled. ${fullRollback ? "Full rollback completed. " : ""}${sessionRecovery} ${gitRecovery}${leaseRecovery}`,
        cleanupSucceeded ? "info" : "warning",
      );
      return;
    }

    // The target transition lease is now the runtime lease. Release only a different source lease.
    if (options.sourceLeaseName && options.sourceLeaseName !== options.targetLeaseName) {
      await removeLease(commonDir, options.sourceLeaseName).catch(() => undefined);
    }
    // On success the old ctx/runtime is stale. Intentionally do not use it again.
  };
}

async function runCommand(ctx: ExtensionCommandContext, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
}

function parseNameAndFlags(args: string, knownFlags: readonly string[]): { name: string; flags: Set<string> } {
  const flags = new Set<string>();
  const names: string[] = [];
  for (const part of args.split(/\s+/).filter((item) => item.length > 0)) {
    if (knownFlags.includes(part)) flags.add(part);
    else if (part.startsWith("-")) throw new Error(`Unknown option ${part}`);
    else names.push(part);
  }
  if (names.length > 1) throw new Error(`Expected one worktree name, got: ${names.join(" ")}`);
  return { name: names[0] ?? "", flags };
}

function describeRemoval(result: RemovalResult): string {
  const branch = result.branchDeleted ? ` and branch ${result.record.branch}` : "";
  const remote = result.remoteBranches.length > 0 ? ` Remote branch ${result.remoteBranches.join(", ")} was left in place.` : "";
  return `Deleted worktree ${result.record.name}${branch}.${remote}`;
}

async function reportConflict(ctx: ExtensionCommandContext, plan: MergePlan, files: string[], inside: boolean): Promise<void> {
  const { name, branch } = plan.record;
  const conflict = `${branch} conflicts with ${plan.target} in ${files.join(", ")}. ${plan.target} was left unchanged.`;
  const retry = inside
    ? `Commit the resolution, then run /worktree-merge ${name} again.`
    : `Use /worktree-switch ${name} to work on them, commit the resolution, then run /worktree-merge ${name} again.`;
  if (!ctx.hasUI) {
    ctx.ui.notify(`${conflict} To resolve them, merge ${plan.target} into the worktree and fix the conflicts there. ${retry}`, "warning");
    return;
  }
  const bring = await ctx.ui.confirm(
    `Conflicts merging ${name}`,
    `${conflict} Merge ${plan.target} into the worktree so the conflicts can be resolved there?`,
  );
  if (!bring) {
    ctx.ui.notify(conflict, "warning");
    return;
  }
  const remaining = await bringTargetIntoWorktree(plan);
  if (remaining.length === 0) {
    ctx.ui.notify(`Merged ${plan.target} into worktree ${name} without conflicts. Run /worktree-merge ${name} again.`, "info");
    return;
  }
  ctx.ui.notify(`Started merging ${plan.target} into worktree ${name}. Resolve the conflicts in ${remaining.join(", ")} there. ${retry}`, "warning");
}

export default function piWorktreeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("worktree", {
    description: "Create or enter a managed Git worktree",
    handler: async (args, ctx) => {
      let execute: (() => Promise<void>);
      let prepared: PreparedWorktree | undefined;
      let sourceLeaseName: string | undefined;
      try {
        const name = args.trim();
        if (!name) throw new Error("Usage: /worktree <name>");
        const source = await captureSource(ctx);
        const sourceRepo = await resolveRepository(source.cwd);
        sourceLeaseName = (await findCurrentManaged(sourceRepo))?.name;
        prepared = await prepareWorktree(source.cwd, name, { trustProject: ctx.isProjectTrusted(), leasePid: process.pid });
        const warning = prepared.warning;
        execute = await buildSessionTransition(ctx, source, prepared.record.path, "enter", {
          prepared,
          ...(sourceLeaseName ? { sourceLeaseName } : {}),
          targetLeaseName: prepared.record.name,
          // Notifications sent before the switch are not shown once the session is replaced.
          ...(warning ? {
            afterSwitch: async (replacement: ReplacementContext) => {
              replacement.ui.notify(warning, "warning");
              return undefined;
            },
          } : {}),
        });
      } catch (error) {
        if (prepared) {
          if (prepared.record.name !== sourceLeaseName) await removeLease(prepared.repo.commonDir, prepared.record.name).catch(() => undefined);
          if (prepared.created) await rollbackCreated(prepared);
        }
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await execute();
    },
  });

  pi.registerCommand("worktree-switch", {
    description: "Switch to an existing managed Git worktree",
    handler: async (args, ctx) => {
      let execute: (() => Promise<void>);
      let commonDir: string | undefined;
      let sourceLeaseName: string | undefined;
      let targetLeaseName: string | undefined;
      let targetLeaseCreated = false;
      try {
        const name = args.trim();
        if (!name) throw new Error("Usage: /worktree-switch <name>");
        const source = await captureSource(ctx);
        const repo = await resolveRepository(source.cwd);
        commonDir = repo.commonDir;
        sourceLeaseName = (await findCurrentManaged(repo))?.name;
        const target = await findManaged(repo, name);
        targetLeaseName = target.name;
        await createLease(repo.commonDir, target.name);
        targetLeaseCreated = true;
        execute = await buildSessionTransition(ctx, source, target.path, "enter", {
          ...(sourceLeaseName ? { sourceLeaseName } : {}),
          targetLeaseName: target.name,
        });
      } catch (error) {
        if (targetLeaseCreated && commonDir && targetLeaseName && targetLeaseName !== sourceLeaseName) {
          await removeLease(commonDir, targetLeaseName).catch(() => undefined);
        }
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await execute();
    },
  });

  pi.registerCommand("worktree-list", {
    description: "List extension-managed Git worktrees",
    handler: async (_args, ctx) => runCommand(ctx, async () => {
      const listed = await listManaged(await resolveRepository(ctx.cwd));
      const lines = listed.valid.map(({ record, clean }) => `${formatWorktreeIdentity(record)}${clean ? "" : " (uncommitted changes)"}`);
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No extension-managed worktrees.", "info");
    }),
  });

  pi.registerCommand("worktree-exit", {
    description: "Clone this session back to the primary checkout",
    handler: async (_args, ctx) => {
      let execute: (() => Promise<void>);
      try {
        const source = await captureSource(ctx);
        const repo = await resolveRepository(source.cwd);
        const current = await findCurrentManaged(repo);
        if (!current) throw new Error("The current checkout is not an extension-managed worktree");
        execute = await buildSessionTransition(ctx, source, current.primaryRoot, "exit", { sourceLeaseName: current.name });
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await execute();
    },
  });

  pi.registerCommand("worktree-remove", {
    description: "Delete a managed worktree and its branch (asks first if work would be lost; --force skips asking)",
    handler: async (args, ctx) => runCommand(ctx, async () => {
      const { name, flags } = parseNameAndFlags(args, ["--force", "-f"]);
      if (!name) throw new Error("Usage: /worktree-remove <name> [--force]");
      const repo = await resolveRepository(ctx.cwd);
      const plan = await planRemoval(repo, name, ctx.cwd);
      const loss = describeLoss(plan);
      let confirmed: RemovalSnapshot | undefined;
      if (loss) {
        if (flags.size === 0) {
          if (!ctx.hasUI) throw new Error(`Worktree ${name} has ${loss}. Run /worktree-remove ${name} --force to delete it anyway.`);
          // Pi's confirm dialog preselects Yes, so use a list whose first, preselected entry keeps the work.
          const deleteLabel = `Delete worktree and branch ${plan.record.branch}`;
          const choice = await ctx.ui.select(`Delete worktree ${name}? It has ${loss}. This cannot be undone.`, [KEEP_LABEL, deleteLabel]);
          if (choice !== deleteLabel) {
            ctx.ui.notify(`Kept worktree ${name}.`, "info");
            return;
          }
        }
        confirmed = removalSnapshot(plan);
      }
      const removed = await removeManaged(repo, name, ctx.cwd, confirmed ? { confirmed } : {});
      ctx.ui.notify(describeRemoval(removed), "info");
    }),
  });

  pi.registerCommand("worktree-merge", {
    description: "Squash-merge a managed worktree into the main checkout's branch, then delete the worktree and its branch",
    handler: async (args, ctx) => {
      let execute: (() => Promise<void>) | undefined;
      let summary: string | undefined;
      try {
        await ctx.waitForIdle();
        const { name: requested } = parseNameAndFlags(args, []);
        const repo = await resolveRepository(ctx.cwd);
        const current = await findCurrentManaged(repo);
        const name = requested || current?.name;
        if (!name) throw new Error("Usage: /worktree-merge <name>, or run /worktree-merge inside a managed worktree");
        const inside = current?.name === name;

        let plan = await planMerge(ctx.cwd, name);
        const commitFirst = plan.dirtyFiles > 0;
        // Every question is asked before anything is written, so cancelling changes nothing.
        if (commitFirst && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            `Commit changes in ${name}?`,
            plan.dirtyFiles === 1
              ? `Worktree ${name} has 1 uncommitted file change. Commit it in the worktree so it is part of the merge?`
              : `Worktree ${name} has ${plan.dirtyFiles} uncommitted file changes. Commit them in the worktree so they are part of the merge?`,
          );
          if (!ok) {
            ctx.ui.notify("Merge cancelled; nothing was changed.", "info");
            return;
          }
        }
        let message = defaultSquashMessage(name, plan.commits);
        if ((plan.commitCount > 0 || commitFirst) && ctx.hasUI) {
          const edited = await ctx.ui.editor(`Squash ${plan.record.branch} into ${plan.target}: commit message`, message);
          if (!edited?.trim()) {
            ctx.ui.notify("Merge cancelled; nothing was changed.", "info");
            return;
          }
          message = edited.trim();
        }
        if (commitFirst) {
          await commitWorktreeChanges(plan.record);
          plan = await planMerge(ctx.cwd, name);
        }

        if (plan.commitCount === 0) {
          summary = `${plan.record.branch} had no commits that ${plan.target} lacks.`;
        } else {
          const result = await squashMerge(plan, message);
          if (result.status === "conflict") {
            await reportConflict(ctx, plan, result.files, inside);
            return;
          }
          summary = result.status === "merged"
            ? `Squash-merged ${plan.record.branch} into ${plan.target} as ${result.oid.slice(0, 12)}.`
            : `${plan.target} already had every change from ${plan.record.branch}.`;
        }

        // Everything on the branch is now in the target, so deleting loses nothing as long as
        // the branch and worktree are exactly as merged.
        const merged: RemovalSnapshot = { branchOid: plan.branchOid, status: "" };
        const doneSummary = summary;
        if (!inside) {
          const removed = await removeManaged(repo, name, ctx.cwd, { confirmed: merged });
          ctx.ui.notify(`${doneSummary} ${describeRemoval(removed)}`, "info");
          return;
        }
        // A session cannot delete the checkout it is running in, so move to the primary
        // checkout first and delete from the replacement session.
        const source = await captureSource(ctx);
        execute = await buildSessionTransition(ctx, source, plan.repo.primaryRoot, "exit", {
          sourceLeaseName: name,
          afterSwitch: async (replacement) => {
            const removed = await removeManaged(await resolveRepository(replacement.cwd), name, replacement.cwd, { confirmed: merged });
            replacement.ui.notify(describeRemoval(removed), "info");
            return `${doneSummary} ${describeRemoval(removed)}`;
          },
        });
        // Reported before switching so the result is visible even if the switch is cancelled.
        ctx.ui.notify(`${doneSummary} Returning to ${plan.repo.primaryRoot} to delete the worktree.`, "info");
      } catch (error) {
        // Once the merge has landed, say so: the error is only about cleaning up afterwards.
        const cleanup = summary ? `${summary} The worktree was kept: ` : "";
        ctx.ui.notify(`${cleanup}${errorMessage(error)}`, "error");
        return;
      }
      await execute();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const repo = await resolveRepository(ctx.cwd);
      const current = await findCurrentManaged(repo);
      const previous = getActiveLeaseState();
      const next = current ? { commonDir: repo.commonDir, name: current.name } : undefined;

      // Establish the destination lease first, then release a different source lease.
      // This closes the shutdown→replacement-start gap for native /resume, /new,
      // /fork, and /reload flows as well as extension-managed transitions.
      if (next) await createLease(next.commonDir, next.name);
      setActiveLeaseState(next);
      if (previous && (!next || previous.commonDir !== next.commonDir || previous.name !== next.name)) {
        await removeLease(previous.commonDir, previous.name);
      }

      ctx.ui.setStatus(STATUS_KEY, current ? `worktree: ${current.name}` : undefined);
      // Pi keeps its process alive when sessions change cwd. Tell the terminal and cmux
      // about every replacement session so new tabs open in the session's directory.
      if (ctx.mode === "tui") {
        reportTerminalCwd(ctx.cwd);
        void reportCmuxCwd(ctx.cwd);
      }
    } catch (error) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(`Worktree lease/status setup failed: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Keep the lease continuously held across reload/resume replacement. Removing it
    // here would open a race before the replacement session_start recreates it.
    // Extension-managed enter/exit transitions release a different source lease only
    // after the replacement runtime is live. On process exit, dead-PID pruning safely
    // removes the stale lease during the next locked lease/removal decision.
    try { ctx.ui.setStatus(STATUS_KEY, undefined); }
    catch { /* The TUI may already be stopped in Pi 0.83. */ }
  });
}
