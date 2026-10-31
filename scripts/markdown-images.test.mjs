// Pins the rendered-markdown image guards (src/components/markdown/
// markdown-images.ts): which URLs the neutralize hook takes off the webview,
// which ones resolve to a repository read, which bytes may become a data: URL
// (SVG only when the bytes prove it), the read queue's cap and cancellation, and
// that neither the module nor markdown.tsx reaches an HTML-string-to-DOM sink.
// Stdlib only, importing the import-free module straight from src under Node's
// type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  captionName,
  createImageBudget,
  decodedByteLength,
  IMAGE_CAPTION_REASON,
  isRepoRelativeImageUrl,
  isSvgDocument,
  parseSrcset,
  renderableImageMime,
  repoDocBaseDir,
  resolveRepoImagePath,
  runCapped,
  serializeSrcset,
} from "../src/components/markdown/markdown-images.ts";
import { maskNonCode } from "./lib/ts-mask.mjs";

// Control characters and backslashes are built, not escaped, so no editor or
// tool can turn an escape sequence into the raw character in this file.
const TAB = String.fromCharCode(9);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(92);
const BOM = String.fromCharCode(0xfeff);

/** Network-shaped values: never neutralized (they load like any absolute URL)
 *  and never resolved to a repository read. */
const NETWORK_SHAPED = [
  "//evil.com/x",
  `${BS}${BS}evil.com${BS}x`,
  `/${BS}evil.com`,
  `${BS}/evil.com`,
  "javascript:alert(1)",
  "JaVaScRiPt:x",
  "https:x",
  "data:image/png;base64,AA",
  `${TAB}//evil.com/x`,
  `/${TAB}/evil.com`,
];

/** Path-shaped values the resolver refuses. Each is still neutralized: left on
 *  the img it would load from the webview's own origin. */
const REFUSED_PATHS = [
  "%0a//evil.com",
  `a${NUL}b.png`,
  "a%00b.png",
  "a%2Fb.png",
  "a%5Cb.png",
  "../x.png",
  "docs/../../x.png",
  "%2e%2e/x.png",
  "%E0%A4%A.png",
];

test("network-shaped image URLs are neither neutralized nor resolved", () => {
  for (const raw of NETWORK_SHAPED) {
    assert.equal(isRepoRelativeImageUrl(raw), false, JSON.stringify(raw));
    assert.equal(resolveRepoImagePath(raw, ""), null, JSON.stringify(raw));
    assert.equal(resolveRepoImagePath(raw, "docs"), null, JSON.stringify(raw));
  }
});

test("a path the resolver refuses is still taken off the webview", () => {
  for (const raw of REFUSED_PATHS) {
    assert.equal(isRepoRelativeImageUrl(raw), true, JSON.stringify(raw));
    assert.equal(resolveRepoImagePath(raw, ""), null, JSON.stringify(raw));
  }
});

test("fragments and empty values are not repository images", () => {
  assert.equal(isRepoRelativeImageUrl("#top"), false);
  assert.equal(isRepoRelativeImageUrl(""), false);
  assert.equal(isRepoRelativeImageUrl(`  ${TAB} `), false);
  assert.equal(resolveRepoImagePath("#top", ""), null);
  assert.equal(resolveRepoImagePath("", "docs"), null);
});

test("repository paths resolve against the document's directory", () => {
  assert.equal(resolveRepoImagePath("docs/a.png", ""), "docs/a.png");
  assert.equal(resolveRepoImagePath("./a.png", "docs"), "docs/a.png");
  assert.equal(resolveRepoImagePath("../a.png", "docs"), "a.png");
  // One leading slash is the repository root: a local read, not a request.
  assert.equal(resolveRepoImagePath("/site/x.png", "docs"), "site/x.png");
  assert.equal(
    resolveRepoImagePath("my%20shot.png?raw=true#x", ""),
    "my shot.png",
  );
  assert.equal(resolveRepoImagePath("a..b.png", ""), "a..b.png");
  assert.equal(resolveRepoImagePath("a.png", "docs/guide"), "docs/guide/a.png");
  for (const raw of ["docs/a.png", "./a.png", "/site/x.png"])
    assert.equal(isRepoRelativeImageUrl(raw), true, raw);
});

test("srcset splits into candidates with their descriptors kept", () => {
  const parsed = parseSrcset("a.png 1x, https://x/b.png 2x");
  assert.deepEqual(parsed, [
    { url: "a.png", descriptor: "1x" },
    { url: "https://x/b.png", descriptor: "2x" },
  ]);
  assert.equal(isRepoRelativeImageUrl(parsed[0].url), true);
  assert.equal(isRepoRelativeImageUrl(parsed[1].url), false);
  assert.equal(serializeSrcset(parsed), "a.png 1x, https://x/b.png 2x");
  assert.deepEqual(parseSrcset("x.webp"), [{ url: "x.webp", descriptor: "" }]);
  assert.deepEqual(parseSrcset("a.png,, b.png 480w"), [
    { url: "a.png", descriptor: "" },
    { url: "b.png", descriptor: "480w" },
  ]);
  assert.deepEqual(parseSrcset(""), []);
});

