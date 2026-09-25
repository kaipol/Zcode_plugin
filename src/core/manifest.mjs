// Unified manifest + backup state, all under ~/.zcode/zcode-suite/.
// The suite keeps ONE backup chain and ONE manifest for both features:
//   manifest.json          — what we patched, per-feature sentinels, stats.
//   backups/<hash>/app.asar— cold copy of the archive we treat as baseline,
//                            keyed by its hash, pruned to the last 2 versions.
//   pending.json           — deferred auto-repair (update in progress etc).
// The baseline is usually the pristine official archive. When the suite
// adopts an asar previously patched by the standalone plugins, migration
// imports their backup (earliest installedAt wins) so "restore" still
// reaches the true official build.
import fs from "node:fs";
import path from "node:path";
import { stateDir, home } from "./platform.mjs";
import { atomicWriteBuffer, atomicCopyFile, sha256File } from "./verify.mjs";

export const PATCH_VERSION = "2.0.0";

export function manifestPath(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "manifest.json");
}

export function backupsDir(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "backups");
}

export function pendingPath(stateDirOverride) {
  return path.join(stateDirOverride || stateDir(), "pending.json");
}

export function loadManifest(stateDirOverride) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(stateDirOverride), "utf8"));
  } catch {
    return null;
  }
}

export function saveManifest(m, stateDirOverride) {
  const dir = stateDirOverride || stateDir();
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteBuffer(
    manifestPath(stateDirOverride),
    Buffer.from(JSON.stringify(m, null, 2), "utf8"),
  );
}

export function clearManifest(stateDirOverride) {
  try {
    fs.rmSync(manifestPath(stateDirOverride), { force: true });
  } catch {}
}

export function writePending(p, stateDirOverride) {
  const dir = stateDirOverride || stateDir();
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteBuffer(
    pendingPath(stateDirOverride),
    Buffer.from(JSON.stringify({ ...p, at: new Date().toISOString() }, null, 2), "utf8"),
  );
}
export function readPending(stateDirOverride) {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(stateDirOverride), "utf8"));
  } catch {
    return null;
  }
}

export function clearPending(stateDirOverride) {
  try {
    fs.rmSync(pendingPath(stateDirOverride), { force: true });
  } catch {}
}

// One cold backup per baseline archive hash. Never overwritten once present
// (a corrupted entry is rebuilt) — this is what makes "backup exactly once"
// hold across repeated installs, partial installs and migrations.
export function ensureBackup(asarPath, originalHash, stateDirOverride) {
  const dst = backupPathFor(originalHash, stateDirOverride);
  if (fs.existsSync(dst)) {
    if (sha256File(dst) === originalHash) return dst;
    fs.rmSync(path.dirname(dst), { force: true, recursive: true });
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  atomicCopyFile(asarPath, dst, { expectSize: fs.statSync(asarPath).size });
  return dst;
}

export function backupPathFor(originalHash, stateDirOverride) {
  return path.join(backupsDir(stateDirOverride), originalHash, "app.asar");
}

export function pruneBackups(keep = 2, stateDirOverride) {
  const dir = backupsDir(stateDirOverride);
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = path.join(dir, d.name);
      return { dir: p, hash: d.name, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const e of entries.slice(keep)) {
    fs.rmSync(e.dir, { recursive: true, force: true });
    removed.push(e.hash);
  }
  return removed;
}

export function listBackups(stateDirOverride) {
  const dir = backupsDir(stateDirOverride);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ hash: d.name, mtime: fs.statSync(path.join(dir, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// Pre-suite standalone plugins kept their own state dirs. Both are honored
// (and overridable with the same env vars they used) for migration.
export function legacyDirs() {
  return [
    {
      id: "modelhub",
      dir: process.env.ZCODE_MODEL_HUB_STATE_DIR || path.join(home(), ".zcode", "model-hub"),
    },
    {
      id: "zcodeplus",
      dir: process.env.ZCODE_PLUS_ASAR_STATE_DIR || path.join(home(), ".zcode", "zcode-plus"),
    },
  ];
}

// Import a legacy backup into the unified chain (dedup: skipped when the
// suite already holds that hash). Returns the suite-side path.
function importBackupCopy(srcBackup, hash, stateDirOverride) {
  const dst = backupPathFor(hash, stateDirOverride);
  if (fs.existsSync(dst) && sha256File(dst) === hash) return dst;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  atomicCopyFile(srcBackup, dst, { expectSize: fs.statSync(srcBackup).size });
  return dst;
}

// Adopt the tombstone state.json written by the standalone model-hub plugin
// so deletion history survives the migration.
function importLegacyTombstones(stateDirOverride) {
  const dst = path.join(stateDirOverride || stateDir(), "state.json");
  if (fs.existsSync(dst)) return false;
  for (const L of legacyDirs()) {
    if (L.id !== "modelhub") continue;
    const src = path.join(L.dir, "state.json");
    try {
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      return true;
    } catch {}
  }
  return false;
}

// Resolve the archive the suite treats as its patching baseline.
// Priority:
//   1. the suite's own manifest + verified backup (already migrated)
//   2. a standalone plugin's manifest + verified backup for the same asar —
//      earliest installedAt wins (the first patcher saw the official build)
//   3. adopt the live asar as-is (no provenance; it may already contain
//      feature payloads — callers detect that via sentinel scans)
// Returns { asar, originalHash, source } — never null.
export function resolveBaseline(asarPath, stateDirOverride) {
  const m = loadManifest(stateDirOverride);
  if (m && m.originalHash) {
    const own = backupPathFor(m.originalHash, stateDirOverride);
    if (fs.existsSync(own) && sha256File(own) === m.originalHash) {
      return { asar: own, originalHash: m.originalHash, source: "suite" };
    }
  }
  const candidates = [];
  for (const L of legacyDirs()) {
    try {
      const lm = JSON.parse(fs.readFileSync(path.join(L.dir, "manifest.json"), "utf8"));
      if (!lm || !lm.originalHash) continue;
      if (lm.asarPath && path.resolve(lm.asarPath) !== path.resolve(asarPath)) continue;
      const bp = path.join(L.dir, "backups", lm.originalHash, "app.asar");
      if (!fs.existsSync(bp) || sha256File(bp) !== lm.originalHash) continue;
      candidates.push({
        id: L.id,
        installedAt: String(lm.installedAt || ""),
        originalHash: lm.originalHash,
        backup: bp,
      });
    } catch {}
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.installedAt.localeCompare(b.installedAt));
    const win = candidates[0];
    const imported = importBackupCopy(win.backup, win.originalHash, stateDirOverride);
    importLegacyTombstones(stateDirOverride);
    return { asar: imported, originalHash: win.originalHash, source: `legacy:${win.id}` };
  }
  const h = sha256File(asarPath);
  const adopted = importBackupCopy(asarPath, h, stateDirOverride);
  importLegacyTombstones(stateDirOverride);
  return { asar: adopted, originalHash: h, source: "adopted" };
}
