import { invoke } from "@/lib/tauri/invoke";
import type {
  BitbucketHook,
  BitbucketHookInput,
  GitLabHook,
  GitLabHookDelivery,
  GitLabHookInput,
  HookDelivery,
  HookDeliveryDetail,
  Webhook,
  WebhookInput,
} from "../types";

export const forgeGlHooks = (repoPath: string) =>
  invoke<GitLabHook[]>("forge_gl_hooks", { repoPath });

export const forgeGlHookCreate = (repoPath: string, input: GitLabHookInput) =>
  invoke<void>("forge_gl_hook_create", { repoPath, input });

export const forgeGlHookUpdate = (
  repoPath: string,
  hookId: string,
  input: GitLabHookInput,
) => invoke<void>("forge_gl_hook_update", { repoPath, hookId, input });

export const forgeGlHookDelete = (repoPath: string, hookId: string) =>
  invoke<void>("forge_gl_hook_delete", { repoPath, hookId });

export const forgeGlHookTest = (
  repoPath: string,
  hookId: string,
  trigger: string,
) => invoke<void>("forge_gl_hook_test", { repoPath, hookId, trigger });

export const forgeGlHookEvents = (repoPath: string, hookId: string) =>
  invoke<GitLabHookDelivery[]>("forge_gl_hook_events", { repoPath, hookId });

export const forgeGlHookResend = (
  repoPath: string,
  hookId: string,
  eventId: string,
) => invoke<void>("forge_gl_hook_resend", { repoPath, hookId, eventId });

export const forgeBbHooks = (repoPath: string) =>
  invoke<BitbucketHook[]>("forge_bb_hooks", { repoPath });

export const forgeBbHookCreate = (
  repoPath: string,
  input: BitbucketHookInput,
) => invoke<void>("forge_bb_hook_create", { repoPath, input });

export const forgeBbHookUpdate = (
  repoPath: string,
  uuid: string,
  input: BitbucketHookInput,
) => invoke<void>("forge_bb_hook_update", { repoPath, uuid, input });

export const forgeBbHookDelete = (repoPath: string, uuid: string) =>
  invoke<void>("forge_bb_hook_delete", { repoPath, uuid });

export const ghHooksList = (repoPath: string) =>
  invoke<Webhook[]>("gh_hooks_list", { repoPath });

export const ghHookCreate = (repoPath: string, input: WebhookInput) =>
  invoke<Webhook>("gh_hook_create", { repoPath, input });

export const ghHookUpdate = (
  repoPath: string,
  id: number,
  input: WebhookInput,
) => invoke<Webhook>("gh_hook_update", { repoPath, id, input });

export const ghHookDelete = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_delete", { repoPath, id });

export const ghHookPing = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_ping", { repoPath, id });

export const ghHookTest = (repoPath: string, id: number) =>
  invoke<void>("gh_hook_test", { repoPath, id });

export const ghHookDeliveries = (repoPath: string, hookId: number) =>
  invoke<HookDelivery[]>("gh_hook_deliveries", { repoPath, hookId });

export const ghHookDelivery = (
  repoPath: string,
  hookId: number,
  deliveryId: string,
) =>
  invoke<HookDeliveryDetail>("gh_hook_delivery", {
    repoPath,
    hookId,
    deliveryId,
  });

export const ghHookRedeliver = (
  repoPath: string,
  hookId: number,
  deliveryId: string,
) => invoke<void>("gh_hook_redeliver", { repoPath, hookId, deliveryId });
