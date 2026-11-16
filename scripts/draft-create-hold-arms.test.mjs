// The draft-create-hold guard's promise-typed membership marker and its
// form-flag arm: fixtures for each spelling it must see or must pass, plus pins
// over the real tree, each with an in-memory mutation that must flip it.
// Node's stdlib test runner and node: imports only, so the installless `guards`
// job runs it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, view } from "./check-banned-patterns.mjs";

const check = CHECKS.find((c) => c.name === "draft-create-hold");
assert.ok(check, "no check named draft-create-hold");
const scan = (source, file) => check.scan(view(source), file);

const HOOK = "  const createHold = useDraftCreateHold(form);";

/** A create dialog with all four member markers, one per line from line 2. */
function fixture({
  form = "  const form = useAppForm({ onSubmit: async () => create() });",
  seed = "  useSeedOnOpen(open, seedOnOpen);",
  reset = "  const seedOnOpen = () => form.reset();",
  create = "  const create = () => createIssue.mutateAsync(vars);",
  hook = HOOK,
  body = [],
} = {}) {
  return [
    "export function CreateThingDialog({ open }) {",
    form,
    seed,
    reset,
    create,
    hook,
    ...body,
    "  return null;",
    "}",
  ].join("\n");
}

// ------------------------------------------------ membership: `=> Promise<`

test("a three-marker file whose create is a promise-typed prop is a member", () => {
  const source = fixture({
    create: "  type Props = { onCreate: (title: string) => Promise<void> };",
    hook: "",
  });
  assert.deepEqual(scan(source), [2]);
  assert.deepEqual(
    scan(fixture({ create: "  const onCreate = () => Promise .resolve();" })),
    [],
    "a hook caller reading no form flag scans clean",
  );
});

test("the promise marker tolerates whitespace and still needs the other three", () => {
  const create = "  onCreate: (title: string) =>\n    Promise <void>;";
  assert.deepEqual(scan(fixture({ create, hook: "" })), [2]);
  for (const missing of ["form", "seed", "reset"]) {
    assert.deepEqual(
      scan(fixture({ create, hook: "", [missing]: "  const x = 1;" })),
      [],
      `a file without its ${missing} marker is no member`,
    );
  }
});

test("the promise marker reads code only, never comments or strings", () => {
  for (const create of [
    "  // onCreate: (title: string) => Promise<void>;",
    "  /* => Promise<void> */",
    '  const note = "=> Promise<void>";',
    "  const note = `=> Promise<void>`;",
  ]) {
    assert.deepEqual(scan(fixture({ create, hook: "" })), [], create);
  }
});

// ----------------------------------------------- form-flag arm: required hits

test("a hook caller reading form-core's submit flag is reported at the read", () => {
  const cases = [
    ["  const busy = useSelector(form.store, (s) => s.isSubmitting);", [7]],
    ["  const busy = form.state.isSubmitting;", [7]],
    ["  const busy = useSelector(form.store, (s) => s?.isSubmitting);", [7]],
    [
      "  const busy = useSelector(form.store, (s) => s\n    .isSubmitting);",
      [8],
    ],
    [
      "  const busy = useSelector(form.store, (s) => s.\n    isSubmitting);",
      [8],
    ],
    [
      "  const busy = useSelector(form.store, ({ isSubmitting }) => isSubmitting);",
      [7],
    ],
    [
      "  const busy = useSelector(form.store, ({ canSubmit, isSubmitting }: S) => isSubmitting);",
      [7],
    ],
    ["  const { isSubmitting } = form.state;", [7]],
    ["  const { values,\n    isSubmitting: busy } = form.state;", [8]],
  ];
  for (const [line, expected] of cases) {
    assert.deepEqual(scan(fixture({ body: [line] })), expected, line);
  }
});

test("the arm reports every read, once per line", () => {
  const body = [
    "  const a = form.state.isSubmitting;",
    "  const b = useSelector(form.store, (s) => s.isSubmitting || s.isSubmitting);",
  ];
  assert.deepEqual(scan(fixture({ body })), [7, 8]);
});

test("the arm applies to a hook caller whatever its membership", () => {
  const source = fixture({
    form: "  const x = 1;",
    body: ["  const busy = form.state.isSubmitting;"],
  });
  assert.deepEqual(scan(source), [7]);
});

// --------------------------------------------- form-flag arm: required misses

test("the hook's own flag and its uses pass", () => {
  const body = [
    "  const isSubmitting = createHold.running;",
    "  const enabled = !generating && !isSubmitting;",
    "  const props = { disabled: isSubmitting, pending: isSubmitting };",
    "  if (createHold.isRunning()) return;",
    "  const { running: isSubmitting2 } = createHold;",
    "  const { running } = createHold;",
  ];
  assert.deepEqual(scan(fixture({ body })), []);
});

test("an object literal or a rest element named isSubmitting is no read", () => {
  const body = [
    "  report({ isSubmitting });",
    "  const state = { isSubmitting: createHold.running };",
    "  const { ...isSubmitting } = other;",
  ];
  assert.deepEqual(scan(fixture({ body })), []);
});

