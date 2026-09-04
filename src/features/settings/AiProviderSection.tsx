import {
  CheckCircleIcon,
  CopyIcon,
  PlusIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { type AgentKind, detectAgentCli, providerKind } from "@/lib/ai/agent";
import {
  entryMatchesUrl,
  isHostAllowed,
  normalizeHost,
} from "@/lib/ai/allowed-hosts";
import { LOGIN_COMMAND } from "@/lib/ai/cli-client";
import { createAiClient } from "@/lib/ai/client";
import type { ReviewContextSize } from "@/lib/ai/context-budget";
import { modelPickerEmptyText, useAvailableModels } from "@/lib/ai/models";
import {
  ALL_PROVIDER_IDS,
  defaultModelForProvider,
  GENERATION_PROVIDER_IDS,
  GOOGLE_AI_STUDIO_KEYS_URL,
  isCliProvider,
  OPENAI_COMPATIBLE_PRESETS,
  PROVIDER_LABELS,
  PROVIDERS_REQUIRING_KEY,
} from "@/lib/ai/providers";
import { REVIEW_TIMEOUTS, type ReviewTimeout } from "@/lib/ai/review-timeout";
import type { AiProviderId, AiSettings } from "@/lib/ai/types";
import { required, useAppForm, withForm } from "@/lib/form";
import { deleteSecret, setSecret } from "@/lib/git/api";
import { settingsKeys, useSecretPreview } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AgentSandboxField } from "./AgentSandboxField";
import { HostAllowNote } from "./HostAllowNote";
import { settingsFormOpts } from "./settings-form";

/** Typical key shapes per provider; used for a soft warning, never to block. */
const KEY_HINTS: Partial<
  Record<AiProviderId, { prefix: string; minLength: number }>
> = {
  openai: { prefix: "sk-", minLength: 40 },
  anthropic: { prefix: "sk-ant-", minLength: 40 },
  openrouter: { prefix: "sk-or-", minLength: 40 },
  // No google entry: AI Studio issues both legacy `AIza…` keys and current `AQ.…`
  // auth keys, so any single-prefix hint false-warns on a working key.
};

function keyShapeWarning(provider: AiProviderId, value: string): string | null {
  const hint = KEY_HINTS[provider];
  if (!hint || !value.trim()) return null;
  const v = value.trim();
  if (v.startsWith(hint.prefix) && v.length >= hint.minLength) return null;
  return `Doesn't look like a ${PROVIDER_LABELS[provider]} key (expected "${hint.prefix}…"). You can still save it.`;
}

/**
 * Provider + model picker pair, shared by the generation and review model
 * blocks. Edits are draft-local; switching provider remembers the model you
 * had chosen for each provider and restores it when you switch back.
 */
