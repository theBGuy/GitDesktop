// Fixtures for check-workflow-node-setup.mjs: a hit and a passing sibling per
// rule, the YAML shapes the reader must accept or refuse, the CLI contract,
// and the real tree. Stdlib only, so the installless guards job runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseWorkflow,
  readCorpus,
  runsNode,
  verdict,
} from "./check-workflow-node-setup.mjs";

const SCRIPT = fileURLToPath(
  new URL("./check-workflow-node-setup.mjs", import.meta.url),
);
const ROOT = resolve(dirname(SCRIPT), "..");
const WF = ".github/workflows/ci.yml";
const SITE = `${WF}#build`;
const ACTION = ".github/actions/tool/action.yml";
const HEAD = "    runs-on: ubuntu-latest\n    timeout-minutes: 10\n";

const CHECKOUT = "      - uses: actions/checkout@v7\n";
const SETUP =
  "      - name: Install Node\n        uses: actions/setup-node@v7.1.0\n        with:\n          node-version-file: .node-version\n";
const NODE = "      - run: node scripts/x.mjs\n";
const PASSING = workflow(CHECKOUT + SETUP + NODE);

function workflow(steps, { head = HEAD, prefix = "" } = {}) {
  return `${prefix}name: ci\non: push\njobs:\n  build:\n${head}    steps:\n${steps}`;
}

function action(steps) {
  return `name: tool\ndescription: >-\n  Folded\n  text.\nruns:\n  using: composite\n  steps:\n${steps}`;
}

function check(files, { nodeVersion = "24\n", exempt = new Map() } = {}) {
  const map =
    typeof files === "string"
      ? new Map([[WF, files]])
      : new Map(Object.entries(files));
  return verdict(map, nodeVersion, exempt);
}

function lineOf(source, needle) {
  const line = source.split("\n").findIndex((text) => text.includes(needle));
  assert.ok(line >= 0, `fixture lacks ${needle}`);
  return line + 1;
}

const shape = (result) =>
  result.findings.map(({ rule, file, line }) => [rule, file, line]);

function passes(result) {
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
}

// Bounds for adversarial inputs, which a super-linear regex takes seconds on.
const LINEAR_BUDGET_MS = 250;
// The guards job runs every suite in parallel, so a 60k-line parse gets room.
const MANY_LINES_BUDGET_MS = 1000;

