import { type ComponentProps, type ReactNode, useEffect, useId } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { SelectClipText } from "@/components/select-clip-text";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import { clipTitleFromText } from "@/lib/clip-title";
import { useFieldContext } from "@/lib/form-context";

/**
 * Bound form fields (used as `<field.TextField …/>` inside
 * `<form.AppField>`). Validation follows the app's quiet style: validators
 * gate the submit button; the only inline text is the optional `warning` —
 * a non-blocking hint, e.g. "Will be created as my-branch".
 */

function FieldWarning({
  value,
  warning,
}: {
  value: string;
  warning?: (value: string) => string | null;
}) {
  const message = warning?.(value);
  if (!message) return null;
  return <p className="text-xs text-warning">{message}</p>;
}

export function TextField({
  label,
  placeholder,
  type,
  autoFocus,
  disabled,
  className,
  warning,
  id,
}: {
  label?: ReactNode;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
  warning?: (value: string) => string | null;
  /** Override the auto-generated input id — for call sites that render their
   *  own label outside the field and need to target the input via `htmlFor`. */
  id?: string;
}) {
  const field = useFieldContext<string>();
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="space-y-2">
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <Input
        id={inputId}
        type={type}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        className={className}
        autoComplete="off"
        value={field.state.value}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
      />
      <FieldWarning value={field.state.value} warning={warning} />
    </div>
  );
}

