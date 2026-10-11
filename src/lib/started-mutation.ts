// Bare specifiers only: scripts/started-mutation.test.mjs loads this module under
// Node's type stripping, which resolves no "@/" aliases.
import {
  type DefaultError,
  type MutationFunctionContext,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  useMutation as useReactQueryMutation,
} from "@tanstack/react-query";
import { useMemo } from "react";

/** The `meta` key holding the options a mutation started with. Reserved:
 *  wrapping throws on any caller's own `meta` that uses it. A string, since
 *  `MutationMeta` is a string-keyed record. */
export const STARTED_KEY = "gitdesktop.started";

/** Options {@link startedMutationOptions} returned, handed back unchanged when
 *  wrapped again: a re-wrap would snapshot a trampoline that reads its own
 *  snapshot and recurses until the stack overflows. */
const wrapped = new WeakSet<object>();
const remember = <T extends object>(options: T): T => {
  wrapped.add(options);
  return options;
};

/**
 * `options` with its `mutationFn` and lifecycle callbacks taken from the options
 * in effect when each mutation STARTED (the observer's at the `mutate` call). A
 * mounted observer re-rendered with new options replaces its pending mutation's
 * options, but query-core builds the `MutationFunctionContext` once per execution
 * and hands that same object to the `mutationFn` and every option callback (a
 * per-call `mutate(v, { onSuccess })` callback gets a context built from the
 * observer's current options, and is fixed at the call anyway); the snapshot
 * rides its `meta`, so no later render can change what a running or parked write
 * calls. Only the mutationFn and the four option callbacks are snapshotted:
 * query-core reads `scope` and `gcTime` off the mutation's live options, so a
 * `scope.id` derived from render state would follow a switch. Every trampoline
 * is installed even when `options` lacks that callback, so a later render cannot
 * add or drop one mid-flight. Each returns its target's result unchanged:
 * `onMutate`'s is the mutation context, and a promise from `onSuccess` is awaited
 * before the mutation settles. They shadow any `defaultOptions.mutations`
 * callback or `setMutationDefaults` mutationFn, which the `mutation-defaults`
 * check in scripts/check-banned-patterns.mjs bans.
 */
export function startedMutationOptions<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
): UseMutationOptions<TData, TError, TVariables, TOnMutateResult> {
  if (wrapped.has(options)) return options;
  // A copy of wrapped options (spread, then edited) carries the key too, and
  // would recurse the same way.
  if (options.meta?.[STARTED_KEY] !== undefined)
    throw new Error(
      `meta key "${STARTED_KEY}" is reserved for @/lib/started-mutation: pass the original options, not a copy of wrapped ones`,
    );
  const startedOf = (context: MutationFunctionContext) => {
    const started = context.meta?.[STARTED_KEY];
    if (started === undefined)
      throw new Error(
        "This mutation has no started-options snapshot in its meta: build mutations only through @/lib/started-mutation, without replacing their meta",
      );
    return started as typeof options;
  };
  return remember({
    ...options,
    meta: { ...options.meta, [STARTED_KEY]: options },
    mutationFn: (variables, context) => {
      const { mutationFn } = startedOf(context);
      // query-core's own rejection for options that carry no mutationFn.
      return mutationFn
        ? mutationFn(variables, context)
        : Promise.reject(new Error("No mutationFn found"));
    },
    onMutate: (variables, context) =>
      startedOf(context).onMutate?.(variables, context) as
        | Promise<TOnMutateResult>
        | TOnMutateResult,
    onSuccess: (data, variables, onMutateResult, context) =>
      startedOf(context).onSuccess?.(data, variables, onMutateResult, context),
    onError: (error, variables, onMutateResult, context) =>
      startedOf(context).onError?.(error, variables, onMutateResult, context),
    onSettled: (data, error, variables, onMutateResult, context) =>
      startedOf(context).onSettled?.(
        data,
        error,
        variables,
        onMutateResult,
        context,
      ),
  });
}

/** react-query's `useMutation` through {@link startedMutationOptions}: the only
 *  way this app constructs a mutation. Memoized on the `options` identity, so the
 *  observer's `setOptions` effect fires exactly as often as it would for
 *  `options` itself. */
export function useMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
  queryClient?: QueryClient,
): UseMutationResult<TData, TError, TVariables, TOnMutateResult> {
  const started = useMemo(() => startedMutationOptions(options), [options]);
  return useReactQueryMutation(started, queryClient);
}
