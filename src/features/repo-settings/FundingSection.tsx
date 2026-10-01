import { HeartIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useDeleteFunding, useFunding, useSetFunding } from "@/lib/git/queries";
import { toastError } from "@/lib/toast";
import { InlineConfirm, RemoteFormSection } from "./parts";

const GITHUB_KEY = "github";
const CUSTOM_KEY = "custom";

/** Single-value FUNDING.yml platforms (one handle each), in display order. */
const SINGLE_PLATFORMS = [
  { key: "patreon", label: "Patreon", placeholder: "username" },
  { key: "open_collective", label: "Open Collective", placeholder: "slug" },
  { key: "ko_fi", label: "Ko-fi", placeholder: "username" },
  { key: "liberapay", label: "Liberapay", placeholder: "username" },
  { key: "buy_me_a_coffee", label: "Buy Me a Coffee", placeholder: "username" },
  { key: "polar", label: "Polar", placeholder: "username" },
  { key: "tidelift", label: "Tidelift", placeholder: "platform/package" },
  {
    key: "community_bridge",
    label: "Community Bridge",
    placeholder: "project",
  },
  { key: "issuehunt", label: "IssueHunt", placeholder: "username" },
  {
    key: "lfx_crowdfunding",
    label: "LFX Crowdfunding",
    placeholder: "project",
  },
  { key: "thanks_dev", label: "thanks.dev", placeholder: "u/gh/username" },
] as const;

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, "");
}

