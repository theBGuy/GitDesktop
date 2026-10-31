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
  captionReason,
  createBudgetStore,
  createImageBudget,
  decodedByteLength,
  IMAGE_CAPTION_REASON,
  imageFate,
  isRepoRelativeImageUrl,
  isSvgDocument,
  keepsShownImage,
  parseSrcset,
  RELATIVE_URL_ATTRS,
  REPO_IMAGE_ATTRS,
  RUN_ATTR,
  relativeUrlAttrs,
  renderableImageMime,
  repoDocBaseDir,
  resolveRepoImagePath,
  runCapped,
  SHOWN_SRC_ATTR,
  serializeSrcset,
  unitNeedsWalk,
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
    "createBudgetStore(",
    "budgetFor(htmlProp, runKey)",
    "budget.exhausted(",
    "budget.admit(",
  ])
    assert.ok(masked.includes(call), call);
});

test("a re-read of a charged path costs nothing more", () => {
  const budget = createImageBudget(100);
  assert.equal(budget.admit(60, "a.png"), true);
  assert.equal(budget.admit(60, "a.png"), true);
  assert.equal(budget.exhausted(), false);
  assert.equal(budget.admit(60, "b.png"), false);
  assert.equal(budget.exhausted(), true);
});

/** A run interrupted after charging, then the next run under `secondKey`: how
 *  much the next run may still read. */
function interruptedRun(store, secondKey) {
  const body = {};
  store(body, "k1").admit(80, "a.png");
  const next = store(body, secondKey);
  return { exhausted: next.exhausted(), fits: next.admit(30, "b.png") };
}

test("a same-key run resumes its body's budget; a new key or body starts fresh", () => {
  const store = createBudgetStore(() => createImageBudget(100));
  assert.deepEqual(interruptedRun(store, "k1"), {
    exhausted: false,
    fits: false,
  });
  assert.deepEqual(interruptedRun(store, "k2"), {
    exhausted: false,
    fits: true,
  });
  const a = {};
  assert.equal(store(a, "k1"), store(a, "k1"));
  assert.notEqual(store(a, "k1"), store({}, "k1"));
});

test("the budget-store pin fails a budget made fresh for every run", () => {
  const freshEachRun = () => createImageBudget(100);
  assert.notDeepEqual(interruptedRun(freshEachRun, "k1"), {
    exhausted: false,
    fits: false,
  });
});

/** Image units after their srcsets are written: what the image's own src did,
 *  and the fate each must get. */
const FATE_CASES = [
  {
    name: "own src loaded",
    input: { own: { loaded: "data:a" }, ownSrcset: "", sourceSrcsets: [] },
    fate: { keepWithSrc: "data:a" },
  },
  {
    name: "own srcset kept a candidate",
    input: { own: "failed", ownSrcset: "data:b 2x", sourceSrcsets: [] },
    fate: "keep",
  },
  {
    name: "absolute src",
    input: { own: "absolute", ownSrcset: "", sourceSrcsets: [""] },
    fate: "keep",
  },
  {
    name: "lone image whose src failed",
    input: { own: "failed", ownSrcset: "", sourceSrcsets: [] },
    fate: "caption",
  },
  {
    name: "picture whose img failed beside a kept dark-mode source",
    input: {
      own: "failed",
      ownSrcset: "",
      sourceSrcsets: ["", "https://cdn.example/dark.png 1x, data:c 2x"],
    },
    fate: { keepWithSrc: "https://cdn.example/dark.png" },
  },
  {
    name: "picture whose img failed beside a loaded relative source",
    input: { own: "failed", ownSrcset: "", sourceSrcsets: ["data:d"] },
    fate: { keepWithSrc: "data:d" },
  },
  {
    name: "picture with no candidate anywhere",
    input: { own: "failed", ownSrcset: "", sourceSrcsets: ["", ""] },
    fate: "caption",
  },
  {
    name: "src-less image in a picture whose source kept one",
    input: { own: "none", ownSrcset: "", sourceSrcsets: ["data:e"] },
    fate: "keep",
  },
  {
    name: "src-less image with nothing kept",
    input: { own: "none", ownSrcset: "", sourceSrcsets: [] },
    fate: "caption",
  },
];

