import { PR_AUDIT_LABEL, PR_AUDIT_TONE, type PrAudit } from "@/lib/pulls/audit";
import { PR_AUDIT_ICON } from "@/lib/pulls/pr-state";
import { cn } from "@/lib/utils";

/**
 * A compact pull-request state chip for the agent audit — **PR open** / **PR
 * closed** / **Merged** / **PR draft**. Icon + text carry the meaning (never color
 * alone, per the WCAG-AA rule); the tone just reinforces it. Shown on plan and
 * session rows and on the session canvas header so a branch's PR/merge state is
 * visible wherever you act on the session.
 */
export function PrAuditChip({ audit }: { audit: PrAudit }) {
  const Icon = PR_AUDIT_ICON[audit.state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium",
        PR_AUDIT_TONE[audit.state],
      )}
      title={
        audit.label === "local"
          ? "Local pull request"
          : `Pull request ${audit.label}`
      }
    >
      <Icon weight="bold" className="size-3" />
      {PR_AUDIT_LABEL[audit.state]}
    </span>
  );
}
