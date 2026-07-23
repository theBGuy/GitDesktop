import { type ReactNode, useId } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
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
}: {
  label?: ReactNode;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  textareaClassName?: string;
  actions?: ReactNode;
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

export function SelectField({
  label,
  items,
  disabled,
  annotations,
  sizeToContent = false,
}: {
  label?: ReactNode;
  /** value → display label; option order follows the object's key order. */
  items: Record<string, string>;
  disabled?: boolean;
  /** Optional per-option trailing content (e.g. status chips), keyed by value.
   *  Rendered after a truncating label; keys with no entry render label-only.
   *  Never surfaces in the closed trigger — that reads the `items` map. */
  annotations?: Record<string, ReactNode>;
  /** Let the options popup grow to its widest option (floored at the trigger
   *  width, capped at 28rem) instead of clamping to the trigger — for long
   *  values like branch names. Overlong options truncate with an ellipsis. */
  sizeToContent?: boolean;
}) {
  const field = useFieldContext<string>();
  const id = useId();
  // Opt-in rich rows: wrap the label so it can truncate and leave room for a
  // trailing annotation. Plain callers keep the exact prior markup.
  const rich = sizeToContent || annotations !== undefined;
  return (
    <div className="space-y-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Select
        items={items}
        value={field.state.value || null}
        onValueChange={(v) => {
          if (v) field.handleChange(v);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
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
          {Object.entries(items).map(([value, display]) =>
            rich ? (
              <SelectItem key={value} value={value}>
                <span className="min-w-0 flex-1 truncate">{display}</span>
                {annotations?.[value]}
              </SelectItem>
            ) : (
              <SelectItem key={value} value={value}>
                {display}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
