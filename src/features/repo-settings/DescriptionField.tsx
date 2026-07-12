import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** The description field shared by the GitHub, GitLab, and Bitbucket general
 *  sections: a multi-line {@link Textarea} (so long "About" text wraps instead
 *  of clipping mid-word) with an optional {@link generate} slot on the right of
 *  the label row. Each section builds its own Generate button because
 *  `descGen.generate`'s `onResult` differs per provider (GitHub also applies
 *  topics), so the button JSX is passed in rather than owned here. */
export function DescriptionField({
  id,
  value,
  onChange,
  placeholder,
  generate,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  generate?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>Description</Label>
        {generate}
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
    </div>
  );
}