function ModelPicker({
  idPrefix,
  value,
  onChange,
  providerIds,
  allowedHosts,
}: {
  idPrefix: string;
  value: AiSettings;
  onChange: (next: AiSettings) => void;
  providerIds: AiProviderId[];
  allowedHosts: string[];
}) {
  const keyPreview = useSecretPreview(value.provider);
  const isCli = isCliProvider(value.provider);
  // Listing a CLI's catalog spawns it, so a CLI provider's probe waits for the
  // user to reach the picker — sticky, matching the session and PR-review
  // pickers. HTTP providers keep fetching eagerly: reaching Settings → AI is
  // itself the intent, and the cost is a GET, not a subprocess.
  const [modelsWanted, setModelsWanted] = useState(false);
  const availableModels = useAvailableModels(
    value,
    Boolean(keyPreview.data),
    allowedHosts,
    { enabled: !isCli || modelsWanted },
  );
  const catalog = availableModels.data;
  const models = catalog?.models ?? [];
  const modelMemory = useRef<Partial<Record<AiProviderId, string>>>({});
  // Only a failed fetch carries unbounded provider prose, so it alone is clamped and
  // given a tooltip; every other line is short enough to render whole.
  const failureReason =
    catalog?.cause === "failed" ? catalog.reason : undefined;
  // Each fallback route reads differently to a user, and the predicates are
  // heterogeneous (provider kind, then query state, then the catalog's own
  // cause) — a saved-but-rejected key must never be told to save a key.
  const hint = ((): string => {
    switch (true) {
      // Derived, not a provider literal: a CLI with a live catalog (opencode)
      // falls through to the loading/live branches like an HTTP provider — and
      // a failed probe falls through so its reason surfaces.
      case isCli &&
        catalog?.live !== true &&
        catalog?.cause !== "failed" &&
        !availableModels.isFetching:
        return "Model passed to the CLI — leave blank for its default";
      // A settled live list outranks an in-flight refetch: an HTTP provider's
      // background refetch (staleTime + focus refetch) keeps its `live` data, so
      // "Loading…" must not flash over the shown count. First load and a provider
      // switch both change the query key, so `live` is false on the placeholder
      // and the loading case still wins there.
      case catalog?.live === true:
        return `${models.length} models from ${PROVIDER_LABELS[value.provider]}`;
      case availableModels.isFetching:
        return "Loading models…";
      case failureReason !== undefined:
        return `Suggestions only — couldn't load the live list: ${failureReason}`;
      case catalog?.cause === "empty":
        return "Suggestions only — the provider returned no models";
      case catalog?.cause === "no-base":
        return "Suggestions only — set a base URL to load the live list";
      case catalog?.cause === "no-key":
        return "Suggestions only — save an API key to load the live list";
      default:
        return "Suggestions only — provider list unavailable";
    }
  })();

  function switchProvider(provider: AiProviderId) {
    modelMemory.current[value.provider] = value.model;
    onChange({
      ...value,
      provider,
      model: modelMemory.current[provider] ?? defaultModelForProvider(provider),
    });
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        <Select
          items={PROVIDER_LABELS}
          value={value.provider}
          onValueChange={(v) => {
            if (v) switchProvider(v as AiProviderId);
          }}
        >
          <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerIds.map((id) => (
              <SelectItem key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <Combobox
          items={models}
          inputValue={value.model}
          onInputValueChange={(model) => onChange({ ...value, model })}
          // UNCLAMPED on purpose: Base UI syncs the input to the selected item's
          // label as the popup finishes closing, and a null selection syncs it
          // to "" — clamping to the catalog would wipe a typed id on close.
          value={value.model || null}
          onValueChange={(model) => {
            if (model) onChange({ ...value, model });
          }}
          openOnInputClick
          onOpenChange={(open) => {
            if (open) setModelsWanted(true);
          }}
        >
          <ComboboxInput
            id={`${idPrefix}-model`}
            className="w-full"
            placeholder={
              defaultModelForProvider(value.provider) || "Account default"
            }
            onFocus={() => setModelsWanted(true)}
          />
          <ComboboxContent>
            <ComboboxEmpty>
              {modelPickerEmptyText(availableModels.isFetching)}
            </ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  <span className="truncate font-mono">{item}</span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <p
          className={cn(
            "text-xs text-muted-foreground",
            failureReason !== undefined && "line-clamp-2",
          )}
          title={failureReason !== undefined ? hint : undefined}
        >
          {hint}
        </p>
      </div>
    </div>
  );
}

/**
 * Detection + optional binary-path override for a CLI provider (generation or
 * review). Shows whether the CLI is installed and signed in, since there's no
 * API key to save. `idPrefix` keeps the input id unique when both the generation
 * and review pickers have a CLI selected — load-bearing for ARIA correctness
 * (duplicate DOM ids), so never default or remove it; `description` carries the
 * surface-specific footer copy.
 */
function CliProviderConfig({
  idPrefix,
  value,
  onChange,
  description,
}: {
  idPrefix: string;
  value: AiSettings;
  onChange: (next: AiSettings) => void;
  description: ReactNode;
}) {
  const kind = providerKind(value.provider);
  const detect = useQuery({
    queryKey: ["agent-detect", value.provider, value.cliPath ?? ""],
    queryFn: () => detectAgentCli(kind!, value.cliPath),
    enabled: Boolean(kind),
    staleTime: 60_000,
  });
  const info = detect.data;
  const version = info?.version ? ` (${info.version})` : "";

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-cli-path`}>
        CLI path{" "}
        <span className="font-normal text-muted-foreground">(optional)</span>
      </Label>
      <Input
        id={`${idPrefix}-cli-path`}
        autoComplete="off"
        placeholder="Auto-detect on PATH"
        value={value.cliPath ?? ""}
        onChange={(e) => onChange({ ...value, cliPath: e.target.value })}
      />
      <div className="text-xs">
        {detect.isPending ? (
          <span className="text-muted-foreground">
            Checking for {PROVIDER_LABELS[value.provider]}…
          </span>
        ) : info?.found && info.authed === "notAuthed" ? (
          <span className="flex items-center gap-1 text-warning">
            <XCircleIcon className="size-4 shrink-0" />
            Found{version} but not signed in — run{" "}
            <code className="font-mono">{LOGIN_COMMAND[kind ?? "claude"]}</code>
            .
          </span>
        ) : info?.found ? (
          <span className="flex items-center gap-1 text-success">
            <CheckCircleIcon className="size-4 shrink-0" />
            Found{version}
            {info.authed === "authed" ? " — signed in" : ""}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-destructive">
            <XCircleIcon className="size-4 shrink-0" />
            Not found — install it or set the path above.
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** Labels for the OpenAI-compatible preset select — the presets plus the manual
 *  "Custom…" escape. Trigger and popup both render from here, so the two can
 *  never drift. */
const PRESET_ITEMS: Record<string, string> = {
  ...Object.fromEntries(OPENAI_COMPATIBLE_PRESETS.map((p) => [p.id, p.label])),
  custom: "Custom…",
};

/** Review-context-size labels — passed to Select as `items` so the trigger
 *  renders the label, not the raw value (Base UI SelectValue needs the map). */
const REVIEW_CONTEXT_ITEMS: Record<ReviewContextSize, string> = {
  auto: "Auto — fit the model",
  small: "Compact (0.5×)",
  medium: "Standard (1×)",
  large: "Expanded (4×)",
};

/** Review-timeout labels — same `items` contract as REVIEW_CONTEXT_ITEMS above
 *  (Base UI SelectValue renders the raw value without the map). */
const REVIEW_TIMEOUT_ITEMS: Record<ReviewTimeout, string> = {
  auto: "Auto — 5 min, 20 min agentic",
  "10": "10 minutes",
  "15": "15 minutes",
  "20": "20 minutes",
  "30": "30 minutes",
  "45": "45 minutes",
  "60": "60 minutes",
};

/** Default-agent labels — same `items` contract as the maps above. "auto" is the
 *  UI stand-in for an absent `defaultAgent` (follow the AI provider). */
const DEFAULT_AGENT_ITEMS: Record<"auto" | AgentKind, string> = {
  auto: "Auto — follow the AI provider",
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "opencode",
};

/** Ollama base-URL field — the URL the local/LAN Ollama server is reached at. */
function OllamaConfig({
  idPrefix,
  value,
  onChange,
  allowedHosts,
  onAllowHost,
}: {
  idPrefix: string;
  value: AiSettings;
  onChange: (next: AiSettings) => void;
  allowedHosts: string[];
  onAllowHost: (url: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-ollama-url`}>Ollama URL</Label>
      <Input
        id={`${idPrefix}-ollama-url`}
        autoComplete="off"
        placeholder="http://localhost:11434"
        value={value.ollamaBaseUrl}
        onChange={(e) => onChange({ ...value, ollamaBaseUrl: e.target.value })}
      />
      <HostAllowNote
        url={value.ollamaBaseUrl}
        allowedHosts={allowedHosts}
        onAllowHost={onAllowHost}
        defaultNote="Point at a local or LAN Ollama server."
      />
    </div>
  );
}

