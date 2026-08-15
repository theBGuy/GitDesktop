import type { ThemeRegistration } from "@shikijs/types";

/**
 * ONE theme-agnostic token theme: every foreground is a CSS variable, so a
 * light↔dark toggle re-colors already-tokenized spans by cascade alone and the
 * diff never re-tokenizes (the palettes live in App.css under `:root`/`.dark`).
 * Shiki passes a non-`#` foreground through theme normalization untouched — it
 * swaps in a placeholder hex and maps it back at token time — so `token.color`
 * receives the `var(...)` string verbatim (verified against @shikijs/core
 * 4.4.3's normalizeTheme, which lives in @shikijs/primitive).
 *
 * Coverage is deliberately broad — including bare `variable`, `support.class`,
 * `keyword.other` — so even loosely-scoped grammars (a custom DSL, a hand-rolled
 * .tmLanguage) get colored instead of falling to a dim default. `type` is
 * omitted: this theme has no light/dark identity, and Shiki only reads it to
 * pick fallback fg/bg, both of which we supply or never render.
 */
export const gdDiff = {
  name: "gd-diff",
  colors: { "editor.foreground": "var(--gd-syn-fg)" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "var(--gd-syn-comment)", fontStyle: "italic" },
    },
    {
      scope: ["string", "string.quoted", "string.regexp", "string.template"],
      settings: { foreground: "var(--gd-syn-string)" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "constant.character.escape",
        "constant.other",
      ],
      settings: { foreground: "var(--gd-syn-number)" },
    },
    {
      scope: [
        "keyword",
        "keyword.control",
        "keyword.operator",
        "keyword.other",
        "storage",
        "storage.type",
        "storage.modifier",
        "support.class",
        "support.type.primitive",
      ],
      settings: { foreground: "var(--gd-syn-keyword)" },
    },
    {
      scope: [
        "variable",
        "variable.other",
        "variable.parameter",
        "variable.language",
        "meta.definition.variable",
        "entity.name.variable",
      ],
      settings: { foreground: "var(--gd-syn-variable)" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call.generic",
      ],
      settings: { foreground: "var(--gd-syn-func)" },
    },
    {
      scope: ["entity.name.type", "entity.name.class", "support.type"],
      settings: { foreground: "var(--gd-syn-type)" },
    },
    {
      scope: ["entity.name.tag", "punctuation.definition.tag"],
      settings: { foreground: "var(--gd-syn-tag)" },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: { foreground: "var(--gd-syn-attr)" },
    },
  ],
} satisfies ThemeRegistration;
