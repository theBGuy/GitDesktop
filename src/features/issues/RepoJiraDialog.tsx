import { ArrowSquareOutIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Spinner } from "@/components/ui/spinner";
import { forgeBbAccount } from "@/lib/git/api";
import { jiraSetAccount, jiraSetAccountFromBitbucket } from "@/lib/jira/api";
import {
  useClearJiraLink,
  useJiraAccount,
  useJiraProjectSearch,
  useSaveJiraLink,
} from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import type { JiraAccountInfo, JiraProject } from "@/lib/jira/types";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/** Where an Atlassian API token is created (same page the Bitbucket account
 *  section links to). */
const ATLASSIAN_TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Strip a pasted `https://` (or `http://`) prefix and any trailing slash so the
 *  user can paste a full URL and still get a bare site host. */
function normalizeSiteHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
}

/**
 * Link (or re-link) this repository to a Jira project. Two steps in one dialog:
 * **Connect** (validate a site + credential, reusing a stored account or an
 * offered Bitbucket credential) then **Project** (pick the project key). Config
 * only — draft + dirty, Save persists the `{siteHost, projectKey, projectName}`
 * link to app-data; Discard/Esc confirms nothing. Editing an existing link
 * prefills both steps and offers a destructive Unlink (which clears the link,
 * not the keyring credential).
 */