/**
 * Base-URL + preset picker for the `openai-compatible` provider. Choosing a preset
 * fills the base URL (and a default model); the URL stays editable for any other
 * OpenAI-compatible endpoint. A host outside the built-in presets must be allowed.
 */
function OpenAiCompatibleConfig({
  idPrefix,
  value,
  onChange,
  allowedHosts,
  onAllowHost,
}: {
  idPrefix: string;
  value: AiSettings;
  onChange: (next: AiSettings) => void;
  allowedHosts: string[];
  onAllowHost: (url: string) => void;
}) {
  const base = value.openaiCompatibleBaseUrl.replace(/\/$/, "");
  const current = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === base);
  const presetId = current?.id ?? "custom";

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-oai-compat-preset`}>Service</Label>
        <Select
          items={PRESET_ITEMS}
          value={presetId}
          onValueChange={(id) => {
            const p = OPENAI_COMPATIBLE_PRESETS.find((x) => x.id === id);
            if (p) {
              onChange({
                ...value,
                openaiCompatibleBaseUrl: p.baseUrl,
                model: p.models[0] ?? value.model,
              });
            }
          }}
        >
          <SelectTrigger
            id={`${idPrefix}-oai-compat-preset`}
            className="w-full"
          >
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PRESET_ITEMS).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-oai-compat-url`}>Base URL</Label>
        <Input
          id={`${idPrefix}-oai-compat-url`}
          autoComplete="off"
          placeholder="https://…/v1"
          value={value.openaiCompatibleBaseUrl}
          onChange={(e) =>
            onChange({ ...value, openaiCompatibleBaseUrl: e.target.value })
          }
        />
      </div>

      <div className="col-span-2">
        <HostAllowNote
          url={value.openaiCompatibleBaseUrl}
          allowedHosts={allowedHosts}
          onAllowHost={onAllowHost}
          defaultNote={
            <>
              Any OpenAI-compatible{" "}
              <code className="font-mono">/chat/completions</code> endpoint.{" "}
              {current?.keysUrl
                ? `Get an API key at ${current.keysUrl}.`
                : null}
            </>
          }
        />
      </div>
    </div>
  );
}

