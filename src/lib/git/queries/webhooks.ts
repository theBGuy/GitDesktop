import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { WebhookInput } from "../types";

const webhooksKey = (repo: string) => ["repo", repo, "webhooks"] as const;

export function useWebhooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: webhooksKey(repo),
    queryFn: () => api.ghHooksList(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

function useWebhookMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // Refetch the list so created/edited hooks and ping/test delivery results
    // (last response) show immediately.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: webhooksKey(repo) }),
  });
}

export function useCreateWebhook(repo: string) {
  return useWebhookMutation(repo, (input: WebhookInput) =>
    api.ghHookCreate(repo, input),
  );
}

export function useUpdateWebhook(repo: string) {
  return useWebhookMutation(repo, (args: { id: number; input: WebhookInput }) =>
    api.ghHookUpdate(repo, args.id, args.input),
  );
}

export function useDeleteWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookDelete(repo, id));
}

export function usePingWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookPing(repo, id));
}

export function useTestWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookTest(repo, id));
}

const deliveriesKey = (repo: string, hookId: number) =>
  ["repo", repo, "webhook-deliveries", hookId] as const;

export function useWebhookDeliveries(
  repo: string,
  hookId: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: deliveriesKey(repo, hookId),
    queryFn: () => api.ghHookDeliveries(repo, hookId),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function useWebhookDelivery(
  repo: string,
  hookId: number,
  deliveryId: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "webhook-delivery", hookId, deliveryId] as const,
    queryFn: () => api.ghHookDelivery(repo, hookId, deliveryId as string),
    // A past delivery is immutable, so it never goes stale once fetched.
    enabled: deliveryId != null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useRedeliverWebhook(repo: string, hookId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.ghHookRedeliver(repo, hookId, deliveryId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveriesKey(repo, hookId) }),
  });
}