function splitList(s: string): string[] {
  return s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Parse the common FUNDING.yml shapes: `key: value`, `key: [a, b]`, and block
 *  lists (`key:` then `  - item`). Robust enough for real funding files. */
function parseFunding(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let key: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = raw.match(/^\s+-\s*(.+?)\s*$/);
    if (item && key) {
      out[key].push(unquote(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    out[key] ??= [];
    const v = kv[2].trim();
    if (!v) continue;
    if (v.startsWith("[")) {
      for (const p of v.replace(/^\[|\]$/g, "").split(",")) {
        const u = unquote(p);
        if (u) out[key].push(u);
      }
    } else {
      out[key].push(unquote(v));
    }
  }
  return out;
}

function toFields(content: string): Record<string, string> {
  const parsed = parseFunding(content);
  const f: Record<string, string> = {
    [GITHUB_KEY]: (parsed[GITHUB_KEY] ?? []).join(", "),
    [CUSTOM_KEY]: (parsed[CUSTOM_KEY] ?? []).join("\n"),
  };
  for (const p of SINGLE_PLATFORMS) f[p.key] = (parsed[p.key] ?? [])[0] ?? "";
  return f;
}

function generateFunding(fields: Record<string, string>): string {
  const lines: string[] = [];
  const gh = splitList(fields[GITHUB_KEY] ?? "").slice(0, 4);
  if (gh.length === 1) lines.push(`github: ${gh[0]}`);
  else if (gh.length > 1) lines.push(`github: [${gh.join(", ")}]`);
  for (const p of SINGLE_PLATFORMS) {
    const v = (fields[p.key] ?? "").trim();
    if (v) lines.push(`${p.key}: ${v}`);
  }
  const custom = splitList(fields[CUSTOM_KEY] ?? "");
  if (custom.length === 1) lines.push(`custom: ${JSON.stringify(custom[0])}`);
  else if (custom.length > 1) {
    lines.push(`custom: [${custom.map((u) => JSON.stringify(u)).join(", ")}]`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function FundingSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const funding = useFunding(repoPath, open);

  return (
    <RemoteFormSection
      query={funding}
      noun="funding links"
      skeleton={
        <div className="min-w-0 space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      }
      errorTitle="Couldn't load funding."
    >
      {(content) => (
        // `null` is a loaded answer: there's no FUNDING.yml yet.
        <FundingForm key={repoPath} repoPath={repoPath} content={content} />
      )}
    </RemoteFormSection>
  );
}

function FundingForm({
  repoPath,
  content,
}: {
  repoPath: string;
  content: string | null;
}) {
  const exists = content !== null;
  const set = useSetFunding(repoPath);
  const del = useDeleteFunding(repoPath);
  const seed = useMemo(() => toFields(content ?? ""), [content]);
  // Only the fields the user touched, so untouched ones ride the latest file. A
  // touched field retires once the file reads back equal, never on the save
  // itself: a save whose refetch failed keeps its values on screen.
  const [edit, setEdit] = useState<Record<string, string> | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  if (edit !== null) {
    const kept = Object.keys(edit).filter((k) => edit[k] !== seed[k]);
    if (kept.length !== Object.keys(edit).length)
      setEdit(
        kept.length > 0
          ? Object.fromEntries(kept.map((k) => [k, edit[k]]))
          : null,
      );
  }

  const dirty = edit !== null;
  const fields = { ...seed, ...edit };
  const setField = (key: string, value: string) =>
    setEdit((e) => ({ ...e, [key]: value }));

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function save() {
    const next = generateFunding(fields);
    try {
      await set.mutateAsync(next);
      // The file reads back normalized (trimmed, list spacing), so a saved field
      // takes that form or it would never match the refetch and retire. A field
      // typed into since the save started keeps the newer text.
      const saved = toFields(next);
      setEdit(
        (e) =>
          e &&
          Object.fromEntries(
            Object.entries(e).map(([k, v]) => [
              k,
              v === fields[k] ? saved[k] : v,
            ]),
          ),
      );
      toast.success("Wrote .github/FUNDING.yml — commit it to publish");
    } catch (e) {
      toastError(e);
    }
  }

  async function remove() {
    if (!exists) return;
    try {
      await del.mutateAsync(undefined);
      // Removing discards the draft by intent; kept, its typed values would
      // reappear over the emptied form as an unsaved edit.
      setEdit(null);
      toast.success("Removed .github/FUNDING.yml — commit it to publish");
      setConfirmingRemove(false);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-xs text-muted-foreground">
        These links power the <span className="font-medium">Sponsor</span>{" "}
        button on your repo. Saving writes{" "}
        <span className="font-mono">.github/FUNDING.yml</span> to your working
        tree — review and commit it like any other change to publish.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="funding-github">GitHub Sponsors</Label>
        <Input
          id="funding-github"
          value={fields[GITHUB_KEY] ?? ""}
          onChange={(e) => setField(GITHUB_KEY, e.target.value)}
          placeholder="username (up to 4, comma-separated)"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {SINGLE_PLATFORMS.map((p) => (
          <div key={p.key} className="space-y-1.5">
            <Label htmlFor={`funding-${p.key}`}>{p.label}</Label>
            <Input
              id={`funding-${p.key}`}
              value={fields[p.key] ?? ""}
              onChange={(e) => setField(p.key, e.target.value)}
              placeholder={p.placeholder}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="funding-custom">Custom URLs</Label>
        <Textarea
          id="funding-custom"
          value={fields[CUSTOM_KEY] ?? ""}
          onChange={(e) => setField(CUSTOM_KEY, e.target.value)}
          placeholder="https://example.com/donate (one per line)"
          rows={2}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        {exists &&
          (confirmingRemove ? (
            <InlineConfirm
              prompt="Remove the Sponsor button?"
              promptClassName="mr-auto text-xs"
              cancelVariant="outline"
              actLabel="Remove"
              pending={del.isPending}
              onCancel={() => setConfirmingRemove(false)}
              onAct={remove}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground"
              onClick={() => setConfirmingRemove(true)}
            >
              Remove sponsor button
            </Button>
          ))}
        <Button disabled={!dirty || set.isPending} onClick={save}>
          {set.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <HeartIcon data-icon="inline-start" />
          )}
          {exists ? "Save changes" : "Add Sponsor button"}
        </Button>
      </div>
    </div>
  );
}
