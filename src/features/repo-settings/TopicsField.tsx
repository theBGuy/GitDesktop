import { XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** How a provider turns a raw typed token into a committed topic, which
 *  keystrokes commit the buffer, and whether there's a hard cap. GitHub slugs
 *  and caps; GitLab is freeform. */
export type TopicRules = {
  /** Raw buffer → committed topic. Returns "" to reject (e.g. empty). */
  normalize: (raw: string) => string;
  /** Keys that flush the add-buffer into a chip. */
  commitKeys: Array<"enter" | "comma" | "space">;
  /** Hard limit; omit for unbounded (GitLab). */
  maxTopics?: number;
};

/** GitHub topics: lowercase slug — runs of non-alphanumerics collapse to a
 *  single dash, edges trimmed, capped at 50 chars. `React Native` → `react-native`. */
export const GITHUB_TOPIC_RULES: TopicRules = {
  normalize: (raw) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, ""),
  commitKeys: ["enter", "comma", "space"],
  maxTopics: 20,
};

/** GitLab topics: freeform — trim only, case and spaces preserved. Space is a
 *  valid topic char, so only Enter/comma commit. */
export const GITLAB_TOPIC_RULES: TopicRules = {
  normalize: (raw) => raw.trim(),
  commitKeys: ["enter", "comma"],
};

/** Removable topic chips + an inline add-input, all inside one bordered
 *  field-shell that matches the app's other inputs. `topics` (the parent's
 *  `form.topics`) is the single source of truth; the uncommitted add-buffer is
 *  local `draft` state and never leaks into `topics` until committed.
 *
 *  Keyboard: Enter/comma (and space for GitHub) commit the buffer; Backspace on
 *  an empty buffer removes the last chip; ←/→ move focus among chips; Enter or
 *  the ✕ removes a focused chip; the add-input keeps focus after a commit. */
export function TopicsField({
  id,
  topics,
  onChange,
  rules,
}: {
  id?: string;
  topics: string[];
  onChange: (next: string[]) => void;
  rules: TopicRules;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const atCap = rules.maxTopics != null && topics.length >= rules.maxTopics;

  /** Normalize the buffer and append it (deduped) — a no-op if it normalizes to
   *  empty, is already present, or we're at the cap. Clears the buffer either way. */
  function commit() {
    const topic = rules.normalize(draft);
    setDraft("");
    if (!topic || atCap || topics.includes(topic)) return;
    onChange([...topics, topic]);
  }

  function removeAt(index: number) {
    onChange(topics.filter((_, i) => i !== index));
    // Defer to after re-render: at the cap the input is `disabled`, so a
    // synchronous focus() would no-op until it re-enables next render.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function focusChip(index: number) {
    chipRefs.current[index]?.focus();
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const commitOnEnter = rules.commitKeys.includes("enter");
    const commitOnComma = rules.commitKeys.includes("comma");
    const commitOnSpace = rules.commitKeys.includes("space");

    if (
      (e.key === "Enter" && commitOnEnter) ||
      (e.key === "," && commitOnComma) ||
      (e.key === " " && commitOnSpace)
    ) {
      e.preventDefault();
      commit();
      return;
    }
    // Backspace on an empty buffer removes the last chip.
    if (e.key === "Backspace" && draft === "" && topics.length > 0) {
      e.preventDefault();
      onChange(topics.slice(0, -1));
      return;
    }
    // ← from the start of an empty-ish buffer hops onto the last chip.
    if (
      e.key === "ArrowLeft" &&
      topics.length > 0 &&
      inputRef.current?.selectionStart === 0
    ) {
      e.preventDefault();
      focusChip(topics.length - 1);
    }
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < topics.length - 1) focusChip(index + 1);
      else inputRef.current?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      removeAt(index);
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-none border border-input bg-transparent px-2 py-1.5 text-xs transition-colors dark:bg-input/30",
        "focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50",
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {topics.map((topic, index) => (
        <span
          key={topic}
          className="inline-flex items-center gap-1 border py-0.5 pr-0.5 pl-1.5 text-[11px] text-muted-foreground"
        >
          <span className="max-w-[16rem] truncate">{topic}</span>
          <button
            type="button"
            ref={(el) => {
              chipRefs.current[index] = el;
            }}
            aria-label={`Remove topic ${topic}`}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-none text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
            // Don't steal focus from the add-input on mousedown, or its
            // onBlur→commit would flush a half-typed draft into a spurious chip.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => removeAt(index)}
            onKeyDown={(e) => onChipKeyDown(e, index)}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        disabled={atCap}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onInputKeyDown}
        onBlur={commit}
        placeholder={topics.length === 0 ? "Add a topic…" : undefined}
        autoComplete="off"
        spellCheck={false}
        className="min-w-24 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}
