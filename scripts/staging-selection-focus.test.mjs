// Pins the Changes diff's selection-bar focus rescue
// (src/features/diff/DiffViewer.tsx), read from source. Stage, Unstage and
// Discard on a line selection (the bar's buttons, the untracked discard-lines
// path, and the stage-selected-lines hotkey) and Clear (button and hotkey) all
// unmount the bar's buttons; each route arms one record, apart from the hunk
// landing's ref, that a dependency-free layout effect lands on the pane's sink
// through landHunkFocus once the write settled (a Clear at its press) and the
// selection is gone. The rescue never scrolls and never writes the hunk refs.
//
// Not testable here: where focus ends up after Base UI's close-time return,
// and the commit order of the settle. Those need the live app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeRe, maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIEWER = "src/features/diff/DiffViewer.tsx";
// LF-normalized, so multi-line control anchors read the same on any checkout.
const read = (file) =>
  readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
// Whitespace and trailing commas removed: formatting never moves a pin.
const flat = (s) => s.replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");

/** The function declared by `header` (a `function name(` text) in [from, to):
 *  its span through the body's closing brace, or null. */
function fnSpan(masked, header, from, to) {
  const at = masked.indexOf(header, from);
  if (at < 0 || at >= to) return null;
  const re = /\)(?:\s*:\s*[\w |]+)?\s*\{/g;
  re.lastIndex = at + header.length;
  const m = re.exec(masked);
  if (m === null) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(masked, open);
  return close < 0 ? null : { start: at, end: close + 1 };
}

/** Every call of `callee` (not its declaration) in [from, to): span, code
 *  (masked) and text (raw), both flattened. */
function calls(src, callee, from, to) {
  const re = new RegExp(`(?<![\\w$])${escapeRe(callee)}\\(`, "g");
  re.lastIndex = from;
  const out = [];
  for (let m = re.exec(src.masked); m !== null && m.index < to; ) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src.masked, open);
    if (close < 0) throw new Error(`unclosed ${callee}( at ${m.index}`);
    if (
      !/function\s+$/.test(src.masked.slice(Math.max(0, m.index - 12), m.index))
    )
      out.push({
        start: m.index,
        end: close + 1,
        code: flat(src.masked.slice(m.index, close + 1)),
        text: flat(src.raw.slice(m.index, close + 1)),
      });
    m = re.exec(src.masked);
  }
  return out;
}

/** The flattened body of `const name = (…) => {…}` in [from, to), or null. */
function arrowBody(masked, name, from, to) {
  const at = masked.indexOf(`const ${name} = (`, from);
  if (at < 0 || at >= to) return null;
  const open = masked.indexOf("=> {", at) + 3;
  const close = matchBrace(masked, open);
  return close < 0 ? null : flat(masked.slice(open, close + 1));
}