/** Base64 of `text`'s UTF-8 bytes. */
function b64(text) {
  let bin = "";
  for (const byte of new TextEncoder().encode(text))
    bin += String.fromCharCode(byte);
  return btoa(bin);
}

const bytes = (text, mime = null) => ({
  base64: b64(text),
  mime,
  tooLarge: false,
});

test("only sniffed rasters and proven SVG become data: URLs", () => {
  assert.equal(renderableImageMime(bytes("SECRET=1"), ".env"), null);
  assert.equal(
    renderableImageMime(bytes("tree HEAD:docs\n\na.png\nb.png\n"), "docs"),
    null,
  );
  assert.equal(
    renderableImageMime({ base64: null, mime: null, tooLarge: true }, "a.png"),
    null,
  );
  assert.equal(
    renderableImageMime(
      { base64: null, mime: "image/png", tooLarge: false },
      "a.png",
    ),
    null,
  );
  assert.equal(
    renderableImageMime(bytes("GIF89a", "image/gif"), "a.gif"),
    "image/gif",
  );
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const svgMime = (text, path) => renderableImageMime(bytes(text), path);

test("an .svg whose bytes open an svg root renders as SVG", () => {
  assert.equal(svgMime(SVG, "logo.svg"), "image/svg+xml");
  assert.equal(svgMime(SVG, "LOGO.SVG"), "image/svg+xml");
  const prolog = [
    BOM,
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    "<!-- exported -->\n",
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ',
    '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n',
    SVG,
  ].join("");
  assert.equal(svgMime(prolog, "logo.svg"), "image/svg+xml");
  // Script and an external href are inert in an <img>-hosted SVG; the source
  // pin below keeps it from ever reaching the DOM any other way.
  assert.equal(
    svgMime(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
        '<image href="https://evil.example/x.png"/></svg>',
      "evil.svg",
    ),
    "image/svg+xml",
  );
});

test("an .svg that doesn't prove an svg root is captioned", () => {
  assert.equal(
    svgMime(
      "<!DOCTYPE html><html><script>alert(1)</script></html>",
      "page.svg",
    ),
    null,
  );
  assert.equal(svgMime("<svgfoo>", "x.svg"), null);
  assert.equal(
    svgMime('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', "x.svg"),
    null,
  );
  assert.equal(svgMime(`<!--${"a".repeat(6000)}-->${SVG}`, "x.svg"), null);
  assert.equal(svgMime(SVG, "logo.png"), null);
  assert.equal(isSvgDocument(b64("<svg"), "x.svg"), false);
});

test("captions name the image and give the owner-approved reason", () => {
  assert.equal(captionName("Logo", "x.png"), "Logo");
  assert.equal(captionName("  ", "docs/my%20shot.png?raw=1"), "my shot.png");
  assert.equal(captionName("", "%E0%A4%A.png"), "%E0%A4%A.png");
  assert.equal(captionName("", ""), "Image");
  assert.deepEqual(IMAGE_CAPTION_REASON, {
    absent: "Not in this version",
    tooLarge: "Too large to preview",
    notImage: "Can't show this file",
    readFailed: "Couldn't read the file",
    noRepo: "Images can't load in this view",
  });
  assert.equal(repoDocBaseDir("README.md"), "");
  assert.equal(repoDocBaseDir("docs/guide/README.md"), "docs/guide");
  assert.equal(decodedByteLength(b64("abcd")), 4);
  assert.equal(decodedByteLength(b64("abcde")), 5);
  assert.equal(decodedByteLength(b64("abcdef")), 6);
});

/** Every HTML-string-to-DOM sink, by its code token. Masking hides string and
 *  comment text, so a sink reached only through a string literal is out of
 *  this pin's reach. */
const BANNED_SINKS = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "createContextualFragment",
  "<object",
  "<iframe",
  "<embed",
  "parseFromString",
  "setHTMLUnsafe",
  "document.write",
  "srcdoc",
];

const PINNED = [
  { file: "src/components/markdown/markdown.tsx", jsx: true },
  { file: "src/components/markdown/markdown-images.ts", jsx: false },
];

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** The banned sinks `src` reaches in code. Throws when it can't be masked. */
const sinksIn = (src, jsx) => {
  const masked = maskNonCode(src, jsx);
  return BANNED_SINKS.filter((token) => masked.includes(token));
};

test("the image path writes no HTML string into the DOM", () => {
  for (const { file, jsx } of PINNED)
    assert.deepEqual(sinksIn(read(file), jsx), [], file);
});

test("the sink pin reads code, not comments", () => {
  for (const { file, jsx } of PINNED) {
    const src = read(file);
    assert.deepEqual(
      sinksIn(`${src}\nel.innerHTML = x;\n`, jsx),
      ["innerHTML"],
      file,
    );
    assert.deepEqual(sinksIn(`${src}\n// el.innerHTML = x\n`, jsx), [], file);
  }
});

/** Several reads past the limit, then a small one: what the loader would see. */
function budgetScenario(budget) {
  return {
    first: budget.admit(40),
    over: [budget.admit(80), budget.admit(80)],
    exhausted: budget.exhausted(),
    small: budget.admit(1),
  };
}

/** The shape the budget must not regress to: a discarded read isn't charged,
 *  so the exhausted gate never closes and every later path is read. */
function chargeOnlyOnAccept(limit) {
  let spent = 0;
  return {
    admit(size) {
      if (spent + size > limit) return false;
      spent += size;
      return true;
    },
    exhausted: () => spent >= limit,
  };
}

const BUDGET_EXPECTED = {
  first: true,
  over: [false, false],
  exhausted: true,
  small: false,
};

test("the image budget charges discarded reads and then admits nothing", () => {
  assert.deepEqual(budgetScenario(createImageBudget(100)), BUDGET_EXPECTED);
  const exact = createImageBudget(100);
  assert.equal(exact.exhausted(), false);
  assert.equal(exact.admit(100), true);
  assert.equal(exact.exhausted(), true);
});

test("the budget pin fails a budget that charges only what it keeps", () => {
  assert.notDeepEqual(budgetScenario(chargeOnlyOnAccept(100)), BUDGET_EXPECTED);
});

test("the loader gates and charges its reads through the budget", () => {
  const masked = maskNonCode(
    read("src/components/markdown/markdown.tsx"),
    true,
  );
  for (const call of [
    "createImageBudget(",
    "budget.exhausted(",
    "budget.admit(",
  ])
    assert.ok(masked.includes(call), call);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Drives runCapped with hand-settled tasks. */
function harness(count, limit, isCancelled = () => false) {
  const started = [];
  const tasks = [];
  let inFlight = 0;
  let peak = 0;
  let done = false;
  const items = Array.from({ length: count }, (_, i) => i);
  void runCapped(items, limit, isCancelled, (item) => {
    started.push(item);
    inFlight++;
    peak = Math.max(peak, inFlight);
    const d = deferred();
    tasks[item] = d;
    return d.promise.finally(() => {
      inFlight--;
    });
  }).then(() => {
    done = true;
  });
  return {
    started,
    tasks,
    peak: () => peak,
    done: () => done,
  };
}

test("runCapped starts in order and holds the limit exactly", async () => {
  const h = harness(5, 2);
  assert.deepEqual(h.started, [0, 1]);
  for (let i = 0; i < 5; i++) {
    assert.equal(h.done(), false);
    h.tasks[i].resolve();
    await flush();
  }
  assert.deepEqual(h.started, [0, 1, 2, 3, 4]);
  assert.equal(h.peak(), 2);
  assert.equal(h.done(), true);
});

test("runCapped starts nothing once cancelled, letting running tasks settle", async () => {
  let cancelled = false;
  const h = harness(5, 2, () => cancelled);
  h.tasks[0].resolve();
  cancelled = true;
  await flush();
  assert.deepEqual(h.started, [0, 1]);
  assert.equal(h.done(), false);
  h.tasks[1].resolve();
  await flush();
  assert.deepEqual(h.started, [0, 1]);
  assert.equal(h.done(), true);

  const never = harness(3, 2, () => true);
  await flush();
  assert.deepEqual(never.started, []);
  assert.equal(never.done(), true);
});

test("runCapped keeps going past a rejected task", async () => {
  const h = harness(3, 1);
  h.tasks[0].reject(new Error("read failed"));
  await flush();
  assert.deepEqual(h.started, [0, 1]);
  h.tasks[1].resolve();
  await flush();
  h.tasks[2].resolve();
  await flush();
  assert.deepEqual(h.started, [0, 1, 2]);
  assert.equal(h.done(), true);
});

test("runCapped under a wide limit starts everything, and an empty list resolves", async () => {
  const h = harness(3, 5);
  assert.deepEqual(h.started, [0, 1, 2]);
  for (const t of h.tasks) t.resolve();
  await flush();
  assert.equal(h.done(), true);

  const empty = harness(0, 4);
  await flush();
  assert.equal(empty.done(), true);
});
