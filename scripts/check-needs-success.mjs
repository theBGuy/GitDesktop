// Aggregator gate for a required status check: the job's `needs` context
// arrives as JSON in the NEEDS_JSON env var (`${{ toJSON(needs) }}`, passed
// through `env:` so no context value is interpolated into a script body), and
// the job passes only when there is at least one need and every one succeeded.
// A skipped or cancelled need fails it too, since a required check that passes
// over skipped work reads as green. Input it cannot read fails closed;
// duplicate keys can't occur, since toJSON(needs) emits one key per need.
// Fixtures live in scripts/checks.test.mjs; Node stdlib only (no install step).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NEEDS_ENV = "NEEDS_JSON";

/** `{ ok, lines }`: ok only for a non-empty object whose every need has
 *  `result === "success"`; lines name each need's result or the reason the
 *  input was unreadable. */
export function needsVerdict(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, lines: [`${NEEDS_ENV} is missing or empty.`] };
  }
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      lines: [`${NEEDS_ENV} is not valid JSON: ${error.message}`],
    };
  }
  if (needs === null || typeof needs !== "object" || Array.isArray(needs)) {
    return { ok: false, lines: [`${NEEDS_ENV} is not a JSON object.`] };
  }
  const names = Object.keys(needs);
  if (names.length === 0) {
    return { ok: false, lines: [`${NEEDS_ENV} lists no needs.`] };
  }
  let ok = true;
  const lines = [];
  for (const name of names) {
    const result = needs[name]?.result;
    if (typeof result !== "string") {
      ok = false;
      lines.push(`${name}: no result recorded`);
      continue;
    }
    if (result !== "success") ok = false;
    lines.push(`${name}=${result}`);
  }
  return { ok, lines };
}

function main() {
  const { ok, lines } = needsVerdict(process.env[NEEDS_ENV]);
  for (const line of lines) console.log(line);
  if (!ok) {
    console.error("::error::Not every required job succeeded.");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