export function selectionFocusViolations(raw) {
  const src = { raw, masked: maskNonCode(raw, true) };
  const { masked } = src;
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };
  const pane = fnSpan(masked, "function WorkingTreeDiff(", 0, masked.length);
  if (pane === null) return ["WorkingTreeDiff not found"];
  const paneCode = flat(masked.slice(pane.start, pane.end));
  const inPane = (header) => fnSpan(masked, header, pane.start, pane.end);

  // (b) A record of its own, press-shaped, with no takeover latch: the rescue
  // never scrolls.
  const press = /type SelectionPress = HunkFocus & \{[^}]*\};/.exec(masked);
  const focusType = /type SelectionFocus = SelectionPress & \{[^}]*\};/.exec(
    masked,
  );
  need(
    press !== null &&
      flat(press[0]) ===
        "typeSelectionPress=HunkFocus&{repoPath:string;path:string;staged:boolean;};",
    "SelectionPress is HunkFocus plus the identity stamp",
  );
  need(
    focusType !== null &&
      flat(focusType[0]) ===
        "typeSelectionFocus=SelectionPress&{settled:boolean};",
    "SelectionFocus is a press plus settled, and nothing else",
  );
  need(
    paneCode.includes(
      "constselectionFocusRef=useRef<SelectionFocus|null>(null);",
    ),
    "the rescue has its own ref, typed with no tookOver",
  );

  // (a) A selection write still hands runWrite no hunk focus.
  const applySel = inPane("function applySelection(");
  const selWrites =
    applySel === null
      ? []
      : calls(src, "runWrite", applySel.start, applySel.end);
  need(
    selWrites.length === 1 &&
      selWrites[0].code ===
        "runWrite(()=>applyPartial.mutateAsync({diffText,selected,...opts}),null,writeKind(opts),rescue)",
    "applySelection passes a null focus and its rescue to runWrite",
  );
  const discard = inPane("function discardLines(");
  const discardWrites =
    discard === null ? [] : calls(src, "runWrite", discard.start, discard.end);
  need(
    discardWrites.length === 1 &&
      discardWrites[0].text.endsWith(',focus,"discard",rescue)'),
    "discardLines threads its rescue as runWrite's last argument",
  );

  // (c) runWrite arms after its refusal gates and the hunk trio, unsettled;
  // success flips settled before the clear, and an error compare-and-clears.
  const run = inPane("async function runWrite(");
  if (run === null) problems.push("runWrite not found");
  else {
    const body = flat(masked.slice(run.start, run.end));
    const at = (s) => body.indexOf(s);
    const armAt = at(
      "constarmed=rescue===null?null:{...rescue,settled:false};selectionFocusRef.current=armed;",
    );
    need(
      armAt >= 0,
      "runWrite arms the rescue unsettled, every accepted write",
    );
    need(
      at("writingRef.current=true;") >= 0 &&
        at("writingRef.current=true;") < armAt &&
        at("scrollCycleRef.current=pending;") >= 0 &&
        at("scrollCycleRef.current=pending;") < armAt,
      "runWrite arms after writingRef.current = true and the hunk trio",
    );
    need(
      arrowBody(masked, "succeeded", run.start, run.end) ===
        "{if(armed!==null&&selectionFocusRef.current===armed)armed.settled=true;clearSelection();}",
      "the success wrapper flips settled on its own record, before clearSelection",
    );
    need(
      arrowBody(masked, "failed", run.start, run.end) ===
        "{if(armed!==null&&selectionFocusRef.current===armed)selectionFocusRef.current=null;onError(e);}",
      "the error path compare-and-clears the rescue",
    );
    need(
      body.includes("awaitsettleWrite(mutate,succeeded,failed,"),
      "settleWrite runs the wrappers",
    );
  }

  // (d) The seven arm sites: five writes, two Clears.
  const sel = inPane("function selectionPress(");
  need(
    sel !== null &&
      flat(masked.slice(sel.start, sel.end)).includes(
        "return{index:0,button,hadFocus:document.activeElement===button,viaConfirm,repoPath,path:file.path,staged:file.staged};",
      ),
    "selectionPress records the press and stamps the pane's identity",
  );
  const hot = inPane("function hotkeyPress(");
  need(
    hot !== null &&
      flat(masked.slice(hot.start, hot.end)).endsWith(
        "{constactive=document.activeElement;if(!(activeinstanceofHTMLElement))returnnull;constbar=controlsRef.current;constonBar=active!==bar&&bar?.contains(active)===true;constonHunk=forWrite&&hunkControlOf(active)!==null&&scrollPaneRef.current?.contains(active)===true;returnonBar||onHunk?selectionPress(active,false):null;}",
      ),
    "a hotkey arms only from a bar control (never the bar's span) or, writing, a hunk button",
  );
  const writeArms = calls(src, "applySelection", pane.start, pane.end)
    .map((c) => c.text)
    .sort();
  need(
    JSON.stringify(writeArms) ===
      JSON.stringify(
        [
          "applySelection({cached:true,reverse:file.staged},hotkeyPress(true))",
          "applySelection({cached:true,reverse:true},selectionPress(e.currentTarget,false))",
          "applySelection({cached:true,reverse:false},selectionPress(e.currentTarget,false))",
          "applySelection({cached:false,reverse:true},press)",
        ].sort(),
      ),
    "the stage hotkey, Unstage, Stage and tracked Discard each arm",
  );
  const barDiscards = calls(src, "discardLines", pane.start, pane.end).filter(
    (c) => c.text.startsWith("discardLines(lines"),
  );
  need(
    barDiscards.length === 1 && barDiscards[0].text.endsWith(",null,press)"),
    "the untracked Discard arms",
  );
  const confirm = calls(src, "setDiscard", pane.start, pane.end).find((c) =>
    c.text.includes("discardLines(lines"),
  );
  // The press is recorded first; only the lines read at the same press (with
  // their comment) may sit between it and the confirm.
  const pressAt =
    confirm === undefined
      ? -1
      : raw.lastIndexOf(
          "const press = selectionPress(e.currentTarget, true);",
          confirm.start,
        );
  need(
    confirm !== undefined &&
      pressAt > confirm.start - 600 &&
      /^constpress=selectionPress\(e\.currentTarget,true\);(?:\/\/.*?)?constlines=untracked\?untrackedDiscardLines\([^;]*\):null;$/.test(
        flat(raw.slice(pressAt, confirm.start)),
      ),
    "the bar's Discard records its press, through the confirm, at open",
  );
  const hotkeys = calls(src, "useHotkeyAction", pane.start, pane.end);
  const hotkey = (id) =>
    hotkeys.find((c) => c.text.startsWith(`useHotkeyAction("${id}",`));
  need(
    hotkey("stage-selected-lines")?.text.includes(
      "()=>applySelection({cached:true,reverse:file.staged},hotkeyPress(true))",
    ) === true,
    "the stage-selected-lines hotkey arms through its focus gate",
  );
  need(
    hotkey("clear-line-selection")?.code.includes(
      "()=>{constpress=hotkeyPress(false);selectionFocusRef.current=press===null?null:{...press,settled:true};clearSelection();}",
    ) === true,
    "the clear-line-selection hotkey arms settled, from the bar only",
  );
  need(
    paneCode.includes(
      "onClick={(e)=>{selectionFocusRef.current={...selectionPress(e.currentTarget,false),settled:true};clearSelection();}}",
    ),
    "the Clear button arms settled",
  );

  // (e) A pointer press drops the rescue, and so does the effect's cleanup.
  need(
    arrowBody(masked, "drop", pane.start, pane.end) ===
      "{hunkFocusRef.current=null;selectionFocusRef.current=null;}",
    "the pointerdown drop clears the rescue",
  );
  need(
    paneCode.includes(
      'document.removeEventListener("",latchFocus,true);selectionFocusRef.current=null;};},[]);',
    ),
    "the listener effect's cleanup clears the rescue",
  );

  // (f) The fire point: every commit, gated, landing through landHunkFocus.
  const fires = calls(src, "useLayoutEffect", pane.start, pane.end).filter(
    (c) => c.code.includes("constrescue=selectionFocusRef.current;"),
  );
  if (fires.length !== 1) {
    problems.push("the rescue's layout effect is not found once");
    return problems;
  }
  const fire = fires[0];
  need(
    /^useLayoutEffect\(\(\)=>\{.*\}\)$/.test(fire.code),
    "the rescue effect takes no dependency array",
  );
  need(
    fire.code.includes(
      "if(!interactive||rescue.repoPath!==repoPath||rescue.path!==file.path||rescue.staged!==file.staged){selectionFocusRef.current=null;return;}",
    ),
    "a held slot or another pane drops the rescue",
  );
  need(
    fire.code.includes(
      "if(!rescue.settled||selection!==null||confirmClosing)return;selectionFocusRef.current=null;constland=()=>landHunkFocus(rescue,focusSink.current);",
    ),
    "the rescue waits for settled, no selection and a closed confirm, then consumes and lands on the sink",
  );
  need(
    fire.code.endsWith(
      "if(!rescue.viaConfirm)land();elserequestAnimationFrame(land);})",
    ),
    "a confirm's rescue lands a frame later",
  );
  need(
    !/scrollIntoView|\.focus\(|hunkFocusRef|scrollCycleRef/.test(fire.code),
    "the rescue never scrolls, focuses directly, or writes the hunk refs",
  );
  const early = masked.indexOf("if (shownView === null) {", pane.start);
  need(
    early >= 0 && fire.end < early,
    "the rescue effect is declared above the fallback's early return",
  );
  return problems;
}

