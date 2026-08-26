import { useId } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { LanguageStat } from "@/lib/git/types";
import { cn } from "@/lib/utils";

/** GitHub-linguist-ish colors for the makeup bar; unknowns fall back to gray. */
export const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Rust: "#dea584",
  Python: "#3572a5",
  Ruby: "#701516",
  Go: "#00add8",
  Java: "#b07219",
  Kotlin: "#a97bff",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Swift: "#f05138",
  PHP: "#4f5d95",
  CSS: "#663399",
  SCSS: "#c6538c",
  Less: "#1d365d",
  HTML: "#e34c26",
  XML: "#0060ac",
  JSON: "#5b8db8",
  YAML: "#cb171e",
  TOML: "#9c4221",
  Markdown: "#083fa1",
  Shell: "#89e051",
  PowerShell: "#2670be",
  Batch: "#c1f12e",
  SQL: "#e38c00",
  GraphQL: "#e10098",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Lua: "#000080",
  R: "#198ce7",
  Dart: "#00b4ab",
  Elixir: "#6e4a7e",
  Erlang: "#b83998",
  Haskell: "#5e5086",
  Scala: "#c22d40",
  Perl: "#0298c3",
  "Protocol Buffers": "#df7c2e",
  Zig: "#ec915c",
  HCL: "#844fba",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  CMake: "#da3434",
};
const OTHER_COLOR = "#8b949e";

export function langColor(name: string) {
  return LANG_COLORS[name] ?? OTHER_COLOR;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const fmt = (n: number) => n.toLocaleString();

export function DateValue({ date }: { date: string | null }) {
  if (!date) return <span>—</span>;
  return <RelativeTime date={date} />;
}

export function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right text-xs font-medium tabular-nums">
        {children}
      </dd>
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 text-xs font-semibold">{children}</h3>;
}

/** An insight card's "nothing to show" line — shared so a card that decides its own
 *  emptiness reads identically to one the board decides for. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>
  );
}

/** A bordered card for an Insights board panel. */
export function InsightCard({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-2 border bg-card p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Wraps a chart as an accessible `<figure>`: a one-line caption summary and a
 * native `<details>` data-table fallback (the screen-reader path; the Recharts
 * charts also enable `accessibilityLayer` for keyboard point traversal).
 */
export function ChartFigure({
  caption,
  table,
  children,
}: {
  caption: string;
  table?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <figure aria-describedby={id} className="space-y-2">
      {children}
      <figcaption id={id} className="text-[11px] text-muted-foreground">
        {caption}
      </figcaption>
      {table && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Show data table
          </summary>
          <div className="mt-2 max-h-48 overflow-auto">{table}</div>
        </details>
      )}
    </figure>
  );
}

/** Top languages plus everything else folded into one "Other" slice. */
function makeupSlices(languages: LanguageStat[], max = 8): LanguageStat[] {
  const named = languages.filter((l) => l.name !== "Other");
  const other = languages.filter((l) => l.name === "Other");
  const head = named.slice(0, max);
  const tail = [...named.slice(max), ...other];
  if (tail.length === 0) return head;
  const folded = tail.reduce(
    (acc, l) => ({
      ...acc,
      files: acc.files + l.files,
      lines: acc.lines + l.lines,
      bytes: acc.bytes + l.bytes,
    }),
    { name: "Other", files: 0, lines: 0, bytes: 0 },
  );
  return [...head, folded];
}

export function LanguageMakeup({ languages }: { languages: LanguageStat[] }) {
  const slices = makeupSlices(languages);
  const totalLines = slices.reduce((n, l) => n + l.lines, 0);
  if (totalLines === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No text files to break down.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {slices.map((l) => (
          <div
            key={l.name}
            title={l.name}
            style={{
              width: `${(l.lines / totalLines) * 100}%`,
              backgroundColor: langColor(l.name),
            }}
          />
        ))}
      </div>
      <ul className="space-y-0.5">
        {slices.map((l) => (
          <li key={l.name} className="flex items-center gap-2 text-xs">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: langColor(l.name) }}
            />
            <span className="font-medium">{l.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {((l.lines / totalLines) * 100).toFixed(1)}%
            </span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {fmt(l.lines)} lines · {fmt(l.files)}{" "}
              {l.files === 1 ? "file" : "files"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
