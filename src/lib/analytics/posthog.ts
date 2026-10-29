import { load } from "@tauri-apps/plugin-store";
import type { PostHog } from "posthog-js";
import { storeLoadOptions } from "@/lib/plugin-store";
import { COLD_START, storeName } from "@/lib/test-mode";

/**
 * Public privacy-policy URL. Set this once the policy is hosted; the UI hides
 * the link while it's empty so we never ship a dead link.
 */
export const PRIVACY_POLICY_URL = "https://gitdesktop.app/privacy";

let initialized = false;
// posthog-js (~190KB) is imported lazily on first init so it stays off the boot
// path; null until initAnalytics loads it. track() and the sync/reset helpers
// no-op while it's null.
let posthog: PostHog | null = null;

function analyticsStore() {
  return load(storeName("analytics.json"), storeLoadOptions("analytics.json"));
}

async function getDistinctId(): Promise<string> {
  const store = await analyticsStore();
  let id = await store.get<string>("distinct_id");
  if (!id) {
    id = crypto.randomUUID();
    await store.set("distinct_id", id);
  }
  return id;
}

export async function initAnalytics(
  enabled: boolean,
  replay: boolean,
): Promise<void> {
  if (initialized) return;
  if (!enabled || COLD_START) return;

  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
  if (!key || !host) {
    // The .env is gitignored, so release builds must inject these (see
    // .env.example). Surface it here rather than going silently dark.
    console.info(
      "[analytics] disabled — VITE_POSTHOG_KEY/VITE_POSTHOG_HOST not set at build time.",
    );
    return;
  }

  // Mark initialized only once we commit to init, so a launch with analytics
  // disabled (or missing key) can still be turned on later at runtime.
  initialized = true;
  const distinctId = await getDistinctId();

  // The dashboard host mirrors the ingestion host without the "i." ingestion
  // subdomain (eu.i.posthog.com -> eu.posthog.com), so switching region is a
  // pure VITE_POSTHOG_HOST change. Non-cloud/self-hosted hosts pass through.
  const uiHost = host.replace(".i.posthog.com", ".posthog.com");

  // Load posthog-js now (not at module load) to keep it out of the boot bundle.
  const { default: ph } = await import("posthog-js");
  posthog = ph;

  ph.init(key, {
    api_host: host,
    ui_host: uiHost,
    // Anonymous-only: never create person profiles or send PII. The device's
    // random UUID is the distinct_id, set via bootstrap — no identify() call
    // (which would warn and no-op under "never").
    person_profiles: "never",
    autocapture: true,
    // mask_all_text / mask_all_element_attributes are honored at runtime
    // (untyped in this version) — they mask autocapture element text/attrs.
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_pageview: false,
    capture_pageleave: false,
    // No network/perf capture at all (payloads are off by default; this also
    // drops timing) so request URLs/bodies never reach a recording.
    capture_performance: false,
    // Replay is opt-in (GDPR/ePrivacy): never auto-start it. startSessionRecording()
    // runs only after explicit consent (the recordReplay setting).
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
      blockSelector: ".ph-no-capture",
    },
    sanitize_properties(props) {
      delete props.$current_url;
      delete props.$pathname;
      delete props.$referrer;
      delete props.$referring_domain;
      return props;
    },
    bootstrap: { distinctID: distinctId },
  });

  if (replay) ph.startSessionRecording();
}

/**
 * Reconcile capture (anonymous events, opt-out) and session replay (opt-in)
 * with the user's current settings. Called at boot and whenever either changes.
 */
export async function syncAnalytics(
  enabled: boolean,
  replay: boolean,
): Promise<void> {
  if (!enabled) {
    if (initialized) posthog?.opt_out_capturing(); // stops events + recording
    return;
  }
  if (!initialized) {
    await initAnalytics(true, replay);
    return;
  }
  posthog?.opt_in_capturing();
  if (replay) posthog?.startSessionRecording();
  else posthog?.stopSessionRecording();
}

/**
 * Data-subject control: rotate the anonymous id and reset PostHog state so the
 * user is unlinkable from their prior events/recordings going forward.
 */
export async function resetAnalyticsId(): Promise<void> {
  const store = await analyticsStore();
  await store.set("distinct_id", crypto.randomUUID());
  if (initialized) posthog?.reset();
}

export { posthog };
