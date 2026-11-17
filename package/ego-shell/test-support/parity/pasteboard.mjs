import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./pasteboard.jxa.js", import.meta.url));
const jxa = (...args) => execFileSync("osascript", ["-l", "JavaScript", SCRIPT, ...args]).toString().trim();

export const changeCount = () => Number(jxa("count", "-"));

/** Every item's types and a hash of each type's bytes, in pasteboard order. */
async function fingerprint(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const items = [];
  for (const entry of manifest) {
    const types = [];
    for (const [type, file] of entry) {
      types.push([type, createHash("sha256").update(await readFile(file)).digest("hex")]);
    }
    items.push(types);
  }
  return items;
}

/**
 * Saves the host pasteboard. `restore()` writes it back and reads it again to
 * prove it is identical; the backup is deleted only once that holds.
 */
export async function backUpPasteboard() {
  const root = await mkdtemp(path.join(tmpdir(), "ego-parity-pb-"));
  const backup = path.join(root, "backup");
  jxa("save", backup);
  const before = await fingerprint(backup);
  let restored;
  return {
    backup,
    async restore() {
      if (restored) return restored;
      jxa("restore", backup);
      const check = path.join(root, "check");
      jxa("save", check);
      const after = await fingerprint(check);
      const identical = JSON.stringify(after) === JSON.stringify(before);
      restored = { identical, items: before.length, types: before.flat().length };
      if (identical) await rm(root, { recursive: true, force: true });
      else restored.backupKeptAt = backup;
      return restored;
    },
  };
}