export function TextareaField({
  label,
  placeholder,
  rows,
  disabled,
  className,
}: {
  label?: ReactNode;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  return (
    <div className="space-y-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Textarea
        id={id}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
        value={field.state.value}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
      />
    </div>
  );
}

export function MarkdownField({
  label,
  placeholder,
  rows,
  disabled,
  textareaClassName,
  actions,
  mentions,
}: {
  label?: ReactNode;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  textareaClassName?: string;
  actions?: ReactNode;
  /** Opt in to `@`/`#`/`!` autocomplete — only forms whose forge autolinks the
   *  completed reference pass one. */
  mentions?: MentionSource;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  return (
    <div className="space-y-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <MarkdownEditor
        id={id}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        textareaClassName={textareaClassName}
        actions={actions}
        mentions={mentions}
        value={field.state.value}
        onChange={field.handleChange}
      />
    </div>
  );
}

export function CheckboxField({
  label,
  disabled,
  className,
}: {
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const field = useFieldContext<boolean>();
  return (
    <label
      className={
        className ??
        "flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
      }
    >
      <Checkbox
        checked={field.state.value}
        disabled={disabled}
        onCheckedChange={(checked) => field.handleChange(checked === true)}
        onBlur={field.handleBlur}
      />
      {label}
    </label>
  );
}

/** The presentational half of {@link SelectField}: label + items-mapped select,
 *  driven by a plain value/onChange pair. Split out so surfaces with no bound
 *  form field (e.g. a picker injected into a dialog's slot) get the same control
 *  instead of re-implementing it. */
export function SelectControl({
  label,
  items,
  value,
  onValueChange,
  disabled,
  disabledItems,
  order,
  annotations,
  sizeToContent = false,
}: {
  label?: ReactNode;
  /** value → display label; rendered in the object's key order unless `order`
   *  overrides it. */
  items: Record<string, string>;
  /** The selected key; "" (or a key absent from `items`) shows no selection. */
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** Option keys rendered as disabled rows — unselectable and skipped by
   *  typeahead, though arrow-key highlight still visits them (aria-disabled). */
  disabledItems?: ReadonlySet<string>;
  /** Explicit option order. `items` is an object, so integer-like keys sort
   *  ahead of the rest whatever order it was built in — any caller whose values
   *  can be all-digits (logins, slugs) passes the order it means. Must hold
   *  exactly the keys of `items`, no extras or duplicates. */
  order?: readonly string[];
  /** Optional per-option trailing content (e.g. status chips), keyed by value.
   *  Rendered after a truncating label; keys with no entry render label-only.
   *  Never surfaces in the closed trigger — that reads the `items` map. */
  annotations?: Record<string, ReactNode>;
  /** Let the options popup grow to its widest option (floored at the trigger
   *  width, capped at 28rem) instead of clamping to the trigger — for long
   *  values like branch names. Overlong options truncate with an ellipsis. */
  sizeToContent?: boolean;
}) {
  const id = useId();
  // Opt-in rich rows: wrap the label so it can truncate and leave room for a
  // trailing annotation. Plain callers keep the exact prior markup.
  const rich = sizeToContent || annotations !== undefined;
  const entries: [string, string][] = order
    ? order.map((optionValue) => [
        optionValue,
        items[optionValue] ?? optionValue,
      ])
    : Object.entries(items);
  // A mismatched `order` is never repaired here: a key it omits is dropped, a key
  // only it holds renders its raw value as the label, and nothing is reordered —
  // silently fixing a caller's bug would hide a wrong list from the user. Today's
  // callers derive `order` and `items` from one source, so this guards future ones.
  // In an effect, not the render body (StrictMode double-invokes render); the
  // literal `import.meta.env.DEV` leads the `&&` so Vite drops the whole block.
  useEffect(() => {
    if (import.meta.env.DEV && order) {
      const missing = Object.keys(items).filter((k) => !order.includes(k));
      const extra = order.filter((k) => !(k in items));
      const duplicate = order.filter((k, i) => order.indexOf(k) !== i);
      if (missing.length || extra.length || duplicate.length) {
        console.warn("SelectControl: `order` does not match `items`", {
          label,
          missing,
          extra,
          duplicate,
        });
      }
    }
  }, [items, order, label]);
  return (
    <div className="space-y-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Select
        items={items}
        value={value || null}
        onValueChange={(v) => {
          if (v) onValueChange(v);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue onMouseEnter={clipTitleFromText} />
        </SelectTrigger>
        <SelectContent
          {...(sizeToContent
            ? {
                // Break free of the trigger-anchored width so the list can size
                // to its longest option (min = trigger width, max = 28rem).
                alignItemWithTrigger: false,
                className: "w-auto min-w-(--anchor-width) max-w-[28rem]",
              }
            : {})}
        >
          {entries.map(([optionValue, display]) =>
            rich ? (
              <SelectItem
                key={optionValue}
                value={optionValue}
                disabled={disabledItems?.has(optionValue)}
                // The vendored ItemText wrapper is `flex-1 shrink-0` and its
                // intrinsic floor grows with its nowrap content, so a `truncate`
                // child never clips; letting the item's first child shrink is
                // what ellipsizes the label while the popup still sizes to its
                // widest option. Tag-agnostic on purpose: the element type is
                // Base UI's to change, only the first-child position is ours.
                className="*:first:min-w-0 *:first:shrink"
              >
                <span
                  className="min-w-0 flex-1 truncate"
                  onMouseEnter={clipTitleFromText}
                >
                  {display}
                </span>
                {annotations?.[optionValue]}
              </SelectItem>
            ) : (
              <SelectItem
                key={optionValue}
                value={optionValue}
                disabled={disabledItems?.has(optionValue)}
              >
                <SelectClipText>{display}</SelectClipText>
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/** {@link SelectControl} driven by the enclosing bound form field — see there
 *  for what each prop does. */
export function SelectField({
  label,
  items,
  disabled,
  disabledItems,
  order,
  annotations,
  sizeToContent = false,
}: Omit<ComponentProps<typeof SelectControl>, "value" | "onValueChange">) {
  const field = useFieldContext<string>();
  return (
    <SelectControl
      label={label}
      items={items}
      value={field.state.value}
      onValueChange={(v) => field.handleChange(v)}
      disabled={disabled}
      disabledItems={disabledItems}
      order={order}
      annotations={annotations}
      sizeToContent={sizeToContent}
    />
  );
}