// Process CPU time, so a worker descheduled under a parallel run can't fail
// a budget its own work met.
function timed(run) {
  const start = process.cpuUsage();
  const result = run();
  const { user, system } = process.cpuUsage(start);
  return { result, elapsed: (user + system) / 1000 };
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "gd-wf-node-setup-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("setup-node rules", () => {
  test("a passing job: checkout, setup-node from .node-version, node", () => {
    const result = check(PASSING);
    passes(result);
    assert.deepEqual(result.nodeJobs, [SITE]);
    assert.equal(result.timedJobs, 1);
    assert.equal(result.setupSteps, 1);
  });

  test("setup-node-missing at the first node step", () => {
    const source = workflow(CHECKOUT + NODE);
    assert.deepEqual(shape(check(source)), [
      ["setup-node-missing", WF, lineOf(source, "- run: node")],
    ]);
    assert.match(
      check(source).failures[0],
      /^workflow-node-setup: FAIL \.github\/workflows\/ci\.yml:9: setup-node-missing: job build runs node at step 2 .* \(fix: add `uses: actions\/setup-node@<ref>` with `node-version-file: \.node-version` after checkout and before step 2\)$/,
    );
  });

  test("setup-node-after-node when setup-node comes after the node step", () => {
    const source = workflow(CHECKOUT + NODE + SETUP);
    assert.deepEqual(shape(check(source)), [
      ["setup-node-after-node", WF, lineOf(source, "- run: node")],
    ]);
  });

  test("setup-node-form: no ref, node-version, another file, no with, if:", () => {
    const forms = {
      "no ref": SETUP.replace("@v7.1.0", ""),
      "empty ref": SETUP.replace("@v7.1.0", "@"),
      "node-version": `${SETUP}          node-version: 24\n`,
      ".nvmrc": SETUP.replace(".node-version", ".nvmrc"),
      "no with": "      - uses: actions/setup-node@v7.1.0\n",
      "if:": SETUP.replace(
        "        uses:",
        "        if: github.event_name == 'push'\n        uses:",
      ),
    };
    for (const [label, setup] of Object.entries(forms)) {
      const source = workflow(CHECKOUT + setup + NODE);
      assert.deepEqual(
        shape(check(source)),
        [
          [
            "setup-node-form",
            WF,
            lineOf(
              source,
              setup.includes("- name:")
                ? "- name: Install Node"
                : "- uses: actions/setup-node",
            ),
          ],
          ["setup-node-missing", WF, lineOf(source, "- run: node")],
        ],
        label,
      );
    }
  });

  test("setup-node passes with any ref, ./.node-version and any letter case", () => {
    const passing = [
      SETUP.replace("v7.1.0", "v8.0.0"),
      SETUP.replace("v7.1.0", "0123456789abcdef0123456789abcdef01234567"),
      SETUP.replace(".node-version", "./.node-version"),
      SETUP.replace(
        "actions/setup-node@v7.1.0",
        "Actions/Setup-Node@v4",
      ).replace("node-version-file", "Node-Version-File"),
    ];
    for (const setup of passing)
      passes(check(workflow(CHECKOUT + setup + NODE)));
    passes(
      check(
        workflow(
          CHECKOUT.replace("actions/checkout", "Actions/Checkout") +
            SETUP +
            NODE,
        ),
      ),
    );
  });

  test("a setup-node run in the background is unreadable", () => {
    const background = (value) =>
      SETUP.replace(
        "        uses:",
        `        background: ${value}\n        uses:`,
      );
    for (const value of ["true", "${{ true }}", "'false'"]) {
      const source = workflow(CHECKOUT + background(value) + NODE);
      const result = check(source);
      assert.deepEqual(
        shape(result),
        [["unreadable", WF, lineOf(source, "- name: Install Node")]],
        value,
      );
      assert.match(
        result.failures[0],
        /step 2 sets Node up in the background \(fix: run setup-node in the foreground \(drop `background:`\)\)$/,
      );
    }
    passes(check(workflow(CHECKOUT + background("false") + NODE)));
    const caller = workflow(
      `${CHECKOUT}      - uses: ./.github/actions/tool\n        background: true\n${NODE}`,
    );
    assert.deepEqual(
      shape(
        check({
          [WF]: caller,
          [ACTION]: action(SETUP.replace(/^ {6}/gm, "    ")),
        }),
      ),
      [["unreadable", WF, lineOf(caller, "- uses: ./.github/actions/tool")]],
    );
  });

  test("a Node-Version key in another letter case is still node-version", () => {
    const source = workflow(
      `${CHECKOUT}${SETUP}          Node-Version: 24\n${NODE}`,
    );
    assert.deepEqual(
      shape(check(source)).map(([rule]) => rule),
      ["setup-node-form", "setup-node-missing"],
    );
  });

  test("setup-node-before-checkout, and a conditional checkout does not count", () => {
    const checkouts = [
      "",
      `${CHECKOUT}        if: github.event_name == 'push'\n`,
      `${CHECKOUT}        continue-on-error: true\n`,
    ];
    for (const checkout of checkouts) {
      const source = workflow(checkout + SETUP + NODE);
      assert.deepEqual(shape(check(source)), [
        [
          "setup-node-before-checkout",
          WF,
          lineOf(source, "- name: Install Node"),
        ],
        ["setup-node-missing", WF, lineOf(source, "- run: node")],
      ]);
    }
    passes(
      check(
        workflow(
          `${CHECKOUT}        continue-on-error: false\n${SETUP}${NODE}`,
        ),
      ),
    );
  });

  // The rust-tests gate's shape: a setup-node under continue-on-error counts
  // as setup, and an upload step (a `uses:` action) and an echo that names
  // setup-node run no node.
  test("the gate's continue-on-error setup-node counts as setup", () => {
    const source = workflow(`      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - name: Install Node
        id: node
        continue-on-error: true
        uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .node-version

      - name: Decide whether the matrix must run
        id: decide
        if: steps.node.outcome == 'success'
        continue-on-error: true
        timeout-minutes: 8
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
          EVENT: \${{ github.event_name }}
          ATTEMPT: \${{ github.run_attempt }}
        run: node scripts/check-rust-gate.mjs

      - name: Record the tested checkout's identity
        if: \${{ !cancelled() && steps.decide.outputs.identity != '' }}
        continue-on-error: true
        timeout-minutes: 1
        uses: actions/upload-artifact@v7.0.2
        with:
          name: \${{ steps.decide.outputs.identity }}
          path: \${{ runner.temp }}/rust-gate-evidence/identity.txt
          if-no-files-found: error
          overwrite: true
          retention-days: 14

      - name: Report a gate that made no decision
        if: \${{ !cancelled() && (steps.decide.outcome != 'success' || steps.decide.outputs.run == '') }}
        env:
          NODE: \${{ steps.node.outcome }}
          DECIDE: \${{ steps.decide.outcome }}
        shell: bash
        run: |
          echo "::error::rust-tests gate made no decision (setup-node: $NODE, decide: $DECIDE); the test matrix runs (fail-open)."
`);
    const result = check(source);
    passes(result);
    assert.deepEqual(result.nodeJobs, [SITE]);
  });

  describe("a setup-node that may fail open", () => {
    const failOpen = (id = "        id: node\n") =>
      `      - name: Install Node\n${id}        continue-on-error: true\n        uses: actions/setup-node@v7.1.0\n        with:\n          node-version-file: .node-version\n`;
    const nodeStep = (fields) =>
      `      - name: Run\n${fields}        run: node scripts/x.mjs\n`;

    test("covers a node step gated on its success or non-gating itself", () => {
      for (const fields of [
        "        if: steps.node.outcome == 'success'\n",
        "        if: ${{ steps.node.outcome == 'success' }}\n",
        "        if: \"${{ steps.node.outcome == 'success' }}\"\n",
        "        if: github.event_name == 'push' && Steps.Node.Outcome=='success'\n",
        "        if: >-\n          github.event_name == 'push' &&\n          steps.node.outcome == 'success'\n",
        "        if: |\n          github.event_name == 'push' &&\n          steps.node.outcome == 'success'\n",
        "        if: |-\n          steps.node.outcome == 'success'\n",
        "        if: |-\n          ${{ steps.node.outcome == 'success' }}\n",
        "        if: >-\n          ${{ steps.node.outcome == 'success' }}\n",
        "        if: github.ref != 'a && (b' && steps.node.outcome == 'success'\n",
        "        continue-on-error: true\n",
      ]) {
        passes(check(workflow(CHECKOUT + failOpen() + nodeStep(fields))));
      }
      passes(
        check(
          workflow(
            CHECKOUT +
              failOpen("") +
              nodeStep("        continue-on-error: true\n"),
          ),
        ),
      );
    });

    test("leaves any other later node step setup-node-missing", () => {
      for (const [setup, fields] of [
        [failOpen(), ""],
        [failOpen(""), "        if: steps.node.outcome == 'success'\n"],
        [failOpen(), "        if: steps.other.outcome == 'success'\n"],
        [failOpen(), "        if: steps.node.outcome != 'success'\n"],
        [
          failOpen(),
          "        if: steps.node.outcome == 'success' || always()\n",
        ],
        [
          failOpen(),
          "        if: always() || steps.node.outcome == 'success'\n",
        ],
        [
          failOpen(),
          "        if: ${{ !(true && steps.node.outcome == 'success' && true) }}\n",
        ],
        [
          failOpen(),
          "        if: ${{ github.event_name == 'push' }} && steps.node.outcome == 'success'\n",
        ],
        [
          failOpen(),
          "        if: \" ${{ steps.node.outcome == 'success' }}\"\n",
        ],
        [
          failOpen(),
          "        if: '${{ steps.node.outcome == ''success'' }} '\n",
        ],
        // A clipped or kept block scalar ends in a line break, and a deeper
        // blank-looking line is content: each makes the `${{ }}` a template.
        [
          failOpen(),
          "        if: |\n          ${{ steps.node.outcome == 'success' }}\n",
        ],
        [
          failOpen(),
          "        if: >\n          ${{ steps.node.outcome == 'success' }}\n",
        ],
        [
          failOpen(),
          "        if: |+\n          ${{ steps.node.outcome == 'success' }}\n",
        ],
        [
          failOpen(),
          "        if: |-\n          ${{ steps.node.outcome == 'success' }}\n             \n",
        ],
        [failOpen(), "        continue-on-error: ${{ true }}\n"],
        [failOpen(), "        continue-on-error: false\n"],
      ]) {
        const source = workflow(CHECKOUT + setup + nodeStep(fields));
        const result = check(source);
        assert.deepEqual(
          shape(result),
          [["setup-node-missing", WF, lineOf(source, "- name: Run")]],
          fields || "unconditioned",
        );
        assert.match(
          result.failures[0],
          /may fail open, without depending on its success \(fix: gate it with `if: steps\.<setup-node id>\.outcome == 'success'`, or make it non-gating with `continue-on-error: true`\)$/,
        );
      }
    });

    const missingRun = (source, label) =>
      assert.deepEqual(
        shape(check(source)),
        [["setup-node-missing", WF, lineOf(source, "- name: Run")]],
        label,
      );

    test("a U+00A0 after `${{ }}` is content; blanks and TABs still trim", () => {
      const nbsp = String.fromCharCode(0xa0);
      for (const fields of [
        `        if: \${{ steps.node.outcome == 'success' }}${nbsp}\n`,
        `        if: \${{ steps.node.outcome == 'success' }}${nbsp} # why\n`,
        `        if: "\${{ steps.node.outcome == 'success' }}${nbsp}"\n`,
        `        if: ${nbsp}\${{ steps.node.outcome == 'success' }}\n`,
      ]) {
        missingRun(
          workflow(CHECKOUT + failOpen() + nodeStep(fields)),
          JSON.stringify(fields),
        );
      }
      for (const fields of [
        "        if: ${{ steps.node.outcome == 'success' }} \t \n",
        "        if: steps.node.outcome == 'success'\t# why\n",
        "        if: \" steps.node.outcome == 'success' \t\"\n",
        "        if: |-\n          steps.node.outcome == 'success' \t\n",
      ]) {
        passes(check(workflow(CHECKOUT + failOpen() + nodeStep(fields))));
      }
    });

    // The runner's expression lexer skips Char.IsWhiteSpace, U+00A0 included.
    test("a U+00A0 inside an expression is white space, so the conjunct gates", () => {
      const nbsp = String.fromCharCode(0xa0);
      for (const fields of [
        `        if: \${{ steps.node.outcome == 'success'${nbsp}}}\n`,
        `        if: \${{${nbsp}steps.node.outcome == 'success' }}\n`,
        `        if: steps.node.outcome == 'success'${nbsp}\n`,
        `        if: "steps.node.outcome == 'success'${nbsp}"\n`,
        `        if: steps.node.outcome${nbsp}==${nbsp}'success'\n`,
        `        if: steps.node.outcome == 'success'${nbsp}&& github.event_name == 'push'\n`,
      ]) {
        passes(check(workflow(CHECKOUT + failOpen() + nodeStep(fields))));
      }
    });

    test("an `||` or `&&` inside brackets stays inside its operand", () => {
      passes(
        check(
          workflow(
            CHECKOUT +
              failOpen() +
              nodeStep(
                "        if: steps.node.outcome == 'success' && vars[matrix.flag || 'RUN_NODE'] == 'true'\n",
              ),
          ),
        ),
      );
      for (const fields of [
        "        if: vars[env.FEATURE && steps.node.outcome == 'success' && 'SKIP_NODE'] != 'true'\n",
        "        if: steps.node.outcome == 'success' && vars[x || y\n",
        "        if: steps.node.outcome == 'success' && vars[x) || (y]\n",
        "        if: steps.node.outcome == 'success' && (x] || [y)\n",
      ]) {
        missingRun(workflow(CHECKOUT + failOpen() + nodeStep(fields)), fields);
      }
    });

    test("an `||` inside parentheses or quotes leaves the setup conjunct gating", () => {
      for (const fields of [
        "        if: steps.node.outcome == 'success' && (github.event_name == 'push' || github.event_name == 'pull_request')\n",
        "        if: ${{ (github.event_name == 'push' || github.event_name == 'pull_request') && steps.node.outcome == 'success' }}\n",
        "        if: steps.node.outcome == 'success' && github.ref != 'a || b'\n",
      ]) {
        passes(check(workflow(CHECKOUT + failOpen() + nodeStep(fields))));
      }
      for (const fields of [
        "        if: github.event_name == 'push' || github.event_name == 'pull_request'\n",
        "        if: steps.node.outcome == 'success' || github.event_name == 'push'\n",
        "        if: steps.node.outcome == 'success' && (x || y\n",
        "        if: steps.node.outcome == 'success' && x) || (y\n",
        "        if: steps.node.outcome == 'success' && x == 'a || b\n",
      ]) {
        missingRun(workflow(CHECKOUT + failOpen() + nodeStep(fields)), fields);
      }
    });

    test("a clipped or kept block `if:` the file ends on is a template", () => {
      const last = (header) =>
        workflow(
          `${CHECKOUT}${failOpen()}      - name: Run\n        run: node scripts/x.mjs\n        if: ${header}\n          \${{ steps.node.outcome == 'success' }}`,
        );
      for (const header of ["|", ">", "|+", ">+"]) {
        missingRun(last(header), header);
      }
      for (const header of ["|-", ">-"]) passes(check(last(header)));
    });

    test("a setup-node that fails closed covers every later step", () => {
      passes(
        check(
          workflow(
            `${CHECKOUT}${failOpen().replace("continue-on-error: true", "continue-on-error: false")}${NODE}`,
          ),
        ),
      );
      passes(check(workflow(CHECKOUT + failOpen() + SETUP + NODE)));
    });
  });

  describe("a node step under a status function", () => {
    const setup = SETUP.replace(
      "        uses:",
      "        id: node\n        uses:",
    );
    const nodeStep = (fields) =>
      `      - name: Run\n${fields}        run: node scripts/x.mjs\n`;

    test("runs after a failed setup-node, so it must depend on its success", () => {
      for (const [setupStep, condition] of [
        [setup, "always()"],
        [setup, "failure()"],
        [setup, "cancelled()"],
        [setup, "${{ !cancelled() }}"],
        [setup, "always() && github.event_name == 'push'"],
        [setup, "${{ !success() }}"],
        [setup, "success() == false"],
        [setup, "${{ !(success()) }}"],
        [setup, "success() || github.event_name == 'push'"],
        [setup, "success() || always()"],
        [setup, "${{ github.event_name == 'push' }} && always()"],
        [setup, "${{ !cancelled() && github.event_name == 'push' }}"],
        [SETUP, "always() && steps.node.outcome == 'success'"],
      ]) {
        const source = workflow(
          CHECKOUT + setupStep + nodeStep(`        if: ${condition}\n`),
        );
        const result = check(source);
        assert.deepEqual(
          shape(result),
          [["setup-node-missing", WF, lineOf(source, "- name: Run")]],
          condition,
        );
        assert.match(
          result.failures[0],
          /under a condition that can run it after a failed setup-node, without depending on its success \(fix: gate it with `if: steps\.<setup-node id>\.outcome == 'success'`, or make it non-gating with `continue-on-error: true`\)$/,
        );
      }
    });

    test("passes when gated on the setup's success, non-gating, or without a status function", () => {
      for (const fields of [
        "        if: always() && steps.node.outcome == 'success'\n",
        "        if: ${{ !cancelled() && steps.node.outcome == 'success' }}\n",
        "        if: always()\n        continue-on-error: true\n",
        "        if: success()\n",
        "        if: ${{ success() }}\n",
        "        if: success() && github.event_name == 'push'\n",
        "        if: ${{ success() && !cancelled() }}\n",
        "        if: github.event_name == 'push'\n",
        "        if: ${{ github.event_name == 'push' }} && steps.node.outcome == 'success'\n",
        "        if: \" ${{ github.event_name == 'push' }}\"\n",
      ]) {
        passes(check(workflow(CHECKOUT + setup + nodeStep(fields))));
      }
    });

    test("a bare success() beside a grouped or quoted `||` still requires success", () => {
      for (const fields of [
        "        if: success() && (github.event_name == 'push' || github.event_name == 'pull_request')\n",
        "        if: ${{ (github.event_name == 'push' || always()) && success() }}\n",
        "        if: success() && github.ref != 'a || b'\n",
      ]) {
        passes(check(workflow(CHECKOUT + setup + nodeStep(fields))));
      }
      for (const condition of [
        "(success() && github.event_name == 'push') || github.event_name == 'pull_request'",
        "success() && (always() || github.event_name == 'push'",
      ]) {
        const source = workflow(
          CHECKOUT + setup + nodeStep(`        if: ${condition}\n`),
        );
        assert.deepEqual(
          shape(check(source)),
          [["setup-node-missing", WF, lineOf(source, "- name: Run")]],
          condition,
        );
      }
    });

    test("a success() inside an index is no bare conjunct; an indexed `||` is no top-level one", () => {
      passes(
        check(
          workflow(
            CHECKOUT +
              setup +
              nodeStep(
                "        if: success() && vars[matrix.flag || 'RUN_NODE'] == 'true'\n",
              ),
          ),
        ),
      );
      const source = workflow(
        CHECKOUT +
          setup +
          nodeStep("        if: vars['A' && success() && 'B'] != 'x'\n"),
      );
      assert.deepEqual(shape(check(source)), [
        ["setup-node-missing", WF, lineOf(source, "- name: Run")],
      ]);
    });

    test("a clipped block success() is a template; a stripped one is an expression", () => {
      const source = workflow(
        CHECKOUT +
          setup +
          nodeStep("        if: |\n          ${{ success() }}\n"),
      );
      const result = check(source);
      assert.deepEqual(shape(result), [
        ["setup-node-missing", WF, lineOf(source, "- name: Run")],
      ]);
      assert.match(
        result.failures[0],
        /under a condition that can run it after a failed setup-node/,
      );
      passes(
        check(
          workflow(
            CHECKOUT +
              setup +
              nodeStep("        if: |-\n          ${{ success() }}\n"),
          ),
        ),
      );
    });
  });
});

