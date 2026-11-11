// The attachment gate observes the same `system-health` cache entry as
// useSystemHealth() with its own query, so both must spell the query key and
// the Tauri command alike: a drift splits the cache and the gate would run the
// CLI probes a second time, or read a command that no longer exists. Stdlib
// only; fails closed when either spelling cannot be read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HEALTH = "src/lib/system/health.ts";
const GATE = "src/lib/attachments/use-attachment-support.ts";

const KEY_RE = /queryKey:\s*\[\s*"([^"]*)"\s*\]/g;
const COMMAND_RE = /invoke<SystemHealth>\(\s*"([^"]*)"\s*\)/g;

/** The one query key and one command `source` spells; throws when either is
 *  absent or spelled more than once. */
export function healthQuerySpelling(source, label) {
  const keys = [...source.matchAll(KEY_RE)].map((m) => m[1]);
  const commands = [...source.matchAll(COMMAND_RE)].map((m) => m[1]);
  if (keys.length !== 1)
    throw new Error(`${label}: expected one query key, read ${keys.length}`);
  if (commands.length !== 1)
    throw new Error(`${label}: expected one command, read ${commands.length}`);
  return { key: keys[0], command: commands[0] };
}

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the gate spells the system-health key and command as health.ts does", () => {
  const health = healthQuerySpelling(read(HEALTH), HEALTH);
  const gate = healthQuerySpelling(read(GATE), GATE);
  assert.deepEqual(gate, health);
  assert.deepEqual(health, { key: "system-health", command: "system_health" });
});

test("control: a drifted key or command is caught, an unreadable file fails", () => {
  const gate = read(GATE);
  const health = healthQuerySpelling(read(HEALTH), HEALTH);
  const driftedKey = gate.replace('["system-health"]', '["system-health-v2"]');
  assert.notDeepEqual(healthQuerySpelling(driftedKey, "key"), health);
  const driftedCommand = gate.replace('"system_health"', '"system_health_v2"');
  assert.notDeepEqual(healthQuerySpelling(driftedCommand, "command"), health);
  assert.throws(
    () => healthQuerySpelling("", "empty"),
    /expected one query key/,
  );
  assert.throws(
    () => healthQuerySpelling(`${gate}\n${gate}`, "twice"),
    /expected one query key/,
  );
});
