// Pins the rename field's reseed (src/features/repo-settings/rename-seed.ts)
// that the danger zone's RenameAction runs on every render. The contract: a
// refreshed server name replaces the field only while the field shows the name
// it was seeded from or the one a rename sent; any other edit survives; an
// unmoved server name changes nothing, so a render-time caller can't loop.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module
// must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reseedRename } from "../src/features/repo-settings/rename-seed.ts";

test("an unedited field follows the refreshed name", () => {
  assert.deepEqual(
    reseedRename({ name: "old", seeded: "old", sent: null }, "renamed"),
    { name: "renamed", seeded: "renamed", sent: null },
  );
});

test("a field holding the sent name takes the normalized name read back", () => {
  assert.deepEqual(
    reseedRename({ name: "MyRepo", seeded: "old", sent: "MyRepo" }, "myrepo"),
    { name: "myrepo", seeded: "myrepo", sent: null },
  );
});

test("a sent name is matched trimmed, as the field sends it", () => {
  assert.deepEqual(
    reseedRename({ name: " MyRepo ", seeded: "old", sent: "MyRepo" }, "myrepo"),
    { name: "myrepo", seeded: "myrepo", sent: null },
  );
});

test("a different edit made during the request survives", () => {
  assert.deepEqual(
    reseedRename({ name: "other", seeded: "old", sent: "MyRepo" }, "myrepo"),
    { name: "other", seeded: "myrepo", sent: null },
  );
});

test("with nothing sent, a typed value is kept", () => {
  assert.deepEqual(
    reseedRename({ name: "typed", seeded: "old", sent: null }, "renamed"),
    { name: "typed", seeded: "renamed", sent: null },
  );
});

test("an unmoved server name is a no-op", () => {
  assert.equal(
    reseedRename({ name: "typed", seeded: "old", sent: "typed" }, "old"),
    null,
  );
});