export function RepoJiraDialog({
  repoPath,
  open,
  onOpenChange,
  existingLink,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingLink: JiraLink | null;
}) {
  const save = useSaveJiraLink(repoPath);
  const clear = useClearJiraLink(repoPath);
  const bbAccount = useQuery({
    queryKey: ["bb-account"] as const,
    queryFn: () => forgeBbAccount(),
    enabled: open,
  });

  // ── Connect step ──────────────────────────────────────────────────────────
  const [siteInput, setSiteInput] = useState("");
  const siteHost = normalizeSiteHost(siteInput);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  // The account resolved this session (via Validate / Use-BB-credentials).
  const [account, setAccount] = useState<JiraAccountInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // When the user explicitly asks to use different credentials, show the form
  // even if a stored account exists.
  const [showCredentialForm, setShowCredentialForm] = useState(false);

  // A stored credential for this site (no network) lets us skip straight to a
  // "Connected as <email>" summary.
  const stored = useJiraAccount(siteHost);
  const hasStored = !!stored.data;

  // ── Project step ──────────────────────────────────────────────────────────
  const [projectQuery, setProjectQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [project, setProject] = useState<JiraProject | null>(null);
  // Whether the connection is good enough to search projects: either a fresh
  // validation this session, or a stored credential for the typed site.
  const connected = account !== null || (hasStored && siteHost.length > 0);
  const projectSearch = useJiraProjectSearch(
    connected ? siteHost : "",
    debouncedQuery,
  );

  // Seed the draft from an existing link when the dialog opens; reset on close so
  // a reopen reflects persisted state, not stale in-flight edits.
  useEffect(() => {
    if (!open) return;
    if (existingLink) {
      setSiteInput(existingLink.siteHost);
      setProject({
        id: "",
        key: existingLink.projectKey,
        name: existingLink.projectName,
        avatarUrl: "",
      });
      setProjectQuery(existingLink.projectName);
    } else {
      setSiteInput("");
      setProject(null);
      setProjectQuery("");
    }
    setEmail("");
    setToken("");
    setAccount(null);
    setConnectError(null);
    setDebouncedQuery("");
    setShowCredentialForm(false);
  }, [open, existingLink]);

  // Debounce the project search input (server-driven query) — self-contained, no
  // shared debounce hook exists.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(projectQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [projectQuery]);

  async function validate() {
    setConnectError(null);
    setValidating(true);
    try {
      // jira_set_account validates the (site, email, token) triple against the
      // site BEFORE persisting anything; a bad site shape / 401 / 403 throws with
      // a human message the catch surfaces inline.
      const info = await jiraSetAccount(siteHost, email.trim(), token.trim());
      setAccount(info);
      // Re-check the stored-account query so the summary reflects the new save.
      stored.refetch();
    } catch (e) {
      setConnectError(errorMessage(e));
    } finally {
      setValidating(false);
    }
  }

  // One-click reuse: the backend reads the stored Bitbucket Atlassian pair (the
  // token never crosses IPC), probes this site's /myself, and persists on
  // success. On ANY failure — no BB account, 401 expired, or 403 "no Jira
  // access" — surface the command's message and fall back to the manual fields
  // with the BB email prefilled so the user can paste a Jira-scoped token.
  async function validateFromBitbucket() {
    setConnectError(null);
    setValidating(true);
    try {
      const info = await jiraSetAccountFromBitbucket(siteHost);
      setAccount(info);
      stored.refetch();
    } catch (e) {
      setConnectError(errorMessage(e));
      setEmail(bbAccount.data?.email ?? "");
      setToken("");
      setShowCredentialForm(true);
    } finally {
      setValidating(false);
    }
  }

  function useDifferentCredentials() {
    setAccount(null);
    setEmail("");
    setToken("");
    setConnectError(null);
    // Force the connect form even though a credential is stored: clearing the
    // site's stored-account view is not needed — we just render the form path.
    setShowCredentialForm(true);
  }

  const summaryAccount = account
    ? { displayName: account.displayName, avatarUrl: account.avatarUrl }
    : hasStored && !showCredentialForm
      ? { displayName: stored.data?.email ?? siteHost, avatarUrl: "" }
      : null;

  const canValidate =
    siteHost.length > 0 && email.trim().length > 0 && token.trim().length > 0;
  const validateReason =
    siteHost.length === 0
      ? "Enter your Jira site host"
      : email.trim().length === 0
        ? "Enter your Atlassian account email"
        : token.trim().length === 0
          ? "Paste an Atlassian API token"
          : null;

  const canSave = connected && !!project && project.key.length > 0;
  const saveReason = !connected
    ? "Connect to your Jira site first"
    : !project
      ? "Pick a project to link"
      : null;

  const dirty =
    !existingLink ||
    existingLink.siteHost !== siteHost ||
    existingLink.projectKey !== project?.key;

  function doSave() {
    if (!project) return;
    save.mutate(
      {
        siteHost,
        projectKey: project.key,
        projectName: project.name || project.key,
      },
      {
        onSuccess: () => {
          toast.success(`Linked ${project.key}`);
          onOpenChange(false);
        },
        onError: toastError,
      },
    );
  }

  function doUnlink() {
    clear.mutate(undefined, {
      onSuccess: () => {
        toast.success("Jira project unlinked");
        onOpenChange(false);
      },
      onError: toastError,
    });
  }

  const showCredentialFields =
    !summaryAccount && (!hasStored || showCredentialForm);
  const canOfferBb =
    showCredentialFields && !!bbAccount.data && siteHost.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existingLink ? "Jira project" : "Link Jira project"}
          </DialogTitle>
          <DialogDescription>
            Browse a Jira Cloud project's issues alongside this repository. The
            link is stored on this device — it changes nothing on your Jira
            site.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto pr-1">
          {/* ── Connect ─────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label htmlFor="jira-site">Jira site</Label>
            <Input
              id="jira-site"
              value={siteInput}
              onChange={(e) => setSiteInput(e.target.value)}
              placeholder="yourteam.atlassian.net"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {summaryAccount ? (
            <div className="flex items-center gap-2 border px-3 py-2 text-xs">
              {account ? (
                <Avatar size="sm" className="shrink-0">
                  {summaryAccount.avatarUrl && (
                    <AvatarImage
                      src={summaryAccount.avatarUrl}
                      alt={summaryAccount.displayName}
                    />
                  )}
                  <AvatarFallback>
                    {(summaryAccount.displayName || "?")
                      .charAt(0)
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <CheckCircleIcon className="size-4 shrink-0 text-success" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  Connected as {summaryAccount.displayName}
                </p>
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={useDifferentCredentials}
              >
                Use different credentials
              </Button>
            </div>
          ) : (
            showCredentialFields && (
              <div className="space-y-3 border p-3">
                {canOfferBb && (
                  <div className="space-y-1.5 border-b pb-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={validating || siteHost.length === 0}
                      onClick={validateFromBitbucket}
                    >
                      {validating && <Spinner data-icon="inline-start" />}
                      Use your Bitbucket credentials
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Reuses the Atlassian token you connected to Bitbucket (
                      {bbAccount.data?.email}) to check access to {siteHost}. It
                      may not carry Jira scopes — if it fails, enter a Jira
                      token below.
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="jira-email">Atlassian account email</Label>
                  <Input
                    id="jira-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="jira-token">API token</Label>
                  <Input
                    id="jira-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste your Atlassian API token"
                    autoComplete="off"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span title={validateReason ?? undefined}>
                    <Button
                      size="sm"
                      disabled={!canValidate || validating}
                      onClick={validate}
                    >
                      {validating && <Spinner data-icon="inline-start" />}
                      Validate &amp; save
                    </Button>
                  </span>
                  {validateReason && (
                    <span className="text-xs text-warning">
                      {validateReason}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  A successful validation stores this credential in your OS
                  keychain for {siteHost || "this site"}. Create a token at{" "}
                  <button
                    type="button"
                    className="cursor-pointer underline underline-offset-2"
                    onClick={() => openUrl(ATLASSIAN_TOKEN_URL)}
                  >
                    id.atlassian.com
                  </button>
                  .
                </p>
                {connectError && (
                  <p className="text-xs text-destructive">{connectError}</p>
                )}
              </div>
            )
          )}

          {/* ── Project ─────────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Label>Project</Label>
            <Combobox
              items={projectSearch.data ?? []}
              itemToStringLabel={(p: JiraProject) => `${p.key} · ${p.name}`}
              value={project}
              onValueChange={(p: JiraProject | null) => setProject(p)}
              inputValue={projectQuery}
              onInputValueChange={setProjectQuery}
              openOnInputClick
            >
              <ComboboxInput
                className="w-full"
                placeholder={
                  connected
                    ? "Search projects by key or name"
                    : "Connect to your Jira site first"
                }
                disabled={!connected}
              />
              <ComboboxContent>
                <ComboboxEmpty>
                  {projectSearch.isFetching
                    ? "Searching…"
                    : "No matching projects."}
                </ComboboxEmpty>
                <ComboboxList>
                  {(item: JiraProject) => (
                    <ComboboxItem key={item.id || item.key} value={item}>
                      <span className="font-mono text-muted-foreground">
                        {item.key}
                      </span>
                      <span className="truncate">{item.name}</span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {project && (
              <p className="text-[11px] text-muted-foreground">
                Linking{" "}
                <span className="font-mono text-foreground">{project.key}</span>
                {project.name ? ` — ${project.name}` : ""}.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="items-center">
          {existingLink && (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto text-destructive"
              disabled={clear.isPending}
              onClick={doUnlink}
              title="Remove this repository's Jira link (keeps your saved credential)"
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              Unlink project
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {canSave && dirty && !save.isPending ? (
            <Button onClick={doSave}>Save</Button>
          ) : (
            <span
              title={saveReason ?? (save.isPending ? "Saving…" : undefined)}
            >
              <Button onClick={doSave} disabled>
                Save
              </Button>
            </span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
