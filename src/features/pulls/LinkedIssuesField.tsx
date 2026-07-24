import { Popover } from "@base-ui/react/popover";
import { LinkIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { IssuePicker, StateIcon } from "@/features/issues/IssueRelations";
import type { RemoteLens } from "@/lib/git/types";
import type { JiraLink } from "@/lib/jira/store";
import { JiraIssuePicker, JiraStatusIcon } from "./JiraIssuePicker";

/** One linked-issue chip: a real repo issue the PR will reference on create. The
 *  keyword becomes a `Closes #N` / `Relates to #N` line appended to the body. */
export interface LinkedIssueChip {
  number: number;
  title: string;
  /** "OPEN" | "CLOSED" (neutral IssueInfo casing). */
  state: string;
  keyword: "closes" | "relates";
  source: "extraction" | "ai" | "manual";
  /** The model proposed this as a close — sorts first, keyword gets a hint tooltip. */
  aiSuggestedClose: boolean;
}

/** One Jira mention chip: a linked-project issue the PR MENTIONS (Bitbucket repos
 *  with no native tracker). Mention-only — there is no keyword toggle and no close
 *  semantics; it becomes a `Relates to KEY` line appended to the body. */
export interface JiraMentionChip {
  key: string;
  summary: string;
  /** Jira `statusCategory` key: "done" maps to the closed/merged glyph, anything
   *  else to the open/success glyph. */
  statusCategory: string;
  source: "extraction" | "ai" | "manual";
}

/** Props for the native (GitHub/GitLab) issue-link cluster. `variant` is optional
 *  (absent ⇒ native), so existing call sites compile unchanged. */
interface NativeFieldProps {
  variant?: "native";
  repoPath: string;
  lens: RemoteLens;
  chips: LinkedIssueChip[];
  onToggleKeyword: (issueNumber: number) => void;
  onRemove: (issueNumber: number) => void;
  onPick: (issueNumber: number) => void;
  disabled?: boolean;
}

/** Props for the Jira mention-only cluster (Bitbucket + linked project). No
 *  keyword toggle — the chips are mention-only. */
interface JiraFieldProps {
  variant: "jira";
  repoPath: string;
  /** The repo's Jira link (site + project) — drives the picker. */
  link: JiraLink | null;
  jiraChips: JiraMentionChip[];
  onRemove: (key: string) => void;
  onPick: (key: string) => void;
  disabled?: boolean;
}

/** The linked-issue cluster in the PR create/edit dialogs. Two variants: the
 *  native (GitHub/GitLab) issue-link band with a Closes/Relates keyword toggle,
 *  and the Bitbucket Jira mention-only band. They're mutually exclusive — a repo
 *  is exactly one provider — so a caller renders exactly one. */
export function LinkedIssuesField(props: NativeFieldProps | JiraFieldProps) {
  if (props.variant === "jira") return <JiraMentionsField {...props} />;
  return <NativeLinkedIssuesField {...props} />;
}

/** The chip cluster in Create PR: extraction-seeded, AI-proposed, and
 *  manually-added issue links. The parent owns the chip state; this renders the
 *  band + the "Link issue" picker and reports toggles/removes/picks upward. */
function NativeLinkedIssuesField({
  repoPath,
  lens,
  chips,
  onToggleKeyword,
  onRemove,
  onPick,
  disabled,
}: NativeFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Roving tabindex: the band is a single tab stop; ArrowLeft/Right move the
  // roved index, which sets which chip is focusable + focused.
  const [focusIndex, setFocusIndex] = useState(0);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // AI-suggested closes sort first; ties keep insertion order (stable sort).
  const ordered = [...chips].sort(
    (a, b) => Number(b.aiSuggestedClose) - Number(a.aiSuggestedClose),
  );
  const excluded = new Set(chips.map((c) => c.number));
  // Clamp the roved index at point of use: chips can shrink via the mouse ✕
  // without touching `focusIndex`, and a stale index past the end would render
  // EVERY chip tabIndex=-1 — the band would drop out of the tab order entirely.
  const effectiveFocusIndex = Math.max(
    0,
    Math.min(focusIndex, ordered.length - 1),
  );

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(index, ordered.length - 1));
    setFocusIndex(clamped);
    chipRefs.current[clamped]?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const chip = ordered[index];
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < ordered.length - 1) focusChip(index + 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleKeyword(chip.number);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(chip.number);
      // Focus the chip that slides into this slot (or the new last one). Defer
      // past the removal re-render: focusChip reads chipRefs, and reading them
      // synchronously here would target the node being unmounted (focus drops to
      // body for any non-last chip). rAF lands after the list has re-rendered.
      const nextCount = ordered.length - 1;
      if (nextCount > 0) {
        const target = Math.min(index, nextCount - 1);
        requestAnimationFrame(() => focusChip(target));
      }
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label>Linked issues</Label>
        <span className="flex-1" />
        <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Popover.Trigger
            render={
              <Button
                variant="outline"
                size="xs"
                disabled={disabled}
                aria-label="Link an issue"
              />
            }
          >
            <LinkIcon data-icon="inline-start" />
            Link issue
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              align="end"
              sideOffset={4}
              className="isolate z-50"
            >
              <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                <IssuePicker
                  repoPath={repoPath}
                  exclude={excluded}
                  pending={false}
                  lens={lens}
                  onPick={(n) => {
                    setPickerOpen(false);
                    onPick(n);
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {ordered.length > 0 && (
        <>
          <div
            role="group"
            aria-label="Linked issues"
            className="flex flex-wrap items-center gap-1.5"
          >
            {ordered.map((chip, index) => {
              const keywordLabel =
                chip.keyword === "closes" ? "Closes" : "Relates to";
              const keywordHint =
                chip.aiSuggestedClose && chip.keyword === "relates"
                  ? `AI suggests this pull request closes #${chip.number} — click to switch to Closes.`
                  : undefined;
              // State word omitted while unresolved (a just-picked closed issue
              // seeds state "" until the probe resolves) — no "Open issue." lie
              // and no dangling sentence.
              const stateSentence =
                chip.state === "CLOSED"
                  ? "Closed issue. "
                  : chip.state === "OPEN"
                    ? "Open issue. "
                    : "";
              const switchTo =
                chip.keyword === "closes" ? "Relates to" : "Closes";
              return (
                <span
                  key={chip.number}
                  className="inline-flex items-center gap-1 border py-0.5 pr-0.5 pl-1.5 text-xs"
                >
                  <StateIcon state={chip.state} />
                  <button
                    type="button"
                    ref={(el) => {
                      chipRefs.current[index] = el;
                    }}
                    tabIndex={index === effectiveFocusIndex ? 0 : -1}
                    title={keywordHint}
                    aria-label={`${keywordLabel} issue ${chip.number}: ${chip.title}. ${stateSentence}Press Enter to switch to ${switchTo}, Delete to remove.`}
                    onClick={() => onToggleKeyword(chip.number)}
                    onFocus={() => setFocusIndex(index)}
                    onKeyDown={(e) => onChipKeyDown(e, index)}
                    className="inline-flex items-center gap-1 cursor-pointer rounded-none outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                  >
                    {chip.source === "ai" && (
                      <SparkleIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={
                        chip.keyword === "closes"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      {keywordLabel}
                    </span>
                    <span className="text-muted-foreground">
                      #{chip.number}
                    </span>
                    <span className="max-w-40 truncate" title={chip.title}>
                      {chip.title}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    aria-label={`Remove #${chip.number}`}
                    className="text-muted-foreground"
                    onClick={() => onRemove(chip.number)}
                  >
                    <XIcon />
                  </Button>
                </span>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Added to the description on create.
          </p>
        </>
      )}
    </div>
  );
}

/** The Jira mention-only cluster (Bitbucket + linked project). Same band shape as
 *  the native field minus the keyword toggle: each chip shows a fixed muted
 *  "Relates to" label, the key, and its summary; the only chip action is remove.
 *  Roving tabindex identical to native minus the Enter/Space toggle. */
function JiraMentionsField({
  repoPath,
  link,
  jiraChips,
  onRemove,
  onPick,
  disabled,
}: JiraFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Roving tabindex: the band is a single tab stop; ArrowLeft/Right move the
  // roved index, which sets which chip is focusable + focused.
  const [focusIndex, setFocusIndex] = useState(0);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // AI-suggested chips sort first (parity with the native band's sparkle-first
  // ordering); ties keep insertion order (stable sort).
  const ordered = [...jiraChips].sort(
    (a, b) => Number(b.source === "ai") - Number(a.source === "ai"),
  );
  const excluded = new Set(jiraChips.map((c) => c.key));
  // Clamp the roved index at point of use (see the native band): a mouse ✕ can
  // shrink the list without touching `focusIndex`, and a stale index past the end
  // would render every chip tabIndex=-1, dropping the band out of the tab order.
  const effectiveFocusIndex = Math.max(
    0,
    Math.min(focusIndex, ordered.length - 1),
  );

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(index, ordered.length - 1));
    setFocusIndex(clamped);
    chipRefs.current[clamped]?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const chip = ordered[index];
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < ordered.length - 1) focusChip(index + 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(chip.key);
      // Focus the slid-in chip, deferred past the removal re-render (reading
      // chipRefs synchronously would target the unmounting node — focus drops to
      // body for any non-last chip). Same rAF fix as the native band.
      const nextCount = ordered.length - 1;
      if (nextCount > 0) {
        const target = Math.min(index, nextCount - 1);
        requestAnimationFrame(() => focusChip(target));
      }
    }
    // Enter/Space intentionally do nothing — there is no keyword toggle.
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label>Linked issues</Label>
        <span className="flex-1" />
        <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Popover.Trigger
            render={
              <Button
                variant="outline"
                size="xs"
                disabled={disabled}
                aria-label="Link an issue"
              />
            }
          >
            <LinkIcon data-icon="inline-start" />
            Link issue
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              align="end"
              sideOffset={4}
              className="isolate z-50"
            >
              <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                <JiraIssuePicker
                  repoPath={repoPath}
                  link={link}
                  exclude={excluded}
                  pending={false}
                  onPick={(key) => {
                    setPickerOpen(false);
                    onPick(key);
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {ordered.length > 0 && (
        <>
          <div
            role="group"
            aria-label="Linked issues"
            className="flex flex-wrap items-center gap-1.5"
          >
            {ordered.map((chip, index) => {
              // State word omitted while unresolved (a just-picked issue seeds
              // statusCategory "" until the probe resolves) — no wrong "Open" and
              // no dangling sentence.
              const cat = chip.statusCategory.toLowerCase();
              const stateSentence =
                cat === "done" ? "Done. " : cat ? "Open. " : "";
              const summary = chip.summary || chip.key;
              return (
                <span
                  key={chip.key}
                  className="inline-flex items-center gap-1 border py-0.5 pr-0.5 pl-1.5 text-xs"
                >
                  <JiraStatusIcon statusCategory={chip.statusCategory} />
                  <button
                    type="button"
                    ref={(el) => {
                      chipRefs.current[index] = el;
                    }}
                    tabIndex={index === effectiveFocusIndex ? 0 : -1}
                    aria-label={`Relates to ${chip.key}: ${summary}. ${stateSentence}Press Delete to remove.`}
                    onFocus={() => setFocusIndex(index)}
                    onKeyDown={(e) => onChipKeyDown(e, index)}
                    className="inline-flex items-center gap-1 cursor-default rounded-none outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                  >
                    {chip.source === "ai" && (
                      <SparkleIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-muted-foreground">Relates to</span>
                    <span className="font-mono text-muted-foreground">
                      {chip.key}
                    </span>
                    <span className="max-w-40 truncate" title={summary}>
                      {summary}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    aria-label={`Remove ${chip.key}`}
                    className="text-muted-foreground"
                    onClick={() => onRemove(chip.key)}
                  >
                    <XIcon />
                  </Button>
                </span>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Added to the description on create.
          </p>
        </>
      )}
    </div>
  );
}
