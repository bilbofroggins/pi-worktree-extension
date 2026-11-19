# 🌳 Pi Worktree (fork)

**Run multiple Pi coding tasks in parallel — each with its own branch, files, and resumable conversation — then squash-merge the result back with one command.**

This is a fork of [AjayPoshak/pi-worktree-extension](https://github.com/AjayPoshak/pi-worktree-extension). It differs from upstream in four ways:

- **Slash commands only.** The `pi -w` shell launcher is gone; everything happens inside Pi.
- **`/worktree-merge`** squash-merges a worktree into the main checkout's branch as one commit, then deletes the worktree and its branch.
- **`/worktree-remove` deletes the branch too**, and asks before discarding uncommitted files or unmerged commits (`--force` skips the question).
- **Creating a worktree no longer requires a clean checkout.** Uncommitted changes in the current checkout stay where they are; you get a warning instead of an error.

## 🚀 Install

**Requirements:** Pi (tested with 0.83.0 and 1.5.2), Node.js 22.19+, a non-bare Git repository with at least one commit.

```bash
git clone https://github.com/bilbofroggins/pi-worktree-extension.git
cd pi-worktree-extension
npm ci
npm test
pi install "$PWD"
```

Pi extensions run with your user permissions — review the source before installing packages you don't trust.

## ⚡ Workflow

```text
/worktree fix-auth        move this conversation into a new worktree on branch worktree-fix-auth
   … work with the agent …
/worktree-merge           squash fix-auth into main, return to the main checkout, delete the worktree
```

Each task gets its own files, branch, and session history:

```text
my-project/
├── primary checkout                 main
└── .pi/worktrees/
    ├── fix-auth/                    worktree-fix-auth
    └── add-api-tests/               worktree-add-api-tests
```

`/worktree-switch fix-auth` from any session in the repository moves that session into the worktree. `/worktree-exit` moves it back. The conversation history travels with it.

## 🎛️ Commands

| Command | Description |
| --- | --- |
| `/worktree <name>` | Move the active conversation into a new or existing worktree |
| `/worktree-switch <name>` | Move the active conversation into an existing worktree (never creates one) |
| `/worktree-list` | List managed worktrees, marking ones with uncommitted changes |
| `/worktree-exit` | Move the active conversation back to the primary checkout |
| `/worktree-merge [name]` | Squash-merge a worktree into the primary checkout's branch, then delete it. The name is optional inside a worktree |
| `/worktree-remove <name> [--force]` | Delete a worktree and its branch. Asks first if work would be lost; `--force` (or `-f`) skips the question |

Names match `[a-z0-9][a-z0-9-]{0,47}` — e.g. `fix-auth`, `issue-123`, `prototype2`.

## 🔀 How `/worktree-merge` works

The merge target is whatever branch the **primary checkout** (the original clone, not a worktree) has checked out — usually `main`.

1. **Checks.** The primary checkout must be on a branch, have no uncommitted changes to tracked files, and have no merge or rebase in progress. Untracked files there are fine. No other Pi session may be using the worktree.
2. **Asks.** If the worktree has uncommitted changes, it asks whether to commit them. It then opens an editor with a suggested commit message (a single commit's own message, or a list of commit subjects). Cancelling either question changes nothing.
3. **Squashes.** It commits any uncommitted worktree changes, runs `git merge --squash worktree-<name>` in the primary checkout, and commits the result as **one** new commit. Commit hooks run as usual. If a hook fails, the primary checkout is restored.
4. **Cleans up.** It deletes the worktree and its branch. If you ran the command from inside that worktree, the session first moves back to the primary checkout.

**Conflicts.** If the squash conflicts, the primary checkout is restored immediately (`git reset --merge`) and nothing is committed. You're offered the option of merging the target branch into the worktree so you can resolve the conflicts there. Resolve them (or ask the agent to), commit, and run `/worktree-merge` again.

**Why tracked changes in the primary checkout block a merge:** Git's own documentation warns that backing out of a merge may not reconstruct uncommitted changes that were there beforehand, so the extension refuses rather than risk them.

**Squash means the branch is never "merged" in Git's eyes.** Its individual commits don't appear in the target's history, so `git branch -d` would refuse to delete it. The merge command deletes it for you. If you push `worktree-*` branches yourself, remote branches are left alone and mentioned in the result.

## 🛡️ Safety

- New worktrees branch from local `origin/HEAD` (never fetched — falls back to `HEAD` with a warning if `origin/HEAD` isn't available). Prefer `HEAD`? Set `{ "base": "head" }` in `~/.pi/agent/worktree.json` or `<repository>/.pi/worktree.json`.
- **Removal asks first** when it would discard uncommitted files (tracked or untracked) or commits that no other local or remote-tracking branch contains. If the worktree changes between the question and the deletion, nothing is deleted. Ignored files (build output, `node_modules`) are deleted without asking, matching `git worktree remove`.
- A worktree that another live Pi session is using can't be removed or merged, even with `--force`. A session can't remove the worktree it's in: use `/worktree-exit` first, or `/worktree-merge`, which handles that for you.
- If a worktree's directory was deleted by hand, `/worktree-remove` still cleans up the branch, Git's worktree entry, and the extension's metadata.
- Quitting Pi never removes a checkout.

Worktrees isolate files, not permissions — every Pi process still runs with your own user access against the same repository.

**Not included:** fetching or pushing, copying ignored/dependency files into new worktrees. A hard crash can leave a lock file behind; it's safe to delete once you've confirmed no Pi process is using that worktree.

## 🧹 Uninstall

```text
/worktree-list   # review before removing anything
```

```bash
pi remove /absolute/path/to/pi-worktree-extension
```

Uninstalling never touches existing worktrees or `worktree-*` branches.

## 🤝 Development

```bash
npm ci
npm run typecheck
npm test
```

## 📄 License

[MIT](LICENSE). Original work by [AjayPoshak](https://github.com/AjayPoshak).
