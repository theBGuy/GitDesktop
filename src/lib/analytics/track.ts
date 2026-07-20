import { posthog } from "./posthog";
import { scrubError } from "./scrub-error";

// ---------------------------------------------------------------------------
// Event schema — only these events and properties are ever sent.
// Content-free: no paths, filenames, branch names, diff text, URLs, or secrets.
// ---------------------------------------------------------------------------

export type AnalyticsEvent =
  | { name: "screen_viewed"; properties: { screen: string } }
  | {
      name: "repo_opened";
      properties: { source: "recent" | "clone" | "create" | "picker" };
    }
  | {
      name: "commit_created";
      properties: {
        file_count: number;
        has_ai_message: boolean;
        has_co_authors: boolean;
      };
    }
  | {
      name: "pull_request_created";
      properties: {
        is_draft: boolean;
        has_ai_description: boolean;
        has_review_notes: boolean;
      };
    }
  | {
      name: "ai_review_triggered";
      properties: { provider: string; model_tier: string };
    }
  | {
      name: "error_caught";
      properties: { error_kind: string; fatal: boolean; message: string };
    };

export function track(event: AnalyticsEvent): void {
  try {
    // posthog is null until initAnalytics lazy-loads it; events before then
    // (or with analytics disabled) are dropped.
    posthog?.capture(event.name, event.properties);
  } catch {
    // Never let analytics break the app.
  }
}

// Errors already reported, tracked by object identity, so a React error
// boundary and the global window error/unhandledrejection handlers don't
// double-count the same failure (React re-dispatches boundary-caught errors to
// window.onerror). WeakSet so reported errors can still be garbage-collected.
const reportedErrors = new WeakSet<object>();

/**
 * Report a caught/uncaught error to analytics exactly once. The first report
 * for a given error object wins — the boundary (fatal: true) runs before the
 * re-dispatched window event (fatal: false), so the accurate one is kept.
 */
export function trackCaughtError(error: unknown, fatal: boolean): void {
  if (typeof error === "object" && error !== null) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  const { message, kind } = scrubError(error);
  track({
    name: "error_caught",
    properties: { error_kind: kind, fatal, message },
  });
}
