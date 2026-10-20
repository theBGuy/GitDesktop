// Pins when the settings Save resets the form to what it just wrote: only when
// the form still holds exactly those values, so an edit (a field, a new MCP
// server and its staged secret) that landed during the write stays on screen
// for the next Save; and always after a Discard during the write, which put
// back pre-save values that would otherwise read as unsaved.
//
// Imported through the shared src hooks; `save-reset.ts` is runtime-import-free,
// so this suite also runs in the no-install `guards` job.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { resetsAfterSave, stableStringify } = await import(
  "@/features/settings/save-reset"
);

const written = {
  theme: "dark",
  mcpServers: [{ id: "srv-a", name: "github", secretKeys: ["API_KEY"] }],
  notifications: { push: true, mail: false },
};

test("resetsAfterSave resets a form still holding the written values", () => {
  assert.equal(
    resetsAfterSave({ discarded: false, current: written, written }),
    true,
  );
  // A structural copy with its keys reordered is the same draft.
  const reordered = {
    notifications: { mail: false, push: true },
    mcpServers: [{ secretKeys: ["API_KEY"], name: "github", id: "srv-a" }],
    theme: "dark",
  };
  assert.equal(
    resetsAfterSave({ discarded: false, current: reordered, written }),
    true,
  );
});

test("resetsAfterSave skips the reset when the form changed during the write", () => {
  const editedField = { ...written, theme: "light" };
  const foldedServer = {
    ...written,
    mcpServers: [
      ...written.mcpServers,
      { id: "srv-b", name: "linear", secretKeys: ["TOKEN"] },
    ],
  };
  for (const current of [editedField, foldedServer])
    assert.equal(
      resetsAfterSave({ discarded: false, current, written }),
      false,
    );
});

test("resetsAfterSave always resets after a Discard during the write", () => {
  const preSave = { ...written, theme: "light", mcpServers: [] };
  assert.equal(
    resetsAfterSave({ discarded: true, current: preSave, written }),
    true,
  );
  assert.equal(
    resetsAfterSave({ discarded: true, current: written, written }),
    true,
  );
});

test("stableStringify ignores object key order but not array order", () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});
