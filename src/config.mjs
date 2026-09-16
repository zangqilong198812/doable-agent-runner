// Where the runner keeps its token and settings. Deliberately outside any repo:
// this is a credential, and it should not be somewhere a `git add -A` can reach.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DIR = join(homedir(), ".doable");
export const FILE = join(DIR, "runner.json");
/// Where `install` copies the runner to. The service must point at a path that
/// outlives the installer: run through npx and the code sits in a cache
/// directory that can be cleared at any time, which would leave a launchd job
/// aimed at a file that no longer exists — failing silently, which is the worst
/// way for a background process to fail.
export const RUNTIME = join(DIR, "runner");

export const DEFAULT_BASE = "https://doable.rethinking.art/api/agent";

export function load() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function save(config) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(config, null, 2));
  // The token lives in here.
  chmodSync(FILE, 0o600);
  return FILE;
}