describe("node run detection", () => {
  const hits = [
    'sh -c "node x"',
    "bash -c 'npm test'",
    "/usr/bin/node x",
    "node;echo",
    "node&&echo",
    "node>log",
    "x=$(node)",
    "node.exe x",
    "npm.cmd ci",
    "NPM ci",
    "tsx x.ts",
    "yarn build",
    "./node_modules/.bin/vite build",
    ".\\node_modules\\.bin\\vite build",
    "C:\\tools\\node.exe x",
    "nodejs x",
    "npx vite",
    "pnpm i",
    "corepack enable",
    "echo `node -v`",
    "(node x)",
    "a | node",
    "./scripts/x.mjs",
    "scripts/x.cjs a",
    "x.js",
    "FOO=1 ./x.mjs",
    "if true; then ./x.mjs; fi",
    "node.ps1 x",
    "npm.bat ci",
    "pnpm.ps1 i",
    "pnpx vite",
    "ts-node x.ts",
    "vite-node x.ts",
    "babel-node x.js",
    "@npm.cmd ci",
    "@node x.mjs",
    "if node -v; then echo; fi",
    "if ./x.mjs; then echo; fi",
    "if true; then echo; elif ./x.mjs; then echo; fi",
    "while ./x.mjs; do sleep 1; done",
    "until ./x.mjs; do sleep 1; done",
    "! ./x.mjs",
    "X=1 ./a.mjs",
    "{ ./scripts/check.mjs; }",
    '{ node x; } >> "$GITHUB_STEP_SUMMARY"',
    "true && { FOO=1 ./x.mjs; }",
    'V="a b" ./x.mjs',
    "NODE_OPTIONS='--x' ./x.mjs",
    "MODE=${{ matrix.mode }} ./ci/check.mjs",
    "A=${{ a }} B=${{ b }} ./x.mjs",
    "node ${{ matrix.script }}",
    '"./x.mjs"',
    "'./x.mjs' --flag",
    'V=1 "./x.mjs"',
    'V=a"b"c ./x.mjs',
    'V="a\\"b" ./x.mjs',
  ];
  for (const command of hits) {
    test(`a run of ${command} needs setup-node`, () => {
      const source = workflow(
        `${CHECKOUT}      - run: |\n          ${command}\n`,
      );
      assert.deepEqual(shape(check(source)), [
        ["setup-node-missing", WF, lineOf(source, "- run: |")],
      ]);
    });
  }

  test("words that only contain a node-family name are not runs", () => {
    for (const text of [
      "echo setup-node",
      "cargo test",
      "echo $NODE_VERSION",
      "ls nodes",
      'echo "(setup-node: $NODE, decide: $DECIDE)"',
      "cat src/App.tsx",
      "echo wow! ./x.mjs",
      "echo to env ./x.mjs",
      "asset=dist/app.js",
      "X=./a.mjs",
      "echo {a,b}.js",
      "V=a|b ./x.mjs",
    ]) {
      assert.equal(runsNode(text), false, text);
    }
  });

  // A closing quote ends an argument; it starts no command.
  test("a script path after a quoted argument is an argument", () => {
    for (const text of [
      'cp "$artifact" dist/app.js',
      'cp "$a" "dist/app.js"',
      "cp '$a' dist/app.js",
      'echo "done" > out/app.js',
    ]) {
      assert.equal(runsNode(text), false, text);
    }
    const result = check(
      workflow(`${CHECKOUT}      - run: cp "$artifact" dist/app.js\n`),
    );
    passes(result);
    assert.deepEqual(result.nodeJobs, []);
  });

  // Lines are never joined at a trailing backslash, so a continued path
  // argument reads as a command (false positive by design), while a command
  // after a comment's or pwsh's trailing backslash is never hidden.
  test("a trailing backslash never joins lines", () => {
    for (const [text, expected] of [
      ['cp "$artifact" \\\n  dist/app.js', true],
      ["V=1 \\\n  ./x.mjs", true],
      ["echo ready # staged under C:\\\n./scripts/check.mjs", true],
      ["# note \\\necho hi", false],
    ]) {
      assert.equal(runsNode(text), expected, text);
    }
    const source = workflow(
      `${CHECKOUT}      - shell: pwsh\n        run: |\n          Set-Location .\\scripts\\\n          node --version\n`,
    );
    assert.deepEqual(shape(check(source)), [
      ["setup-node-missing", WF, lineOf(source, "- shell: pwsh")],
    ]);
  });

  test("a long backslash run stays linear", () => {
    const { result, elapsed } = timed(() =>
      runsNode(`${"\\".repeat(100000)}x\nmake build`),
    );
    assert.equal(result, false);
    assert.ok(elapsed < LINEAR_BUDGET_MS, `${elapsed} ms`);
  });

  // False positive by design: the scan doesn't track quotes, so a separator
  // inside a string restarts it.
  test("a command separator inside a quoted string still starts a command", () => {
    assert.equal(runsNode("echo 'packaged; dist/app.js'"), true);
  });

  // An assignment's value takes a backslash escape whole, as the shell does,
  // except an escaped command separator, which stays out of reach.
  test("an escaped character in an assignment stays in its value", () => {
    for (const text of [
      "LABEL=release\\ candidate ./x.mjs",
      'V=a\\"b ./x.mjs',
      "V=a\\'b ./x.mjs",
    ]) {
      assert.equal(runsNode(text), true, text);
    }
    assert.equal(runsNode("V=a\\;b ./x.mjs"), false);
  });

  // A `\"` read as opening a span, or an escaped separator taken into a value,
  // would let every separator inside the chain re-scan it to the end.
  test("assignment chains with quotes and escaped separators stay linear", () => {
    for (const unit of ['V=";V=a\\"b"', "V=a\\;V=b", "V=a\\{ V=b"]) {
      for (const text of [
        `${unit.repeat(16000)} make build.js`,
        `${`${unit} `.repeat(16000)}make build.js`,
      ]) {
        const { result, elapsed } = timed(() => runsNode(text));
        assert.equal(result, false, unit);
        assert.ok(elapsed < LINEAR_BUDGET_MS, `${unit}: ${elapsed} ms`);
      }
    }
  });

  // Out of reach by contract: a value's backtick substitution ends it, so text
  // glued past one leaves the script an argument; a string another program
  // runs is that program's argument.
  test("a script glued past a backtick or in another program's string is out of reach", () => {
    for (const text of [
      "V=`c`b ./x.mjs",
      'bash -c "./x.mjs"',
      "sh -c './x.mjs'",
    ]) {
      assert.equal(runsNode(text), false, text);
    }
  });

  // A super-linear chain would stall the required guards job on this shape.
  test("aligned assignment prefixes stay linear", () => {
    const prefixes = Array.from({ length: 13 }, (_, i) => `V${i}=x`).join(
      "    ",
    );
    for (const [tail, expected] of [
      ["    make build", false],
      ["    ./x.mjs", true],
    ]) {
      const { result, elapsed } = timed(() => runsNode(prefixes + tail));
      assert.equal(result, expected, tail);
      assert.ok(elapsed < LINEAR_BUDGET_MS, `${tail}: ${elapsed} ms`);
    }
  });

  // A value spanning a command start would make every start re-scan the chain.
  test("assignment values that hold a command-start character stay linear", () => {
    for (const prefix of [
      "V='x' ",
      "V=a{ ",
      "V='x;V=1' ",
      'V="a b" ',
      'V=" ',
      'V="\\" ',
    ]) {
      const { result, elapsed } = timed(() =>
        runsNode(`${prefix.repeat(20000)}make build`),
      );
      assert.equal(result, false, prefix);
      assert.ok(elapsed < LINEAR_BUDGET_MS, `${prefix}: ${elapsed} ms`);
    }
  });

  // A substitution retried at every unclosed `${{` would re-scan the rest.
  test("many unclosed or closed expressions in a run stay linear", () => {
    for (const [text, expected] of [
      [`${"${{ a ".repeat(30000)}./x.mjs`, false],
      [`${"V=${{ a }} ".repeat(30000)}./x.mjs`, true],
    ]) {
      const { result, elapsed } = timed(() => runsNode(text));
      assert.equal(result, expected, text.slice(0, 12));
      assert.ok(
        elapsed < LINEAR_BUDGET_MS,
        `${text.slice(0, 12)}: ${elapsed} ms`,
      );
    }
  });

  test("a standalone assignment naming a script is not a run", () => {
    const result = check(
      workflow(
        `${CHECKOUT}      - run: |\n          asset=dist/app.js\n          X=./a.mjs\n          echo "$asset $X"\n`,
      ),
    );
    passes(result);
    assert.deepEqual(result.nodeJobs, []);
  });

  test("shell comment lines are not runs", () => {
    assert.equal(runsNode("# node x.mjs\n  # npm ci\necho hi"), false);
    const result = check(
      workflow(
        `${CHECKOUT}      - run: |\n          # node scripts/x.mjs runs in the next job\n          echo hi\n`,
      ),
    );
    passes(result);
    assert.deepEqual(result.nodeJobs, []);
  });

  // Declined: telling an argument from a command needs a shell parser, so the
  // visible false positive stays and the remedy is rewording the text.
  test("a node-family word in a quoted argument still counts as a run", () => {
    const source = workflow(
      `${CHECKOUT}      - run: echo "node is unavailable"\n`,
    );
    assert.deepEqual(shape(check(source)), [
      ["setup-node-missing", WF, lineOf(source, "- run: echo")],
    ]);
  });

  test("a folded run keeps a command after a blank or more-indented line on its own line", () => {
    for (const lines of [
      "          echo ready\n\n          ./scripts/task.mjs\n",
      "          echo ready\n\n          node x.mjs\n",
      "          echo ready\n            ./scripts/task.mjs\n",
    ]) {
      const source = workflow(`${CHECKOUT}      - run: >-\n${lines}`);
      assert.deepEqual(
        shape(check(source)),
        [["setup-node-missing", WF, lineOf(source, "- run: >-")]],
        lines,
      );
    }
    const folded = check(
      workflow(
        `${CHECKOUT}      - run: >-\n          echo ready\n          ./scripts/task.mjs\n`,
      ),
    );
    passes(folded);
    assert.deepEqual(folded.nodeJobs, []);
  });

  // Out of reach by contract: a command an expression supplies is invisible,
  // like one behind a variable, so these read as no node run at all.
  test("a command supplied by an expression is out of reach", () => {
    for (const command of [
      "${{ matrix.cmd }}",
      "echo a && ${{ matrix.cmd }}",
      "echo a || ${{ matrix.cmd }}",
      "echo a; ${{ matrix.cmd }}",
      "echo a | ${{ matrix.cmd }}",
      "X=1 ${{ matrix.cmd }} --flag",
      '"${{ matrix.command }}" --version',
      "'${{ matrix.command }}' --version",
      'echo a && "${{ matrix.cmd }}"',
      "if ${{ matrix.tool }} --version; then echo; fi",
      "while ${{ matrix.probe }}; do sleep 1; done",
      "! ${{ matrix.cmd }}",
      "env FOO=1 ${{ matrix.cmd }}",
      "sudo ${{ matrix.cmd }}",
      "echo a; sudo env X=1 ${{ matrix.cmd }}",
      "{ ${{ matrix.tool }} --version; }",
      'echo "${{ matrix.cmd }}"',
      "X=${{ matrix.x }} ./run.sh",
      'echo "Deploying to env ${{ inputs.environment }}"',
      'echo "Building (${{ matrix.os }})"',
      "${{ matrix.tool }} ./x.mjs",
    ]) {
      const result = check(
        workflow(
          `${CHECKOUT}      - run: |\n          echo start\n          ${command}\n`,
        ),
      );
      passes(result);
      assert.deepEqual(result.nodeJobs, [], command);
    }
    const plain = check(
      workflow(`${CHECKOUT}      - run: \${{ matrix.cmd }}\n`),
    );
    passes(plain);
    assert.deepEqual(plain.nodeJobs, []);
    passes(
      check(
        workflow(
          `${CHECKOUT}${SETUP}      - run: node x.mjs \${{ matrix.arg }}\n`,
        ),
      ),
    );
  });

  test("a node shell makes the step a node run, at every level", () => {
    const step = "      - run: console.log(1)\n";
    const levels = [
      workflow(
        `${CHECKOUT}      - shell: node {0}\n        run: console.log(1)\n`,
      ),
      workflow(CHECKOUT + step, {
        head: `${HEAD}    defaults:\n      run:\n        shell: node {0}\n`,
      }),
      workflow(CHECKOUT + step, {
        prefix: "defaults:\n  run:\n    shell: node {0}\n",
      }),
    ];
    for (const source of levels) {
      assert.deepEqual(
        shape(check(source)).map(([rule]) => rule),
        ["setup-node-missing"],
      );
    }
    assert.deepEqual(
      shape(
        check(
          workflow(CHECKOUT + step, {
            head: `${HEAD}    defaults:\n      run:\n        shell: bash\n`,
            prefix: "defaults:\n  run:\n    shell: node {0}\n",
          }),
        ),
      ),
      [],
    );
  });

  test("an unresolvable defaults shell is unreadable", () => {
    for (const shell of ["${{ matrix.shell }}", "\n      - bash"]) {
      const source = workflow(CHECKOUT + SETUP + NODE, {
        prefix: `defaults:\n  run:\n    shell: ${shell}\n`,
      });
      assert.deepEqual(shape(check(source)), [["unreadable", WF, 3]]);
    }
  });

  test("a node token inside braces in a block scalar is a run", () => {
    const source = workflow(`${CHECKOUT}      - run: |
          {
            echo 'body<<EOF'
            node scripts/extract.mjs "\${{ github.ref_name }}"
          } >> "$GITHUB_OUTPUT"
`);
    assert.deepEqual(
      shape(check(source)).map(([rule]) => rule),
      ["setup-node-missing"],
    );
  });

  test("a backslash-continued node command is a run", () => {
    const source = workflow(`${CHECKOUT}      - run: |
          printf '%s\\n' "$x" > out.txt
          node scripts/check.mjs \\
            out.txt "$TITLE"
`);
    assert.deepEqual(
      shape(check(source)).map(([rule]) => rule),
      ["setup-node-missing"],
    );
  });
});