test("a default-parameter object literal or a type annotation is no read", () => {
  for (const line of [
    "  const f = (o = { isSubmitting: false }) => o;",
    "  const x: { isSubmitting: boolean } = load();",
    "  const g = (p: { isSubmitting: boolean }) => p;",
  ]) {
    assert.deepEqual(scan(fixture({ body: [line] })), [], line);
  }
});

test("a pattern opened after a paren, a comma or a declaration keyword is still a read", () => {
  for (const line of [
    "  const f = ({ isSubmitting } = {}) => isSubmitting;",
    "  const f = (a, { isSubmitting }) => isSubmitting;",
    "  let { isSubmitting } = form.state;",
    "  var {isSubmitting} = form.state;",
    "  ({ isSubmitting } = form.state);",
  ]) {
    assert.deepEqual(scan(fixture({ body: [line] })), [7], line);
  }
});

test("the spellings the message names as unseen pass", () => {
  for (const line of [
    "  function busyOf({ isSubmitting }: S) { return isSubmitting; }",
    "  const { state: { isSubmitting } } = form;",
    '  const busy = form.state["isSubmitting"];',
    "  const { isSubmitting, values: { title } } = form.state;",
    "  const f = ({ isSubmitting, onSave }: { isSubmitting: boolean; onSave: () => void }) =>",
  ]) {
    assert.deepEqual(scan(fixture({ body: [line] })), [], line);
  }
  for (const spelling of [
    "function declaration",
    "nested pattern",
    "bracket access",
    "a pattern holding any nested pattern",
    "annotated with a function type",
  ])
    assert.ok(check.message.includes(spelling), spelling);
});

test("the flag spelled in a comment or a string is no read", () => {
  const body = [
    "  // const busy = useSelector(form.store, (s) => s.isSubmitting);",
    "  /* const { isSubmitting } = form.state; */",
    '  const a = "form.state.isSubmitting";',
    "  const b = 'const { isSubmitting } = form.state';",
    "  const c = `(s) => s.isSubmitting`;",
  ];
  assert.deepEqual(scan(fixture({ body })), []);
});

test("a file without the hook call gains nothing from the arm", () => {
  const read = [
    "  const busy = useSelector(form.store, (s) => s.isSubmitting);",
  ];
  assert.deepEqual(
    scan(fixture({ hook: "", create: "  const x = 1;", body: read })),
    [],
    "a non-member reading the flag",
  );
  assert.deepEqual(
    scan(fixture({ hook: "", body: read })),
    [2],
    "a member is still reported at its useAppForm line only",
  );
  assert.deepEqual(
    scan(
      fixture({
        hook: "  // const createHold = useDraftCreateHold(form);",
        body: read,
      }),
    ),
    [2],
    "a hook call spelled in a comment is no call",
  );
});

test("a source the mask cannot lex throws on the arm's path too", () => {
  assert.throws(
    () => scan(fixture({ body: ["  const broken = `unterminated ${ x;"] })),
    /draft-create-hold: cannot lex/,
  );
});

// -------------------------------------------------------- real-tree pins

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "src"), { recursive: true })
  .map((entry) => `src/${String(entry).split("\\").join("/")}`)
  .filter(check.appliesTo);
const read = (file) => readFileSync(join(root, file), "utf8");
const HOOK_CALL = /\buseDraftCreateHold\s*\(/;

const CALLERS = [
  "src/features/discussions/CreateDiscussionDialog.tsx",
  "src/features/issues/CreateIssueDialog.tsx",
  "src/features/issues/CreateLocalIssueDialog.tsx",
  "src/features/pulls/CreateLocalPrDialog.tsx",
  "src/features/tags/CreateReleaseDialog.tsx",
];
const PROMISE_MEMBERS = [
  "src/features/projects/BoardAddDialogs.tsx",
  "src/features/projects/BoardDraftEditDialog.tsx",
  "src/features/projects/ProjectLifecycleDialogs.tsx",
];

test("the real hook callers scan clean, and a form-core read in each is reported", () => {
  assert.ok(files.length > 0, "the src walk found no .tsx files");
  const callers = files.filter((f) => HOOK_CALL.test(read(f))).sort();
  assert.ok(callers.length > 0, "no file calls useDraftCreateHold(");
  assert.deepEqual(callers, CALLERS);
  for (const file of callers) {
    const source = read(file);
    assert.deepEqual(scan(source, file), [], file);
    assert.ok(source.includes("createHold.running"), `${file} binds running`);
    const mutated = source.replace(
      "createHold.running",
      "useSelector(form.store, (s) => s.isSubmitting)",
    );
    assert.equal(
      scan(mutated, file).length,
      1,
      `${file} with a form-core read`,
    );
  }
});

test("the promise-typed members are members, allowlisted, and need the marker", () => {
  for (const file of PROMISE_MEMBERS) {
    const source = read(file);
    assert.ok(!HOOK_CALL.test(source), `${file} calls no hook`);
    assert.equal(scan(source, file).length, 1, `${file} is a member`);
    assert.ok(check.allowlist.includes(file), `${file} is allowlisted`);
    const unmarked = source.replace(/=>(\s*)Promise(\s*)</g, "=>$1Thenable$2<");
    assert.notEqual(unmarked, source, `${file} spells => Promise<`);
    assert.deepEqual(scan(unmarked, file), [], `${file} without the marker`);
  }
});
