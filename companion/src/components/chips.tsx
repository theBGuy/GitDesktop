import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleIcon,
  ClockIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  RobotIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

// State chips pair an ICON + TEXT so meaning never rests on color alone (WCAG
// 1.4.1). The color is a token (--success / --destructive / --merged / …), the
// same semantics the desktop uses.

function Chip({
  icon,
  label,
  className,
}: {
  icon: ReactNode;
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {icon}
      {label}
    </span>
  );
}

/** A PR's lifecycle chip. `state` is the provider string (open/closed/merged),
 *  `isDraft` overrides an open PR to the muted draft look. */
export function PrStateChip({
  state,
  isDraft,
}: {
  state: string;
  isDraft: boolean;
}) {
  const s = state.toLowerCase();
  if (s === "merged") {
    return (
      <Chip
        icon={<GitMergeIcon size={14} />}
        label="Merged"
        className="bg-merged/15 text-merged"
      />
    );
  }
  if (s === "closed" || s === "declined") {
    return (
      <Chip
        icon={<XCircleIcon size={14} />}
        label="Closed"
        className="bg-destructive/15 text-destructive"
      />
    );
  }
  if (isDraft) {
    return (
      <Chip
        icon={<GitPullRequestIcon size={14} />}
        label="Draft"
        className="bg-muted text-muted-foreground"
      />
    );
  }
  return (
    <Chip
      icon={<GitPullRequestIcon size={14} />}
      label="Open"
      className="bg-success/15 text-success"
    />
  );
}

/** An agent stream's kind chip — an AI PR **review** or an agent **session**.
 *  Icon + text so the distinction never rests on color alone (WCAG 1.4.1). */
export function ReviewKindChip({ kind }: { kind: "review" | "session" }) {
  if (kind === "review") {
    return (
      <Chip
        icon={<MagnifyingGlassIcon size={14} />}
        label="Review"
        className="bg-info/15 text-info"
      />
    );
  }
  return (
    <Chip
      icon={<RobotIcon size={14} />}
      label="Session"
      className="bg-primary/15 text-primary"
    />
  );
}

/**
 * A CI run's status/conclusion chip. GitHub-convention semantics: a completed
 * run shows its `conclusion` (success/failure/…); a still-running one shows its
 * `status` (queued/in_progress/…). Empty conclusion + completed = neutral.
 */
export function CiStatusChip({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string;
}) {
  const done = status.toLowerCase() === "completed";
  if (done) {
    const c = conclusion.toLowerCase();
    if (c === "success") {
      return (
        <Chip
          icon={<CheckCircleIcon size={14} />}
          label="Passed"
          className="bg-success/15 text-success"
        />
      );
    }
    if (c === "failure" || c === "timed_out" || c === "startup_failure") {
      return (
        <Chip
          icon={<XCircleIcon size={14} />}
          label="Failed"
          className="bg-destructive/15 text-destructive"
        />
      );
    }
    if (c === "cancelled") {
      return (
        <Chip
          icon={<ProhibitIcon size={14} />}
          label="Cancelled"
          className="bg-muted text-muted-foreground"
        />
      );
    }
    if (c === "skipped") {
      return (
        <Chip
          icon={<CircleDashedIcon size={14} />}
          label="Skipped"
          className="bg-muted text-muted-foreground"
        />
      );
    }
    return (
      <Chip
        icon={<CircleIcon size={14} />}
        label={conclusion || "Done"}
        className="bg-muted text-muted-foreground"
      />
    );
  }
  // Still running / queued.
  const running = status.toLowerCase() === "in_progress";
  return (
    <Chip
      icon={
        running ? (
          <CircleIcon size={14} weight="fill" />
        ) : (
          <ClockIcon size={14} />
        )
      }
      label={running ? "Running" : "Queued"}
      className="bg-info/15 text-info"
    />
  );
}