describe("hostile bytes", () => {
  const codes = [0x0d, 0x01, 0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0xfeff];
  for (const code of codes) {
    test(`character ${code.toString(16)} is unreadable`, () => {
      const source = workflow(
        `${CHECKOUT}${SETUP}      - run: node x.mjs # a${String.fromCharCode(code)}b\n`,
      );
      assert.deepEqual(shape(check(source)), [
        ["unreadable", WF, lineOf(source, "node x.mjs")],
      ]);
    });
  }

  test("a leading byte-order mark and CRLF line ends pass", () => {
    passes(check(String.fromCharCode(0xfeff) + PASSING));
    passes(check(PASSING.replace(/\n/g, "\r\n")));
  });

  test("two leading byte-order marks are unreadable through the corpus too", () => {
    const bom = String.fromCharCode(0xfeff);
    assert.deepEqual(shape(check(bom + bom + PASSING)), [
      ["unreadable", WF, 1],
    ]);
    const dir = tree({
      [WF]: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
        Buffer.from(PASSING),
      ]),
      ".node-version": "24\n",
    });
    try {
      const { files, nodeVersion } = readCorpus(dir);
      assert.deepEqual(shape(verdict(files, nodeVersion)), [
        ["unreadable", WF, 1],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid UTF-8 inside a run comment is unreadable, never decoded", () => {
    const line = "      - run: node x.mjs # caf";
    const bytes = (bad) =>
      Buffer.concat([
        Buffer.from(workflow(CHECKOUT + SETUP + line)),
        Buffer.from(bad ? [0xff] : [0x65]),
        Buffer.from("\n"),
      ]);
    for (const bad of [false, true]) {
      const dir = tree({ [WF]: bytes(bad), ".node-version": "24\n" });
      try {
        const { files, nodeVersion } = readCorpus(dir);
        const result = verdict(files, nodeVersion);
        if (bad) assert.deepEqual(shape(result), [["unreadable", WF, 1]]);
        else passes(result);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("YAML shapes the reader accepts", () => {
  test("indentless sequences", () => {
    passes(
      check(`name: ci
on: push
jobs:
  build:
    runs-on: x
    timeout-minutes: 10
    steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-node@v7.1.0
      with:
        node-version-file: .node-version
    - run: node x.mjs
`),
    );
  });

  test("one document between --- and ...; a second document is unreadable", () => {
    passes(check(`---\n${PASSING}...\n`));
    const source = `${PASSING}---\nname: other\n`;
    assert.deepEqual(shape(check(source)), [
      ["unreadable", WF, lineOf(source, "---")],
    ]);
  });

  test("multi-line plain and quoted scalars", () => {
    passes(
      check(
        workflow(`${CHECKOUT}${SETUP}      - name: "Run the
          script"
        if: github.event_name == 'push' &&
          github.ref == 'refs/heads/master'
        run: node x.mjs
`),
      ),
    );
  });

  test("block scalar indentation indicators", () => {
    for (const header of ["|2", "|-2", ">2", "|2+", ">-"]) {
      passes(
        check(
          workflow(
            `${CHECKOUT}${SETUP}      - run: ${header}\n            node x.mjs\n`,
          ),
        ),
      );
    }
  });

  test("block scalars keep YAML's chomping", () => {
    const valueOf = (source) =>
      parseWorkflow(source, "f.yml").entries.get("k").value;
    for (const style of ["|", ">"]) {
      for (const [chomp, beforeKey, atEnd, unterminated, empty] of [
        ["-", "x", "x", "x", ""],
        ["", "x\n", "x\n", "x\n", ""],
        ["+", "x\n\n\n", "x\n", "x\n", "\n"],
      ]) {
        const h = style + chomp;
        assert.equal(valueOf(`k: ${h}\n  x\n\n\nz: 1\n`), beforeKey, h);
        assert.equal(valueOf(`k: ${h}\n  x\n`), atEnd, `${h} at the end`);
        assert.equal(
          valueOf(`k: ${h}\n  x`),
          unterminated,
          `${h} unterminated`,
        );
        assert.equal(valueOf(`k: ${h}\n\nz: 1\n`), empty, `${h} empty`);
      }
    }
    assert.equal(valueOf("k: >\n  a\n  b\n"), "a b\n");
  });

  test("a U+00A0 is content in plain, quoted, key and flow text; blanks and TABs trim", () => {
    const nbsp = String.fromCharCode(0xa0);
    const parsed = (source) => parseWorkflow(source, "f.yml").entries;
    const valueOf = (source) => parsed(source).get("k").value;
    assert.equal(valueOf(`k: a${nbsp} \t\n`), `a${nbsp}`);
    assert.equal(valueOf(`k: a${nbsp} # c\n`), `a${nbsp}`);
    assert.equal(valueOf(`k: ${nbsp}a\n`), `${nbsp}a`);
    assert.equal(valueOf(`k: "a${nbsp} \n  ${nbsp}b"\n`), `a${nbsp} ${nbsp}b`);
    assert.deepEqual([...parsed(`k${nbsp}: 1\n`).keys()], [`k${nbsp}`]);
    assert.throws(
      () => parseWorkflow(`k: [a]${nbsp}\n`, "f.yml"),
      /content after a flow collection/,
    );
    assert.equal(valueOf("k: a \t\n"), "a");
    assert.equal(valueOf('k: "a \t\n  \t b"\n'), "a b");
    assert.equal(valueOf("k: [a] \t\n"), "[a]");
    assert.deepEqual([...parsed("k \t: 1\n").keys()], ["k"]);
  });

  test("balanced flow values, quoted brackets and multi-line flow are opaque text", () => {
    passes(
      check(
        workflow(
          `${CHECKOUT}${SETUP}      - env: {A: 1, B: "x]}", C: 'it''s [a'}\n        run: node x.mjs\n`,
          {
            head: `${HEAD}    needs: [a, [b, c]] # trailing comment\n    if: contains(fromJSON('["a", "b"]'), github.ref)\n    strategy:\n      matrix:\n        shard: [1,\n          2]\n`,
          },
        ),
      ),
    );
  });

  test("a ' #' inside a quoted flow value is text, outside one a comment", () => {
    passes(
      check(
        workflow(
          `${CHECKOUT}${SETUP}      - env: {LABEL: "release #42"} # cut here\n        run: node x.mjs\n`,
          { head: `${HEAD}    needs: ['a #b', "c #d"]\n` },
        ),
      ),
    );
    const source = workflow(CHECKOUT + SETUP + NODE, {
      head: `${HEAD}    needs: [a #b]\n`,
    });
    assert.deepEqual(shape(check(source)), [
      ["unreadable", WF, lineOf(source, "needs: [a #b]")],
    ]);
  });

  test("a comment inside a multi-line flow collection ends only its line", () => {
    for (const needs of [
      "[build, # first\n      test]",
      "[build,\n      # why\n      test]",
    ]) {
      passes(
        check(
          workflow(CHECKOUT + SETUP + NODE, {
            head: `${HEAD}    needs: ${needs}\n`,
          }),
        ),
      );
    }
    const source = workflow(CHECKOUT + SETUP + NODE, {
      head: `${HEAD}    needs: [build, # first\n      test\n`,
    });
    assert.deepEqual(shape(check(source)), [
      ["unreadable", WF, lineOf(source, "needs: [build")],
    ]);
  });

  test("* and & mid-value are text", () => {
    const result = check(
      workflow(`${CHECKOUT}      - run: rm -rf *dist a&b\n`),
    );
    passes(result);
    assert.deepEqual(result.nodeJobs, []);
  });

  test("content after a dash keeps its real column", () => {
    passes(
      check(
        workflow(`      -   uses: actions/checkout@v7
      -   uses: actions/setup-node@v7.1.0
          with:
            node-version-file: .node-version
      -   run: node x.mjs
`),
      ),
    );
  });

  test("TABs inside block content past its indent", () => {
    passes(
      check(
        workflow(
          `${CHECKOUT}${SETUP}      - run: |\n          cat <<-EOF\n          \t\techo a\n          \tEOF\n`,
        ),
      ),
    );
  });

  test("anchors and aliases inside run text are text", () => {
    passes(
      check(
        workflow(
          `${CHECKOUT}      - run: |\n          echo &a *b\n          x <<: y\n`,
        ),
      ),
    );
  });

  test("a plain value's ' #' starts a comment even after a quote", () => {
    const result = check(
      workflow(`${CHECKOUT}      - run: echo 'a #b; node x'\n`),
    );
    passes(result);
    assert.deepEqual(result.nodeJobs, []);
  });

  test("matrix, aggregator, continue-on-error install and node-free jobs", () => {
    const source = `name: ci
on: push
jobs:
  matrix:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
    runs-on: \${{ matrix.platform }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - name: Install pnpm
        uses: pnpm/action-setup@v6.1.1
      - name: Install Node
        uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm test --shard=\${{ matrix.shard }}/2
  build:
    needs: [checks, vitest]
    if: always()
    runs-on: ubuntu-26.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
          sparse-checkout: scripts
      - name: Install Node
        uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .node-version
      - name: Require every frontend job to succeed
        env:
          NEEDS_JSON: \${{ toJSON(needs) }}
        run: node scripts/check-needs-success.mjs
  advisory:
    runs-on: ubuntu-26.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - name: Install pnpm
        continue-on-error: true
        uses: pnpm/action-setup@v6.1.1
      - name: Install Node
        continue-on-error: true
        uses: actions/setup-node@v7.1.0
        with:
          node-version-file: .node-version
          cache: pnpm
      - name: Install dependencies
        continue-on-error: true
        run: pnpm install --frozen-lockfile
  bump:
    if: \${{ !github.event.release.prerelease }}
    runs-on: ubuntu-26.04
    timeout-minutes: 5
    steps:
      - run: |
          curl -fsSL -o /tmp/x.dmg "$URL"
`;
    const result = check(source);
    passes(result);
    assert.deepEqual(result.nodeJobs, [
      `${WF}#advisory`,
      `${WF}#build`,
      `${WF}#matrix`,
    ]);
    assert.equal(result.timedJobs, 4);
  });
});

describe("job-timeout", () => {
  test("missing, out-of-range, quoted, float, expression or step-level bounds fail", () => {
    const heads = [
      "    runs-on: x\n",
      "    runs-on: x\n    timeout-minutes: 0\n",
      "    runs-on: x\n    timeout-minutes: 361\n",
      '    runs-on: x\n    timeout-minutes: "10"\n',
      "    runs-on: x\n    timeout-minutes: 10.5\n",
      "    runs-on: x\n    timeout-minutes: 010\n",
      "    runs-on: x\n    timeout-minutes: ${{ matrix.t }}\n",
      "    runs-on: x\n    Timeout-Minutes: 10\n",
    ];
    for (const head of heads) {
      assert.deepEqual(
        shape(check(workflow(CHECKOUT + SETUP + NODE, { head }))),
        [["job-timeout", WF, 4]],
        head,
      );
    }
    const stepOnly = workflow(
      `${CHECKOUT}${SETUP}      - run: node x.mjs\n        timeout-minutes: 10\n`,
      { head: "    runs-on: x\n" },
    );
    assert.deepEqual(shape(check(stepOnly)), [["job-timeout", WF, 4]]);
    assert.match(
      check(stepOnly).failures[0],
      /\(fix: add a job-level `timeout-minutes: <minutes>` beside runs-on, bounded from measured durations\)$/,
    );
  });

  test("1, 10 and 360 are bounds", () => {
    for (const minutes of ["1", "10", "360"]) {
      const result = check(
        workflow(CHECKOUT + SETUP + NODE, {
          head: `    runs-on: x\n    timeout-minutes: ${minutes}\n`,
        }),
      );
      passes(result);
      assert.equal(result.timedJobs, 1);
    }
  });

  test("a reusable-workflow caller job needs no bound and no steps", () => {
    const result = check(
      `${PASSING}  call:\n    uses: ./.github/workflows/reuse.yml\n`,
    );
    passes(result);
    assert.equal(result.timedJobs, 1);
  });

  test("a job with both uses and steps, or neither, is unreadable", () => {
    const both = workflow(CHECKOUT, {
      head: `${HEAD}    uses: ./.github/workflows/reuse.yml\n`,
    });
    assert.deepEqual(shape(check(both)), [["unreadable", WF, 4]]);
    const neither = `name: ci\non: push\njobs:\n  build:\n${HEAD}`;
    const result = check(neither);
    assert.deepEqual(shape(result), [["unreadable", WF, 4]]);
    assert.match(result.failures[0], /job build has no steps/);
  });
});

describe("composite and container jobs", () => {
  const nodeAction = action("    - shell: bash\n      run: node tool.mjs\n");
  const setupAction = action(
    "    - uses: actions/setup-node@v7.1.0\n      with:\n        node-version-file: .node-version\n    - shell: bash\n      run: node tool.mjs\n",
  );
  const call = "      - uses: ./.github/actions/tool\n";

  test("composite-node at an action that runs node without its own setup", () => {
    const files = {
      [WF]: workflow(CHECKOUT + SETUP + call),
      [ACTION]: nodeAction,
    };
    assert.deepEqual(shape(check(files)), [
      ["composite-node", ACTION, lineOf(nodeAction, "- shell: bash")],
    ]);
    passes(
      check(files, {
        exempt: new Map([[ACTION, "runs on the caller's Node"]]),
      }),
    );
  });

  test("the caller of such an action still needs its own setup-node", () => {
    const source = workflow(CHECKOUT + call);
    const result = check(
      { [WF]: source, [ACTION]: nodeAction },
      { exempt: new Map([[ACTION, "runs on the caller's Node"]]) },
    );
    assert.deepEqual(shape(result), [
      ["setup-node-missing", WF, lineOf(source, "./.github/actions/tool")],
    ]);
  });

  test("an action that sets Node up counts as setup for later steps", () => {
    const files = {
      [WF]: workflow(CHECKOUT + call + NODE),
      [ACTION]: setupAction,
    };
    passes(check(files));
    const conditional = workflow(
      `${CHECKOUT}${call}        if: always()\n${NODE}`,
    );
    assert.deepEqual(
      shape(check({ [WF]: conditional, [ACTION]: setupAction })).map(
        ([rule]) => rule,
      ),
      ["setup-node-missing"],
    );
  });

  test("a JavaScript or Docker local action is skipped", () => {
    for (const runs of [
      "  using: node20\n  main: index.js\n",
      "  using: docker\n  image: Dockerfile\n",
    ]) {
      const result = check({
        [WF]: workflow(CHECKOUT + call),
        [ACTION]: `name: tool\nruns:\n${runs}`,
      });
      passes(result);
      assert.deepEqual(result.nodeJobs, []);
    }
  });

  test("a local action outside the corpus or spelled with backslashes is unreadable", () => {
    for (const target of [
      "./.github/actions/missing",
      "./tools/action",
      ".\\.github\\actions\\tool",
    ]) {
      const source = workflow(`${CHECKOUT}      - uses: ${target}\n`);
      assert.deepEqual(shape(check(source)), [
        ["unreadable", WF, lineOf(source, target)],
      ]);
    }
  });

  test("container-node, waived only by an exemption", () => {
    const head = `${HEAD}    container: node:24\n`;
    const source = workflow(CHECKOUT + NODE, { head });
    assert.deepEqual(shape(check(source)), [
      ["container-node", WF, lineOf(source, "- run: node")],
    ]);
    passes(check(source, { exempt: new Map([[SITE, "the image pins Node"]]) }));
    passes(check(workflow(CHECKOUT + SETUP + NODE, { head })));
    const unbounded = workflow(CHECKOUT + NODE, {
      head: "    runs-on: x\n    container: node:24\n",
    });
    assert.deepEqual(
      shape(
        check(unbounded, { exempt: new Map([[SITE, "the image pins Node"]]) }),
      ),
      [["job-timeout", WF, 4]],
    );
  });

  test("an exemption never waives a setup-node mistake", () => {
    const source = workflow(CHECKOUT + SETUP.replace("@v7.1.0", "") + NODE, {
      head: `${HEAD}    container: node:24\n`,
    });
    assert.deepEqual(
      shape(
        check(source, { exempt: new Map([[SITE, "the image pins Node"]]) }),
      ).map(([rule]) => rule),
      ["setup-node-form"],
    );
  });

  test("exempt-stale and exempt-reason", () => {
    assert.deepEqual(
      shape(check(PASSING, { exempt: new Map([[SITE, "why"]]) })),
      [["exempt-stale", WF, 1]],
    );
    const source = workflow(CHECKOUT + NODE, {
      head: `${HEAD}    container: node:24\n`,
    });
    assert.deepEqual(
      shape(check(source, { exempt: new Map([[SITE, "  "]]) })),
      [["exempt-reason", WF, 1]],
    );
  });

  test("an exemption keeps a later node step that runs past a fail-open setup", () => {
    const failOpen =
      "      - id: node\n        continue-on-error: true\n        uses: actions/setup-node@v7.1.0\n        with:\n          node-version-file: .node-version\n";
    const source = workflow(
      `${CHECKOUT}${NODE}${failOpen}      - name: Later\n        run: node later.mjs\n`,
      { head: `${HEAD}    container: node:24\n` },
    );
    const exempt = new Map([[SITE, "the image pins Node"]]);
    assert.deepEqual(shape(check(source, { exempt })), [
      ["setup-node-missing", WF, lineOf(source, "- name: Later")],
    ]);
    assert.deepEqual(
      shape(check(source)).map(([rule]) => rule),
      ["container-node", "setup-node-missing"],
    );
  });
});

describe("corpus and unreadable input", () => {
  test("node-version-file: missing, two lines or not a version", () => {
    for (const nodeVersion of [
      new Error("ENOENT"),
      "24\n25\n",
      "lts/*\n",
      "",
    ]) {
      assert.deepEqual(shape(check(PASSING, { nodeVersion })), [
        ["node-version-file", ".node-version", 1],
      ]);
    }
    for (const nodeVersion of ["24", "v24.1.0\n", "24.18.1\r\n"]) {
      passes(check(PASSING, { nodeVersion }));
    }
  });

  test("empty-corpus when no workflow file exists", () => {
    const result = check({
      [ACTION]: action("    - shell: bash\n      run: echo hi\n"),
    });
    assert.deepEqual(shape(result), [["empty-corpus", ".github/workflows", 1]]);
  });

  test("structures outside the subset are unreadable at their line", () => {
    const cases = {
      "duplicate key": [
        PASSING.replace(HEAD, `${HEAD}    runs-on: y\n`),
        "runs-on: y",
      ],
      anchor: [
        workflow(`      - uses: &co actions/checkout@v7\n${SETUP}${NODE}`),
        "&co",
      ],
      alias: [workflow(`${CHECKOUT}${SETUP}      - run: *cmd\n`), "*cmd"],
      "merge key": [PASSING.replace(HEAD, `${HEAD}    <<: x\n`), "<<: x"],
      tag: [
        workflow(`${CHECKOUT}${SETUP}      - run: !!str node x\n`),
        "!!str",
      ],
      "flow steps": [
        workflow("", { head: `${HEAD}    steps: [{ run: node x }]\n` }).replace(
          "    steps:\n",
          "",
        ),
        "steps: [",
      ],
      "flow with": [
        workflow(
          `${CHECKOUT}      - uses: actions/setup-node@v7.1.0\n        with: { node-version-file: .node-version }\n${NODE}`,
        ),
        "with: {",
      ],
      "TAB indentation": [
        PASSING.replace("    timeout-minutes", "\ttimeout-minutes"),
        "timeout-minutes",
      ],
      "': ' in a plain value": [
        workflow(`${CHECKOUT}      - run: echo a: b\n`),
        "echo a: b",
      ],
      directive: [`%YAML 1.2\n---\n${PASSING}`, "%YAML"],
      "unterminated quote": [
        workflow(`${CHECKOUT}      - run: "node x\n`),
        'run: "node',
      ],
      "uses and run": [
        workflow("      - uses: actions/checkout@v7\n        run: node x\n"),
        "- uses",
      ],
      "sequence jobs": ["name: ci\non: push\njobs:\n  - build\n", "jobs:"],
      "unterminated flow sequence": [
        workflow(CHECKOUT + SETUP + NODE, {
          head: `${HEAD}    needs: [main\n`,
        }),
        "needs: [main",
      ],
      "unterminated flow mapping": [
        workflow(
          `${CHECKOUT}${SETUP}      - env: {a: 1\n        run: node x.mjs\n`,
        ),
        "env: {a",
      ],
      "unterminated quote in a flow value": [
        workflow(CHECKOUT + SETUP + NODE, {
          head: `${HEAD}    needs: ['main]\n`,
        }),
        "needs: [",
      ],
      "mismatched flow brackets": [
        workflow(CHECKOUT + SETUP + NODE, { head: `${HEAD}    needs: [a}\n` }),
        "needs: [",
      ],
      "content after a flow collection": [
        workflow(CHECKOUT + SETUP + NODE, {
          head: `${HEAD}    needs: [a] b\n`,
        }),
        "needs: [",
      ],
    };
    for (const [label, [source, needle]] of Object.entries(cases)) {
      const result = check(source);
      assert.deepEqual(
        shape(result),
        [["unreadable", WF, lineOf(source, needle)]],
        label,
      );
      if (label.startsWith("flow"))
        assert.match(result.failures[0], /flow-style/);
      else assert.doesNotMatch(result.failures[0], /flow-style/, label);
    }
  });

  test("a read error or a non-workflow path is unreadable", () => {
    assert.deepEqual(shape(check({ [WF]: new Error("EACCES") })), [
      ["unreadable", WF, 1],
    ]);
    assert.deepEqual(
      shape(check({ [WF]: PASSING, ".github/other.yml": PASSING })),
      [["unreadable", ".github/other.yml", 1]],
    );
  });

  test("parseWorkflow throws on unsupported input and returns a node tree", () => {
    assert.throws(() => parseWorkflow("a: &x 1\n", "f.yml"), /anchors/);
    assert.throws(() => parseWorkflow(42, "f.yml"), /not text/);
    const doc = parseWorkflow(PASSING, WF);
    assert.equal(doc.kind, "map");
    assert.equal(doc.entries.get("jobs").entries.get("build").kind, "map");
  });

  test("readCorpus decodes, keeps a byte-order mark for the parser to strip, and finds actions", () => {
    const dir = tree({
      [WF]: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          workflow(
            `${CHECKOUT}${SETUP}      - uses: ./.github/actions/tool\n`,
          ).replace(/\n/g, "\r\n"),
        ),
      ]),
      [ACTION]: action("    - shell: bash\n      run: echo hi\n"),
      ".github/actions/tool/README.md": "not an action\n",
      ".node-version": "24\n",
    });
    try {
      const corpus = readCorpus(dir);
      assert.deepEqual([...corpus.files.keys()], [ACTION, WF]);
      passes(verdict(corpus.files, corpus.nodeVersion));
      const failing = readCorpus(dir, (path) => {
        if (path.endsWith("ci.yml"))
          throw new Error("EACCES: permission denied");
        return readFileSync(path);
      });
      assert.deepEqual(shape(verdict(failing.files, failing.nodeVersion)), [
        ["unreadable", WF, 1],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A key regex whose blank run two quantifiers share would stall the guards job.
  test("a long blank run in a plain scalar stays linear", () => {
    const source = `a${" ".repeat(100000)}b`;
    const { result, elapsed } = timed(() => parseWorkflow(source, "f.yml"));
    assert.equal(result.kind, "scalar");
    assert.equal(result.value, source);
    assert.ok(elapsed < LINEAR_BUDGET_MS, `${elapsed} ms`);
  });

  // Re-trimming the whole value at each line break would stall the guards job.
  test("a long blank run before a quoted line break stays linear", () => {
    const blanks = " ".repeat(100000);
    const { result, elapsed } = timed(() =>
      parseWorkflow(`k: "a${blanks}b\n  c"\n`, "f.yml"),
    );
    assert.equal(result.entries.get("k").value, `a${blanks}b c`);
    assert.ok(elapsed < LINEAR_BUDGET_MS, `${elapsed} ms`);
  });

  // A blank trim retried at every blank of a run it can't strip would stall it.
  test("a long blank run before a closing U+00A0 stays linear", () => {
    const nbsp = String.fromCharCode(0xa0);
    const blanks = " ".repeat(100000);
    const { result, elapsed } = timed(() =>
      parseWorkflow(`k${blanks}${nbsp}: a${blanks}${nbsp}\n`, "f.yml"),
    );
    assert.equal(
      result.entries.get(`k${blanks}${nbsp}`).value,
      `a${blanks}${nbsp}`,
    );
    assert.ok(elapsed < LINEAR_BUDGET_MS, `${elapsed} ms`);
  });

  // Re-scanning the value per continuation line would stall the guards job.
  test("a quoted value over many lines stays linear", () => {
    const { result, elapsed } = timed(() =>
      parseWorkflow(`k: "a\n${"  b\n".repeat(60000)}  c"\n`, "f.yml"),
    );
    assert.equal(result.entries.get("k").value, `a${" b".repeat(60000)} c`);
    assert.ok(elapsed < MANY_LINES_BUDGET_MS, `${elapsed} ms`);
  });

  // A trailing-slash trim retried at every slash would stall the guards job.
  test("a long slash run in a local action path stays linear", () => {
    const source = workflow(
      `${CHECKOUT}      - uses: ./.github/actions/x${"/".repeat(100000)}y\n`,
    );
    const { result, elapsed } = timed(() => check(source));
    assert.deepEqual(shape(result), [
      ["unreadable", WF, lineOf(source, "- uses: ./.github/actions/x")],
    ]);
    assert.ok(elapsed < LINEAR_BUDGET_MS, `${elapsed} ms`);
  });

  test("readCorpus throws when the workflows directory is missing", () => {
    const dir = tree({ ".node-version": "24\n" });
    try {
      assert.throws(() => readCorpus(dir), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI", () => {
  // An allowlisted environment, so nothing of the caller's (a CI GITHUB_OUTPUT
  // among it) reaches the child.
  const childEnv = (root) => {
    const env = { GD_WORKFLOW_NODE_ROOT: root };
    for (const key of [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
  };
  const run = (root, script = SCRIPT) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: childEnv(root),
    });

  // The link targets a copy inside the temp tree, so removing the tree can
  // never reach the repository's scripts.
  test("the script runs when reached through a linked directory", () => {
    const dir = tree({
      [WF]: workflow(CHECKOUT + NODE),
      ".node-version": "24\n",
      [`real/${basename(SCRIPT)}`]: readFileSync(SCRIPT),
    });
    try {
      const link = join(dir, "linked");
      symlinkSync(join(dir, "real"), link, "junction");
      const result = run(dir, join(link, basename(SCRIPT)));
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /setup-node-missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a passing tree exits 0 with the OK line", () => {
    const dir = tree({ [WF]: PASSING, ".node-version": "24\n" });
    try {
      const result = run(dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        "workflow-node-setup: OK 1 jobs run node, each after setup-node from .node-version; 1 jobs carry timeout-minutes (1 files)\n",
      );
      assert.equal(result.stderr, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing tree exits 1 with FAIL lines on stderr", () => {
    const dir = tree({
      [WF]: workflow(CHECKOUT + NODE),
      ".node-version": "24\n",
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /^workflow-node-setup: FAIL \.github\/workflows\/ci\.yml:9: setup-node-missing: /,
      );
      assert.equal(result.stdout, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing root exits 1", () => {
    const dir = tree({});
    rmSync(dir, { recursive: true, force: true });
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^workflow-node-setup: FAIL \.github\/workflows:1: unreadable: /,
    );
  });
});

describe("real tree", () => {
  const SITES = [
    "appimage-check.yml#appimage",
    "changelog.yml#fragment",
    "frontend.yml#build",
    "frontend.yml#checks",
    "frontend.yml#vitest",
    "quality.yml#advisory",
    "quality.yml#guards",
    "release.yml#notes",
    "release.yml#release",
    "rust-tests.yml#gate",
    "site.yml#build",
  ].map((site) => `.github/workflows/${site}`);

  test("real tree: every job is bounded and every node job sets Node up", () => {
    const { files, nodeVersion } = readCorpus(ROOT);
    const result = verdict(files, nodeVersion);
    assert.deepEqual(result.failures, []);
    assert.ok(result.files >= 1);
    assert.equal(result.files, files.size);
    for (const site of SITES) assert.ok(result.nodeJobs.includes(site), site);
  });

  test("real tree: frontend build without its setup-node fails", () => {
    const { files, nodeVersion } = readCorpus(ROOT);
    const file = ".github/workflows/frontend.yml";
    const before = files.get(file);
    const start = before.indexOf("\n  build:\n");
    assert.ok(start >= 0);
    const after =
      before.slice(0, start) +
      before
        .slice(start)
        .replace(
          /\n {6}- (?:[^\n]*\n(?: {8}(?!uses:)[^\n]*\n)* {8})?uses: actions\/setup-node@[^\n]*\n(?: {8,}[^\n]*\n)*/,
          "\n",
        );
    assert.notEqual(after, before);
    files.set(file, after);
    assert.deepEqual(
      shape(verdict(files, nodeVersion)).map(([rule, path]) => [rule, path]),
      [["setup-node-missing", file]],
    );
  });

  test("real tree: release notes without its bound fails at the job key", () => {
    const { files, nodeVersion } = readCorpus(ROOT);
    const file = ".github/workflows/release.yml";
    const before = files.get(file);
    const start = before.indexOf("\n  notes:\n");
    const end = before.indexOf("\n  release:\n");
    assert.ok(start >= 0 && end > start);
    const after =
      before.slice(0, start) +
      before.slice(start, end).replace(/\n {4}timeout-minutes:[^\n]*\n/, "\n") +
      before.slice(end);
    assert.notEqual(after, before);
    files.set(file, after);
    assert.deepEqual(shape(verdict(files, nodeVersion)), [
      ["job-timeout", file, lineOf(after, "  notes:")],
    ]);
  });
});