test("selection focus: the bar's routes rescue focus to the pane sink", () => {
  const raw = read(VIEWER);
  assert.deepEqual(selectionFocusViolations(raw), []);
  // Negative controls: each regression is caught by the pin named beside it.
  const DROP = "the pointerdown drop clears the rescue";
  const CLEANUP = "the listener effect's cleanup clears the rescue";
  const GATES =
    "the rescue waits for settled, no selection and a closed confirm, then consumes and lands on the sink";
  const HELD = "a held slot or another pane drops the rescue";
  const FRAME = "a confirm's rescue lands a frame later";
  const NO_DEPS = "the rescue effect takes no dependency array";
  const NO_SCROLL =
    "the rescue never scrolls, focuses directly, or writes the hunk refs";
  const ROUTES =
    "the stage hotkey, Unstage, Stage and tracked Discard each arm";
  const FOCUS_GATE =
    "a hotkey arms only from a bar control (never the bar's span) or, writing, a hunk button";
  const CLEAR_KEY =
    "the clear-line-selection hotkey arms settled, from the bar only";
  const CLEAR_BUTTON = "the Clear button arms settled";
  const NULL_FOCUS =
    "applySelection passes a null focus and its rescue to runWrite";
  const FLIP =
    "the success wrapper flips settled on its own record, before clearSelection";
  const ERROR = "the error path compare-and-clears the rescue";
  const ARMS = "runWrite arms the rescue unsettled, every accepted write";
  const AFTER_GATES =
    "runWrite arms after writingRef.current = true and the hunk trio";
  const CONFIRM =
    "the bar's Discard records its press, through the confirm, at open";
  const UNTRACKED = "the untracked Discard arms";
  const NO_LATCH = "SelectionFocus is a press plus settled, and nothing else";
  const caught = (mutated, pin, what) => {
    const got = selectionFocusViolations(mutated);
    assert.ok(got.includes(pin), `control not caught by "${pin}": ${what}`);
  };
  const mutate = (from, to, pin) => {
    assert.equal(raw.split(from).length, 2, `one control anchor: ${from}`);
    caught(
      raw.replace(from, () => to),
      pin,
      from,
    );
  };
  const controls = [
    [
      "hunkFocusRef.current = null;\n      selectionFocusRef.current = null;\n    };",
      "hunkFocusRef.current = null;\n    };",
      DROP,
    ],
    [
      "latchFocus, true);\n      // An <Activity> re-show replays this effect: a stale rescue must not fire.\n      selectionFocusRef.current = null;",
      "latchFocus, true);",
      CLEANUP,
    ],
    // Landing past landHunkFocus's rule, or scrolling.
    [
      "const land = () => landHunkFocus(rescue, focusSink.current);",
      "const land = () => focusSink.current?.focus();",
      NO_SCROLL,
    ],
    [
      "const land = () => landHunkFocus(rescue, focusSink.current);",
      "const land = () => landHunkFocus(rescue, focusSink.current) && focusSink.current?.scrollIntoView();",
      NO_SCROLL,
    ],
    // The fire gates.
    ["selection !== null || confirmClosing)", "selection !== null)", GATES],
    ["if (!rescue.settled || ", "if (", GATES],
    [
      "      !interactive ||\n      rescue.repoPath",
      "      rescue.repoPath",
      HELD,
    ],
    ["if (!rescue.viaConfirm) land();", "land();", FRAME],
    [
      "else requestAnimationFrame(land);\n  });",
      "else requestAnimationFrame(land);\n  }, [selection]);",
      NO_DEPS,
    ],
    // The write hotkey arms whatever holds focus; the Clear hotkey takes hunks.
    [
      "hotkeyPress(true)",
      "selectionPress(document.activeElement as HTMLElement, false)",
      ROUTES,
    ],
    ["return onBar || onHunk ?", "return true ?", FOCUS_GATE],
    ["const onBar = active !== bar && ", "const onBar = ", FOCUS_GATE],
    ["hotkeyPress(false)", "hotkeyPress(true)", CLEAR_KEY],
    // The Clear button arms nothing, or arms unsettled.
    [
      "                  selectionFocusRef.current = {\n                    ...selectionPress(e.currentTarget, false),\n                    settled: true,\n                  };\n",
      "",
      CLEAR_BUTTON,
    ],
    [
      "...selectionPress(e.currentTarget, false),\n                    settled: true,",
      "...selectionPress(e.currentTarget, false),\n                    settled: false,",
      CLEAR_BUTTON,
    ],
    // The record rides runWrite's focus param into the hunk landing.
    [
      "      null,\n      writeKind(opts),\n      rescue,",
      "      rescue,\n      writeKind(opts),\n      rescue,",
      NULL_FOCUS,
    ],
    // The flip after the clear; the error path leaves the rescue armed.
    [
      "        armed.settled = true;\n      clearSelection();",
      "        clearSelection();\n      armed.settled = true;",
      FLIP,
    ],
    [
      "        selectionFocusRef.current = null;\n      onError(e);",
      "        onError(e);",
      ERROR,
    ],
    ["{ ...rescue, settled: false }", "{ ...rescue, settled: true }", ARMS],
    // The Discard routes skip the confirm's frame, or stop arming.
    [
      "const press = selectionPress(e.currentTarget, true);",
      "const press = selectionPress(e.currentTarget, false);",
      CONFIRM,
    ],
    [
      "discardLines(lines, null, press)",
      "discardLines(lines, null)",
      UNTRACKED,
    ],
    ["settled: boolean };", "settled: boolean; tookOver: boolean };", NO_LATCH],
  ];
  for (const [from, to, pin] of controls) mutate(from, to, pin);
  // A renamed trio anchor fails closed rather than passing as index -1.
  mutate(
    "scrollCycleRef.current = pending;",
    "scrollCycleRef.current = pending ?? null;",
    AFTER_GATES,
  );
  // Armed before the refusal gates, where a refused press would arm.
  const ARM =
    "    const armed = rescue === null ? null : { ...rescue, settled: false };\n    selectionFocusRef.current = armed;\n";
  const GATE =
    "    if (writingRef.current) return;\n    // A diff gone from the cache";
  assert.equal(raw.split(ARM).length, 2, "one arm anchor");
  assert.equal(raw.split(GATE).length, 2, "one gate anchor");
  caught(
    raw.replace(ARM, () => "").replace(GATE, () => ARM + GATE),
    AFTER_GATES,
    "arm before the refusal gates",
  );
  // The fix reverted wholesale: no record anywhere.
  assert.notDeepEqual(
    selectionFocusViolations(raw.replaceAll("selectionFocusRef", "unusedRef")),
    [],
  );
});
