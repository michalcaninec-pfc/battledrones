// Battle files on disk: where records go, writing them atomically (the dev
// viewer's follow mode re-reads the file while a battle plays), and the code
// that played them (git commit, a hash of src/sim/**, the release that has that sim).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BattleRecord } from "../../src/arena/record";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** sha256 of every file under src/sim (sorted paths and contents): what decides whether a record replays here. */
export function simHash(root = ROOT): string {
  const h = createHash("sha256");
  const walk = (dir: string): string[] =>
    readdirSync(dir).sort().flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const p of walk(join(root, "src/sim"))) {
    h.update(relative(root, p).replaceAll("\\", "/"));
    h.update("\0");
    h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function gitCommit(root = ROOT): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * The release this code plays as: the newest version tag behind HEAD (v10,
 * v11…), if its src/sim is the same as this one's, so the game published at
 * /battledrones/<tag>/ replays what this code records. null: sim code that no
 * release has yet (or no git, or no tags).
 */
export function gameVersion(root = ROOT, sim = simHash(root)): string | null {
  let tag: string;
  try {
    tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  // the tag's src/sim, hashed the same way
  const dir = mkdtempSync(join(tmpdir(), "battledrones-sim-"));
  try {
    const tar = join(dir, "sim.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", tar, `refs/tags/${tag}`, "src/sim"], { cwd: root, stdio: "ignore" });
    execFileSync("tar", ["-xf", tar, "-C", dir], { stdio: "ignore" });
    return simHash(dir) === sim ? tag : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const slug = (s: string) => s.toLowerCase().replace(/^(ai|openai|anthropic|llm):/, "").replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);

/** battles/2026-10-11-riverlands-42-gpt-6-luna-vs-ai-rush-hard.json (with -2, -3… if taken). */
export function recordPath(dir: string, map: string, seed: number, blue: string, red: string): string {
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const base = `${day}-${map}-${seed}-${slug(blue)}-vs-${slug(red)}`;
  for (let i = 1; ; i++) {
    const p = join(dir, `${base}${i > 1 ? `-${i}` : ""}.json`);
    try {
      statSync(p);
    } catch {
      return p;
    }
  }
}

/** Write via a temporary file and a rename, so a reader never sees half a record. */
export function writeRecord(path: string, r: BattleRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(r));
  renameSync(tmp, path);
}

export function readRecord(path: string): BattleRecord {
  const r = JSON.parse(readFileSync(path, "utf8")) as BattleRecord;
  if (r.v !== 1) throw new Error(`${path}: not a v1 battle record`);
  return r;
}