/** The cases `fate` gets wrong, by name. */
const fateMisses = (fate) =>
  FATE_CASES.filter((c) => {
    try {
      assert.deepEqual(fate(c.input), c.fate);
      return false;
    } catch {
      return true;
    }
  }).map((c) => c.name);

/** The rule the picture fallback replaced: an image whose own src failed is
 *  captioned unless its own srcset kept something. */
function captionWhenOwnSrcFailed({ own, ownSrcset, sourceSrcsets }) {
  if (typeof own === "object") return { keepWithSrc: own.loaded };
  if (parseSrcset(ownSrcset).length > 0 || own === "absolute") return "keep";
  if (own === "failed") return "caption";
  return sourceSrcsets.some((s) => parseSrcset(s).length > 0)
    ? "keep"
    : "caption";
}

test("a picture with a surviving source keeps an image, taking its candidate as src", () => {
  assert.deepEqual(fateMisses(imageFate), []);
});

test("the picture-fallback pin fails the caption-when-own-src-failed rule", () => {
  assert.deepEqual(fateMisses(captionWhenOwnSrcFailed), [
    "picture whose img failed beside a kept dark-mode source",
    "picture whose img failed beside a loaded relative source",
  ]);
});

test("a run walks only units not yet written for its key", () => {
  assert.equal(unitNeedsWalk(undefined, "0"), true);
  assert.equal(unitNeedsWalk("1700", "1700"), false);
  assert.equal(unitNeedsWalk("1700", "1800"), true);
  // Negative control: skipping any unit written before never re-reads one.
  const skipWritten = (writtenFor) => writtenFor === undefined;
  assert.notEqual(skipWritten("1700", "1800"), unitNeedsWalk("1700", "1800"));
});

test("a failed read never downgrades a shown image; a definite outcome does", () => {
  assert.equal(keepsShownImage(true, ["readFailed"]), true);
  assert.equal(keepsShownImage(true, ["absent", "readFailed"]), true);
  for (const reason of ["absent", "tooLarge", "notImage"])
    assert.equal(keepsShownImage(true, [reason]), false, reason);
  assert.equal(keepsShownImage(true, []), false);
  // Never shown (first write, or a caption), a failed read captions as before.
  assert.equal(keepsShownImage(false, ["readFailed"]), false);
  // Negative control: writing every outcome downgrades on a failed read.
  const writeEverything = () => false;
  assert.notEqual(writeEverything(true, ["readFailed"]), true);
});

test("a budget refusal keeps a shown image and captions an unshown one as too large", () => {
  assert.equal(keepsShownImage(true, ["overBudget"]), true);
  assert.equal(keepsShownImage(true, ["absent", "overBudget"]), true);
  assert.equal(keepsShownImage(false, ["overBudget"]), false);
  assert.equal(captionReason("overBudget"), "tooLarge");
  for (const reason of Object.keys(IMAGE_CAPTION_REASON))
    assert.equal(captionReason(reason), reason);
  // Negative control: a refusal spelled as the file's own size downgrades.
  assert.equal(keepsShownImage(true, ["tooLarge"]), false);
});

/** The `data-repo-*` names a source spells, as attributes or dataset keys. */
function repoDataAttrs(src) {
  const names = new Set(src.match(/data-repo-[a-z][a-z0-9-]*/g) ?? []);
  const masked = maskNonCode(src, true);
  for (const m of masked.matchAll(/\.dataset\.repo([A-Z][A-Za-z0-9]*)/g))
    names.add(
      `data-repo-${m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).slice(1)}`,
    );
  return [...names];
}

test("the sanitize hook strips every data-repo attribute the loader uses", () => {
  const used = repoDataAttrs(read("src/components/markdown/markdown.tsx"));
  assert.ok(used.includes("data-repo-src"), "the scan reads attribute names");
  assert.ok(used.includes("data-repo-srcset"));
  assert.deepEqual(
    used.filter((name) => !REPO_IMAGE_ATTRS.includes(name)),
    [],
  );
  assert.ok(REPO_IMAGE_ATTRS.includes(RUN_ATTR));
  assert.ok(REPO_IMAGE_ATTRS.includes(SHOWN_SRC_ATTR));
  const masked = maskNonCode(
    read("src/components/markdown/markdown.tsx"),
    true,
  );
  assert.ok(masked.includes("of REPO_IMAGE_ATTRS) node.removeAttribute("));
});

