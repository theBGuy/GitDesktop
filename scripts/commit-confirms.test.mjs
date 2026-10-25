// Pins when writing a commit's message into the commit box asks first
// (`replacesTypedMessage` in src/features/history/commit-confirms.ts): only
// when the box holds something that isn't already that message. Titles compare
// fully trimmed; bodies only at the end: a loaded message's body is already
// trimmed, so a box whose body starts with whitespace it lacks asks first.
// Where the Amend and Undo routes ask is pinned in head-watcher.test.mjs.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replacesTypedMessage } from "../src/features/history/commit-confirms.ts";

const MODULE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "src/features/history/commit-confirms.ts",
);

// The shape the backend sends: its commit-details read trims the body.
const MESSAGE = { subject: "Fix the parser", body: "code\n\nMore detail." };
const INDENTED = "    code\n\nMore detail.";
const asks = (title, body, message = MESSAGE) =>
  replacesTypedMessage({ title, body }, message);

test("an empty or whitespace-only box never asks", () => {
  assert.equal(asks("", ""), false, "empty draft");
  assert.equal(asks("   ", " \n\t "), false, "whitespace-only draft");
});

test("a box already holding the message never asks", () => {
  assert.equal(asks("Fix the parser", "code\n\nMore detail."), false);
  assert.equal(
    asks("  Fix the parser  ", "code\n\nMore detail.\n\n  "),
    false,
    "the same message apart from surrounding title space and trailing body space",
  );
});

test("typed text that differs from the message asks", () => {
  assert.equal(asks("wip", ""), true, "title typed, body empty");
  assert.equal(asks("", "notes"), true, "empty title, body typed");
  assert.equal(
    asks("Fix the parser", "Other detail."),
    true,
    "same title, different body",
  );
  assert.equal(
    asks("Fix the parser", INDENTED),
    true,
    "a typed body starting with indentation the message lacks",
  );
});

test("negative control: a fully trimmed body comparison misses the indentation case", async () => {
  const source = readFileSync(MODULE, "utf8");
  for (const snippet of ["draft.body.trimEnd()", "message.body.trimEnd()"])
    assert.equal(
      source.split(snippet).length,
      2,
      `control premise: one ${snippet}`,
    );
  const dir = mkdtempSync(join(tmpdir(), "commit-confirms-control-"));
  try {
    // Pins the copy's module format; otherwise Node takes it from whatever
    // package.json happens to sit above the temp dir.
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    const copy = join(dir, "commit-confirms.ts");
    writeFileSync(
      copy,
      source
        .replace("draft.body.trimEnd()", "draft.body.trim()")
        .replace("message.body.trimEnd()", "message.body.trim()"),
    );
    const reverted = await import(pathToFileURL(copy).href);
    assert.equal(
      reverted.replacesTypedMessage(
        { title: "Fix the parser", body: INDENTED },
        MESSAGE,
      ),
      false,
      "the reverted comparison replaces an indented body without asking",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