/** The provider-specific URL config (Ollama URL or OpenAI-compatible base URL),
 *  shared by the generation and review model blocks. Renders nothing for a
 *  provider with a fixed host. */
function ProviderUrlConfig({
  idPrefix,
  value,
  onChange,
  allowedHosts,
  onAllowHost,
}: {
  idPrefix: string;
  value: AiSettings;
  onChange: (next: AiSettings) => void;
  allowedHosts: string[];
  onAllowHost: (url: string) => void;
}) {
  if (value.provider === "ollama") {
    return (
      <OllamaConfig
        idPrefix={idPrefix}
        value={value}
        onChange={onChange}
        allowedHosts={allowedHosts}
        onAllowHost={onAllowHost}
      />
    );
  }
  if (value.provider === "openai-compatible") {
    return (
      <OpenAiCompatibleConfig
        idPrefix={idPrefix}
        value={value}
        onChange={onChange}
        allowedHosts={allowedHosts}
        onAllowHost={onAllowHost}
      />
    );
  }
  return null;
}

/**
 * Manage the AI host allowlist — add a `host[:port]`, remove one. Built-in
 * provider hosts and localhost are always allowed and aren't listed. The list
 * is the effective gate for which custom servers the app will talk to (the Tauri
 * HTTP capability is opened broadly as a backstop), so it's worth keeping tight.
 */