test("the strip pin flags an unlisted data-repo name in either spelling", () => {
  const src = read("src/components/markdown/markdown.tsx");
  for (const forged of [
    `${src}\nel.setAttribute("data-repo-forged", "");\n`,
    `${src}\nel.dataset.repoForgedRun = "0";\n`,
  ])
    assert.deepEqual(
      repoDataAttrs(forged).filter((n) => !REPO_IMAGE_ATTRS.includes(n)),
      [forged.includes("Run") ? "data-repo-forged-run" : "data-repo-forged"],
    );
});

test("the loader decides through the pinned helpers and stamps its run key", () => {
  const masked = maskNonCode(
    read("src/components/markdown/markdown.tsx"),
    true,
  );
  for (const call of [
    "imageFate(",
    "unitNeedsWalk(",
    "keepsShownImage(",
    "captionedRoots.set(",
    "relativeUrlAttrs(",
    "contains(active)",
    "preventScroll: true",
    "reconcileLightboxImage(",
    "unmarkLightboxImage(",
    "SHOWN_SRC_ATTR",
    "rescueFocus(home)",
  ])
    assert.ok(masked.includes(call), call);
});

const HREFS = ["href", "xlink:href"];

test("relative fetch URLs are removed on exactly these elements and attributes", () => {
  assert.deepEqual(
    [...RELATIVE_URL_ATTRS].map(([tag, attrs]) => [tag, [...attrs]]),
    [
      ["*", ["background"]],
      ["altglyph", HREFS],
      ["audio", ["src"]],
      ["feimage", HREFS],
      ["filter", HREFS],
      ["glyphref", HREFS],
      ["image", HREFS],
      ["input", ["src"]],
      ["lineargradient", HREFS],
      ["mpath", HREFS],
      ["pattern", HREFS],
      ["radialgradient", HREFS],
      ["source", ["src"]],
      ["textpath", HREFS],
      ["track", ["src"]],
      ["tref", HREFS],
      ["video", ["src", "poster"]],
    ],
  );
  // Matched by name in any case, with `background` on every element.
  assert.deepEqual(relativeUrlAttrs("feImage"), ["background", ...HREFS]);
  assert.deepEqual(relativeUrlAttrs("TD"), ["background"]);
  assert.deepEqual(relativeUrlAttrs("IMG"), ["background"]);
  // The same predicate as images: relative goes; absolute, data: and a
  // same-document fragment stay.
  for (const v of ["clip.mp4", "./a/b.vtt", "/media/poster.png", "x.svg#g"])
    assert.equal(isRepoRelativeImageUrl(v), true, v);
  for (const v of [
    "https://cdn.example/clip.mp4",
    "//cdn/x.mp4",
    "data:x",
    "#g",
  ])
    assert.equal(isRepoRelativeImageUrl(v), false, v);
});

/** DOMPurify's default allowlists, read from its build: the frozen lists its
 *  DEFAULT_ALLOWED_TAGS and DEFAULT_ALLOWED_ATTR spread. */
function purifyDefaults() {
  const src = readFileSync(
    new URL("../node_modules/dompurify/dist/purify.es.mjs", import.meta.url),
    "utf8",
  );
  const lists = new Map();
  for (const m of src.matchAll(/const (\w+\$?\d*) = freeze\(\[([^\]]*)\]\);/g))
    lists.set(
      m[1],
      [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase()),
    );
  const union = (names) =>
    new Set(
      names.flatMap((n) => {
        assert.ok(lists.has(n), `DOMPurify list ${n}`);
        return lists.get(n);
      }),
    );
  return {
    tags: union(["html$1", "svg$1", "svgFilters", "mathMl$1"]),
    attrs: union(["html", "svg", "mathMl", "xml"]),
  };
}

test("every neutralized pair survives DOMPurify's default allowlists", () => {
  const { tags, attrs } = purifyDefaults();
  for (const [tag, names] of RELATIVE_URL_ATTRS) {
    if (tag !== "*") assert.ok(tags.has(tag), tag);
    for (const attr of names) assert.ok(attrs.has(attr), `${tag} ${attr}`);
  }
  // Negative control: a disallowed SVG element isn't in the union.
  assert.equal(tags.has("use"), false);
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
