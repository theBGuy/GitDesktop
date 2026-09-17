/** A GitLab project webhook. Events are per-hook boolean flags on GitLab —
 *  `events` carries the enabled flag names ("push_events", …). */
export interface GitLabHook {
  id: string;
  url: string;
  events: string[];
  enableSslVerification: boolean;
  /** "executable", or "disabled"/"temporarily_disabled" once GitLab
   *  auto-disables a failing hook. */
  alertStatus: string;
  createdAt: string;
}

/** What the webhook form sends. `token: null` leaves an existing secret
 *  unchanged (GitLab never returns it). */
export interface GitLabHookInput {
  url: string;
  token: string | null;
  enableSslVerification: boolean;
  events: string[];
}

/** One recorded delivery of a GitLab hook, payloads inline. */
export interface GitLabHookDelivery {
  id: string;
  /** e.g. "push_hooks". */
  trigger: string;
  /** The endpoint's HTTP status ("405") or a failure word. */
  responseStatus: string;
  createdAt: string;
  /** Seconds. */
  duration: number;
  requestPayload: string;
  responsePayload: string;
}

/** A Bitbucket repository webhook. Bitbucket has no delivery-log API (no
 *  deliveries feature). */
export interface BitbucketHook {
  uuid: string;
  description: string;
  url: string;
  active: boolean;
  events: string[];
  skipCertVerification: boolean;
}

/** What the Bitbucket webhook form sends. A PUT requires the FULL shape (a
 *  partial PUT 400s), so create and update carry the same fields. */
export interface BitbucketHookInput {
  description: string;
  url: string;
  active: boolean;
  events: string[];
  skipCertVerification: boolean;
}

export interface WebhookConfig {
  url: string;
  /** "json" or "form". */
  contentType: string;
  /** "0" (verify SSL) or "1" (skip verification). */
  insecureSsl: string;
  /** Masked ("********") when a secret is set; absent otherwise. */
  secret: string | null;
}

export interface WebhookLastResponse {
  code: number | null;
  status: string;
  message: string | null;
}

export interface Webhook {
  id: number;
  active: boolean;
  events: string[];
  config: WebhookConfig;
  updatedAt: string;
  lastResponse: WebhookLastResponse;
}

/** New/edited webhook values sent to the backend (camelCase). */
export interface WebhookInput {
  url: string;
  contentType: "json" | "form";
  /** A new secret; null/empty leaves an existing one unchanged. */
  secret: string | null;
  insecureSsl: boolean;
  events: string[];
  active: boolean;
}

/** A past webhook delivery (summary). */
export interface HookDelivery {
  /** A 19-digit snowflake — string, since it exceeds JS's safe integer range. */
  id: string;
  deliveredAt: string;
  redelivery: boolean;
  duration: number;
  status: string;
  statusCode: number;
  event: string;
  action: string | null;
}

/** One delivery's request payload + response body. */
export interface HookDeliveryDetail {
  requestPayload: string;
  responsePayload: string;
}