function AllowedHostsField({
  hosts,
  activeUrls,
  onChange,
}: {
  hosts: string[];
  /** URLs the currently-selected Ollama/OpenAI-compatible providers point at, so
   *  a host that's keeping one reachable can be flagged before it's removed. */
  activeUrls: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [warn, setWarn] = useState<{ text: string; sig: string } | null>(null);
  /** A warning is valid on two axes. The hosts-draft axis rides this signature —
   *  a mismatch retires the warning outright, so restoring the hosts can't
   *  resurrect it — covering the footer's Discard, which form.reset()s while this
   *  field stays mounted, and allow-list writes from elsewhere; the input axis
   *  rides the typing and Escape clears below. */
  const hostsSig = JSON.stringify(hosts);
  // Set during render of the component that owns the state: React's derived-state
  // reset, re-rendered before commit with no cross-component warning. An effect
  // would commit a stale warning for a frame first.
  if (warn && warn.sig !== hostsSig) setWarn(null);
  const visibleWarn = warn && warn.sig === hostsSig ? warn.text : null;

  function add() {
    const host = normalizeHost(draft);
    if (!host) {
      setWarn({ text: "Enter a host like 192.168.1.50:11434", sig: hostsSig });
      return;
    }
    // isHostAllowed also covers built-in/local hosts and a port already covered
    // by a no-port entry, so this blocks adding a redundant or always-allowed one.
    if (isHostAllowed(`http://${host}`, hosts)) {
      setWarn({ text: `${host} is already allowed`, sig: hostsSig });
      return;
    }
    onChange([...hosts, host]);
    setDraft("");
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <h3 className="text-sm font-medium">Allowed hosts</h3>
        <p className="text-xs text-muted-foreground">
          Hosts GitDesktop may reach for AI inference, beyond the built-in
          providers and localhost — add a LAN or self-hosted Ollama /
          OpenAI-compatible server as <code className="font-mono">host</code> or{" "}
          <code className="font-mono">host:port</code>.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <Input
            aria-label="Host to allow"
            autoComplete="off"
            placeholder="192.168.1.50:11434"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setWarn(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              } else if (e.key === "Escape") {
                setDraft("");
                setWarn(null);
              }
            }}
          />
          {visibleWarn && <p className="text-xs text-warning">{visibleWarn}</p>}
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={add}
          disabled={!draft.trim()}
        >
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
      </div>
      {hosts.length > 0 ? (
        <ul className="space-y-1">
          {hosts.map((h) => {
            const inUse = activeUrls.some((u) => entryMatchesUrl(h, u));
            return (
              <li
                key={h}
                className="flex items-center justify-between gap-2 border px-3 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-xs">{h}</span>
                  {inUse && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      in use
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${h}`}
                  onClick={() => onChange(hosts.filter((x) => x !== h))}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          No custom hosts yet — built-in providers and localhost are always
          allowed.
        </p>
      )}
    </div>
  );
}

export const AiProviderSection = withForm({
  ...settingsFormOpts,
  render: function AiProviderSectionRender({ form }) {
    const queryClient = useQueryClient();
    const ai = useSelector(form.store, (s) => s.values.ai);
    const reviewAi = useSelector(form.store, (s) => s.values.reviewAi);
    // Optional dedicated security-audit config. `undefined` = off (security
    // audits use `reviewAi`); an object = the toggle is on and its trio shows.
    const securityReviewAi = useSelector(
      form.store,
      (s) => s.values.securityReviewAi,
    );
    const reviewContextSize = useSelector(
      form.store,
      (s) => s.values.reviewContextSize ?? "auto",
    );
    const reviewTimeout = useSelector(
      form.store,
      (s) => s.values.reviewTimeout ?? "auto",
    );
    // `undefined` = Auto (no explicit default; new runs follow `ai.provider`).
    const defaultAgent = useSelector(form.store, (s) => s.values.defaultAgent);
    const agentIsolation = useSelector(
      form.store,
      (s) => s.values.agentIsolation,
    );
    const agentImageNodeVersion = useSelector(
      form.store,
      (s) => s.values.agentImageNodeVersion,
    );
    const agentImageProviders = useSelector(
      form.store,
      (s) => s.values.agentImageProviders,
    );
    const repoPath = useUiStore((s) => s.repoPath);
    const allowedHosts = useSelector(
      form.store,
      (s) => s.values.aiAllowedHosts,
    );
    const provider = ai.provider;
    const needsKey = PROVIDERS_REQUIRING_KEY.includes(provider);
    const keyPreview = useSecretPreview(provider);
    // The Allowed-hosts manager is only relevant to the providers that take a
    // custom URL; keep it out of the way for the cloud-only majority.
    const showAllowedHosts = [
      ai.provider,
      reviewAi.provider,
      securityReviewAi?.provider,
    ].some((p) => p === "ollama" || p === "openai-compatible");
    // The URLs the selected custom-host providers point at — so a host that's
    // keeping one reachable shows an "in use" hint before it's removed.
    const activeProviderUrls = [
      ai.provider === "ollama" && ai.ollamaBaseUrl,
      ai.provider === "openai-compatible" && ai.openaiCompatibleBaseUrl,
      reviewAi.provider === "ollama" && reviewAi.ollamaBaseUrl,
      reviewAi.provider === "openai-compatible" &&
        reviewAi.openaiCompatibleBaseUrl,
      securityReviewAi?.provider === "ollama" && securityReviewAi.ollamaBaseUrl,
      securityReviewAi?.provider === "openai-compatible" &&
        securityReviewAi.openaiCompatibleBaseUrl,
    ].filter((u): u is string => Boolean(u));

    const [confirmClear, setConfirmClear] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
      ok: boolean;
      message?: string;
      /** The draft signature this verdict was produced under (see testConfig). */
      config: string;
    } | null>(null);
    /** Signature over every DRAFT input testConnection reads. The verdict renders
     *  only while the current signature still matches the one it was produced
     *  under, so any route that changes the draft — including the footer's Discard,
     *  which form.reset()s while this section stays mounted, and allow-list writes
     *  from other sections — retires it without needing to know to clear it. A
     *  key-order difference could only hide a verdict early, never keep a stale one. */
    const testConfig = JSON.stringify({ ai, allowedHosts });
    /** Generation for the in-flight connection test. Bumping it makes a running
     *  test discard its own outcome — used for saved-key changes, which the draft
     *  signature can't see (keys live in the keychain, not the form). */
    const testRun = useRef(0);

    function discardTestResult() {
      testRun.current += 1;
      setTestResult(null);
    }

    // Keys save immediately to the OS keychain (they're not part of the
    // settings draft), so they get their own little form.
    const keyForm = useAppForm({
      defaultValues: { key: "" },
      onSubmit: async ({ value }) => {
        try {
          await setSecret(provider, value.key.trim());
          keyForm.reset({ key: "" });
          // The old result described the old key, so leaving it up makes a fixed
          // setup look broken.
          discardTestResult();
          queryClient.invalidateQueries({
            queryKey: settingsKeys.secret(provider),
          });
          // The models query keys on a BOOLEAN "a key is saved", which doesn't move
          // when a bad key is replaced — without this the picker keeps serving the
          // failed fetch's suggestions for the rest of its 5-minute staleTime.
          queryClient.invalidateQueries({ queryKey: ["models"] });
          toast.success(
            `${PROVIDER_LABELS[provider]} key saved to OS keychain`,
          );
        } catch (e) {
          toastError(e);
        }
      },
    });

    function setAi(next: AiSettings) {
      form.setFieldValue("ai", next);
    }

    /** Add a URL's host to the draft allowlist (dedup'd) — the one-click fix
     *  behind the contextual "Allow host" affordance on the URL fields. */
    function allowHost(url: string) {
      const host = normalizeHost(url);
      if (host && !allowedHosts.includes(host)) {
        form.setFieldValue("aiAllowedHosts", [...allowedHosts, host]);
      }
    }

    async function clearKey() {
      try {
        await deleteSecret(provider);
        queryClient.invalidateQueries({
          queryKey: settingsKeys.secret(provider),
        });
        queryClient.invalidateQueries({ queryKey: ["models"] });
        setConfirmClear(false);
        discardTestResult();
        toast.success("Key removed");
      } catch (e) {
        toastError(e);
      }
    }

    async function testConnection() {
      const run = ++testRun.current;
      // Captured before the first await: the verdict must carry the signature it
      // was produced under, not whatever the draft holds when it resolves.
      const config = testConfig;
      setTesting(true);
      setTestResult(null);
      try {
        // Use a typed-but-unsaved key and the unsaved allow list, so you can
        // test a just-added host/key before saving the settings draft.
        const client = await createAiClient(
          ai,
          keyForm.getFieldValue("key"),
          allowedHosts,
        );
        const result = await client.testConnection();
        if (run !== testRun.current) return;
        setTestResult(
          result.ok
            ? { ok: true, config }
            : { ok: false, message: result.message, config },
        );
      } catch (e) {
        if (run !== testRun.current) return;
        setTestResult({ ok: false, message: errorMessage(e), config });
      } finally {
        // Always released: the button is disabled while testing, so no newer run
        // can own this flag — a superseded run still has to hand it back.
        setTesting(false);
      }
    }

    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">AI provider</h2>
          <p className="text-xs text-muted-foreground">
            Powers commit message and pull request generation. API keys are
            stored in the OS keychain, never in app files.
          </p>
        </div>

        <ModelPicker
          idPrefix="ai"
          value={ai}
          onChange={setAi}
          providerIds={GENERATION_PROVIDER_IDS}
          allowedHosts={allowedHosts}
        />

        <ProviderUrlConfig
          idPrefix="ai"
          value={ai}
          onChange={setAi}
          allowedHosts={allowedHosts}
          onAllowHost={allowHost}
        />

        {isCliProvider(ai.provider) && (
          <CliProviderConfig
            idPrefix="ai"
            value={ai}
            onChange={setAi}
            description={
              <>
                Uses the CLI's own subscription login — no API key needed.
                Generation runs the agent CLI per request, so it's noticeably
                slower than an HTTP provider and draws on your plan's quota. The
                agent only completes the prepared prompt; it doesn't explore the
                repository.
              </>
            }
          />
        )}

        {needsKey && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              keyForm.handleSubmit();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="ai-api-key">
                API key{" "}
                <span className="font-normal text-muted-foreground">
                  {keyPreview.data
                    ? `(saved: ${keyPreview.data.masked}, ${keyPreview.data.length} chars)`
                    : "(no key saved)"}
                </span>
              </Label>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <keyForm.AppField
                    name="key"
                    validators={{ onChange: ({ value }) => required(value) }}
                  >
                    {(field) => (
                      <field.TextField
                        id="ai-api-key"
                        type="password"
                        placeholder={
                          keyPreview.data
                            ? "Enter a new key to replace the saved one"
                            : "Paste your API key"
                        }
                        warning={(value) => keyShapeWarning(provider, value)}
                      />
                    )}
                  </keyForm.AppField>
                </div>
                <keyForm.AppForm>
                  <keyForm.SubmitButton>Save</keyForm.SubmitButton>
                </keyForm.AppForm>
                {keyPreview.data && (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Keys apply immediately and are shared by every feature using
                this provider.{" "}
                {provider === "google" && (
                  <>
                    Get an API key at{" "}
                    <button
                      type="button"
                      className="cursor-pointer underline underline-offset-2"
                      onClick={() => openUrl(GOOGLE_AI_STUDIO_KEYS_URL)}
                    >
                      aistudio.google.com
                    </button>
                    .
                  </>
                )}
              </p>
            </div>
          </form>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={testConnection}
            disabled={testing}
          >
            {testing && <Spinner data-icon="inline-start" />}
            Test connection
          </Button>
          {testResult?.ok && testResult.config === testConfig && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircleIcon className="size-4" /> Connected
            </span>
          )}
          {testResult && !testResult.ok && testResult.config === testConfig && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-destructive">
              <XCircleIcon className="size-4 shrink-0" />
              <span className="line-clamp-2">{testResult.message}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Copy error message"
                className="shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(testResult.message ?? "");
                  toast.success("Error message copied");
                }}
              >
                <CopyIcon />
              </Button>
            </span>
          )}
        </div>

        <div className="space-y-4 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium">Review model</h3>
            <p className="text-xs text-muted-foreground">
              Used by AI code review on pull requests. Can differ from the
              generation model above; shares the same per-provider API keys.
            </p>
          </div>
          <ModelPicker
            idPrefix="review"
            value={reviewAi}
            onChange={(next) => form.setFieldValue("reviewAi", next)}
            providerIds={ALL_PROVIDER_IDS}
            allowedHosts={allowedHosts}
          />
          {isCliProvider(reviewAi.provider) && (
            <CliProviderConfig
              idPrefix="review"
              value={reviewAi}
              onChange={(next) => form.setFieldValue("reviewAi", next)}
              description={
                <>
                  Uses the CLI's own subscription login — no API key needed.
                  Reviews run read-only.
                </>
              }
            />
          )}
          <ProviderUrlConfig
            idPrefix="review"
            value={reviewAi}
            onChange={(next) => form.setFieldValue("reviewAi", next)}
            allowedHosts={allowedHosts}
            onAllowHost={allowHost}
          />
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Switch
                checked={Boolean(securityReviewAi)}
                onCheckedChange={(checked) =>
                  form.setFieldValue(
                    "securityReviewAi",
                    // Seed from the CURRENT DRAFT review config so the audit
                    // model starts where the review model is; clear to undefined
                    // (not a stale object) so the field is truly absent when off.
                    checked ? { ...reviewAi } : undefined,
                  )
                }
              />
              Use a different model for security audits
            </label>
            {!securityReviewAi && (
              <p className="text-xs text-muted-foreground">
                Security audits use the review model above.
              </p>
            )}
          </div>
          {securityReviewAi && (
            <div className="space-y-4">
              <ModelPicker
                idPrefix="security-review"
                value={securityReviewAi}
                onChange={(next) =>
                  form.setFieldValue("securityReviewAi", next)
                }
                providerIds={ALL_PROVIDER_IDS}
                allowedHosts={allowedHosts}
              />
              {isCliProvider(securityReviewAi.provider) && (
                <CliProviderConfig
                  idPrefix="security-review"
                  value={securityReviewAi}
                  onChange={(next) =>
                    form.setFieldValue("securityReviewAi", next)
                  }
                  description={
                    <>
                      Uses the CLI's own subscription login — no API key needed.
                      Security audits run read-only.
                    </>
                  }
                />
              )}
              <ProviderUrlConfig
                idPrefix="security-review"
                value={securityReviewAi}
                onChange={(next) =>
                  form.setFieldValue("securityReviewAi", next)
                }
                allowedHosts={allowedHosts}
                onAllowHost={allowHost}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="review-context-size">Review context</Label>
            <Select
              items={REVIEW_CONTEXT_ITEMS}
              value={reviewContextSize}
              onValueChange={(v) => {
                if (v)
                  form.setFieldValue(
                    "reviewContextSize",
                    v as ReviewContextSize,
                  );
              }}
            >
              <SelectTrigger id="review-context-size" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REVIEW_CONTEXT_ITEMS) as ReviewContextSize[]).map(
                  (id) => (
                    <SelectItem key={id} value={id}>
                      {REVIEW_CONTEXT_ITEMS[id]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              How much diff and prior-discussion context AI reviews send. Auto
              probes the model's context window where possible.
            </p>
          </div>
          {/* Only the agent-CLI providers run under a kill timeout, so the row
              shows when a CLI drives reviews or security audits. */}
          {(isCliProvider(reviewAi.provider) ||
            (securityReviewAi && isCliProvider(securityReviewAi.provider))) && (
            <div className="space-y-2">
              <Label htmlFor="review-timeout">Review timeout</Label>
              <Select
                items={REVIEW_TIMEOUT_ITEMS}
                value={reviewTimeout}
                onValueChange={(v) => {
                  if (v)
                    form.setFieldValue("reviewTimeout", v as ReviewTimeout);
                }}
              >
                <SelectTrigger id="review-timeout" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_TIMEOUTS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {REVIEW_TIMEOUT_ITEMS[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                How long an agent-CLI review may run before it's stopped. Auto
                allows 5 minutes — 20 when the review is agentic (always, for
                Codex); a fixed limit applies to every review.
              </p>
            </div>
          )}
        </div>

        {showAllowedHosts && (
          <AllowedHostsField
            hosts={allowedHosts}
            activeUrls={activeProviderUrls}
            onChange={(next) => form.setFieldValue("aiAllowedHosts", next)}
          />
        )}

        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-medium">Agent sessions</h3>
            <p className="text-xs text-muted-foreground">
              How new agent runs start — the agent that runs them, and how
              sessions are isolated.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-agent">Default agent</Label>
            <Select
              items={DEFAULT_AGENT_ITEMS}
              value={defaultAgent ?? "auto"}
              onValueChange={(v) => {
                if (!v) return;
                // Clear to undefined (not an "auto" sentinel) so the field is
                // truly absent and the resolver falls through to the provider.
                form.setFieldValue(
                  "defaultAgent",
                  v === "auto" ? undefined : (v as AgentKind),
                );
              }}
            >
              <SelectTrigger id="default-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(DEFAULT_AGENT_ITEMS) as ("auto" | AgentKind)[]
                ).map((id) => (
                  <SelectItem key={id} value={id}>
                    {DEFAULT_AGENT_ITEMS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {defaultAgent
                ? `New Session, Plan, and Research runs start on ${DEFAULT_AGENT_ITEMS[defaultAgent]}.`
                : `New Session, Plan, and Research runs follow the AI provider above when it's an agent CLI — right now they start on ${DEFAULT_AGENT_ITEMS[providerKind(ai.provider) ?? "claude"]}.`}
            </p>
          </div>
          <div className="space-y-2">
            {/* Sized below the section h3 so the sandbox controls read as its
                subordinate group, not a second section. */}
            <h4 className="text-xs font-medium">Isolation</h4>
            <AgentSandboxField
              value={agentIsolation}
              onChange={(v) => form.setFieldValue("agentIsolation", v)}
              nodeVersion={agentImageNodeVersion}
              onNodeVersion={(v) =>
                form.setFieldValue("agentImageNodeVersion", v)
              }
              providers={agentImageProviders}
              onProviders={(v) => form.setFieldValue("agentImageProviders", v)}
              repoPath={repoPath}
            />
          </div>
        </div>

        <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove the saved key?</DialogTitle>
              <DialogDescription>
                Deletes the {PROVIDER_LABELS[provider]} API key from the OS
                keychain. AI features using {PROVIDER_LABELS[provider]} will
                stop working until a new key is saved. This can't be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmClear(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={clearKey}>
                Remove key
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    );
  },
});
