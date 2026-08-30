import { CaretDownIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CustomLanguage } from "@/lib/settings/api";
import { cn } from "@/lib/utils";
import { commonLanguages, languageLabel, supportedLanguages } from "./syntax";

/**
 * Searchable language picker (button + popover). Commits on selection, so it
 * suits both the settings rows and the live in-diff control. Custom languages
 * are surfaced first, then common languages, then the long tail.
 */
export function LanguagePicker({
  value,
  onValueChange,
  customLanguages = [],
  autoLabel,
  onClear,
  triggerClassName,
  open: openProp,
  onOpenChange,
}: {
  /** Selected language id; "" means unset. */
  value: string;
  onValueChange: (lang: string) => void;
  customLanguages?: CustomLanguage[];
  /** Shows a "clear/auto" option at the top of the list when set. */
  autoLabel?: string;
  onClear?: () => void;
  triggerClassName?: string;
  /** Controlled popover state, for callers that open the picker from elsewhere
   *  (a command-palette action). Omit for the built-in uncontrolled behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // The internal state tracks every transition even while controlled, so a
  // caller that stops passing `open` resumes from the state actually on screen.
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  function setOpen(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
  }
  const [query, setQuery] = useState("");

  const customIds = customLanguages.map((c) => c.id).filter(Boolean);
  const customSet = new Set(customIds);
  const common = commonLanguages().filter((l) => !customSet.has(l));
  const commonSet = new Set(common);
  const rest = supportedLanguages().filter(
    (l) => !customSet.has(l) && !commonSet.has(l),
  );

  const labelOf = (name: string) =>
    customLanguages.find((c) => c.id === name)?.name ?? languageLabel(name);

  const q = query.trim().toLowerCase();
  const matches = (l: string) =>
    !q || l.toLowerCase().includes(q) || labelOf(l).toLowerCase().includes(q);

  const groups = [
    { label: "Custom", langs: customIds.filter(matches) },
    { label: "Common", langs: common.filter(matches) },
    { label: "All languages", langs: rest.filter(matches) },
  ].filter((g) => g.langs.length > 0);
  const showAuto = Boolean(autoLabel) && (!q || "auto".includes(q));

  function close() {
    setOpen(false);
    setQuery("");
  }

  const current = value ? labelOf(value) : (autoLabel ?? "Auto");

  function row(lang: string) {
    return (
      <button
        key={lang}
        type="button"
        onClick={() => {
          onValueChange(lang);
          close();
        }}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
          lang === value && "bg-accent/60",
        )}
      >
        <span className="truncate">{labelOf(lang)}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {lang}
        </span>
      </button>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-7 max-w-44 justify-between gap-1.5 font-normal",
              triggerClassName,
            )}
          />
        }
      >
        <span className="truncate">{current}</span>
        <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 gap-0 p-0">
        <div className="border-b p-1">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search languages…"
            className="h-7"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {showAuto && (
            <button
              type="button"
              onClick={() => {
                onClear?.();
                close();
              }}
              className={cn(
                "flex w-full items-center px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                !value && "bg-accent/60",
              )}
            >
              {autoLabel}
            </button>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <p className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {g.label}
              </p>
              {g.langs.map(row)}
            </div>
          ))}
          {groups.length === 0 && !showAuto && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No matching language
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
