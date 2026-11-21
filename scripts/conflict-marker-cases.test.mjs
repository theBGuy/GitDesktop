// Runs the shared marker table against `hasConflictMarkers`; conflict.rs runs
// the same table against its byte scanner, so the two verdicts stay congruent.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `conflict-parse.ts` must stay free of runtime and aliased imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hasConflictMarkers } from "../src/lib/git/conflict-parse.ts";

const TABLE = new URL(
  "../src-tauri/src/git/conflict-marker-cases.json",
  import.meta.url,
);

// `ignoreBOM: true` keeps a leading U+FEFF, as the backend's from_utf8_lossy
// does; the default decoder strips it and would put line 1's run at offset 0.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function bytesOf(hex) {
  assert.match(hex, /^(?:[0-9a-f]{2})*$/, "hex must be lowercase byte pairs");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

test("the shared marker table matches hasConflictMarkers", () => {
  const cases = JSON.parse(readFileSync(TABLE, "utf8"));
  assert.ok(Array.isArray(cases) && cases.length >= 20, "table must load");
  for (const entry of cases) {
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.markers, "boolean", entry.name);
    const text = decoder.decode(bytesOf(entry.hex));
    assert.equal(hasConflictMarkers(text), entry.markers, entry.name);
  }
});

test("the decoder keeps a leading BOM", () => {
  assert.equal(decoder.decode(bytesOf("efbbbf61")), "\uFEFFa");
});
