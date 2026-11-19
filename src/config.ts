import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type BaseMode = "fresh" | "head";

export interface WorktreeConfig {
  base: BaseMode;
}

function parseConfig(text: string, source: string): Partial<WorktreeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${source}: expected a JSON object`);
  }
  const value = (parsed as Record<string, unknown>).base;
  if (value !== undefined && value !== "fresh" && value !== "head") {
    throw new Error(`Invalid ${source}: base must be "fresh" or "head"`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "base") throw new Error(`Invalid ${source}: unknown property ${JSON.stringify(key)}`);
  }
  return value === undefined ? {} : { base: value };
}

async function readOptional(path: string): Promise<Partial<WorktreeConfig>> {
  try {
    return parseConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(primaryRoot: string, trustProject: boolean, home = homedir()): Promise<WorktreeConfig> {
  const globalConfig = await readOptional(join(home, ".pi", "agent", "worktree.json"));
  const projectConfig = trustProject ? await readOptional(join(primaryRoot, ".pi", "worktree.json")) : {};
  return { base: projectConfig.base ?? globalConfig.base ?? "fresh" };
}

export const testing = { parseConfig };
