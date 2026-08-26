import { CheckCircleIcon, LinkBreakIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
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
import { linearSetAccount, linearValidateToken } from "@/lib/linear/api";
import {
  useLinearAccount,
  useLinearTeams,
  useClearLinearLink,
  useSaveLinearLink,
} from "@/lib/linear/queries";
import type { LinearLink } from "@/lib/linear/store";
import type { LinearAccountInfo, LinearTeam } from "@/lib/linear/types";
import { errorMessage } from "@/lib/tauri/invoke";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

const LINEAR_API_KEY_URL =
  "https://linear.app/settings/api";

export function RepoLinearDialog({
  repoPath,
  open,
  onOpenChange,
  existingLink,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingLink: LinearLink | null;
}) {
  const save = useSaveLinearLink(repoPath);
  const clear = useClearLinearLink(repoPath);

  const [tokenInput, setTokenInput] = useState("");
  const [account, setAccount] = useState<LinearAccountInfo | null>(null);
  const [validating, setValidating] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [showTokenForm, setShowTokenForm] = useState(false);

  const stored = useLinearAccount();
  const hasStored = !!stored.data;

  const [selectedTeam, setSelectedTeam] = useState<LinearTeam | null>(null);

  const connected = account !== null || hasStored;
  const teams = useLinearTeams(connected && open);

  useSeedOnOpen(open, () => {
    if (existingLink) {
      setSelectedTeam({
        id: "",
        key: existingLink.teamKey,
        name: existingLink.teamName,
      });
    }
    setTokenInput("");
    setAccount(null);
    setConnectError(null);
    setShowTokenForm(false);
  });

  useEffect(() => {
    if (!open) {
      setTokenInput("");
      setAccount(null);
      setConnectError(null);
      setShowTokenForm(false);
      setSelectedTeam(null);
    }
  }, [open]);

  async function handleValidate() {
    if (!tokenInput.trim()) return;
    setValidating(true);
    setConnectError(null);
    try {
      const info = await linearSetAccount(tokenInput.trim());
      setAccount(info);
      setShowTokenForm(false);
    } catch (e) {
      setConnectError(errorMessage(e));
    } finally {
      setValidating(false);
    }
  }

  function handleSave() {
    if (!selectedTeam) return;
    save.mutate(
      {
        workspaceSlug: "",
        teamKey: selectedTeam.key,
        teamName: selectedTeam.name,
      },
      {
        onSuccess: () => {
          toast.success(
            `Linked to Linear team ${selectedTeam.key}`,
          );
          onOpenChange(false);
        },
      },
    );
  }

  function handleUnlink() {
    clear.mutate(undefined, {
      onSuccess: () => {
        toast.success("Linear team unlinked");
        onOpenChange(false);
      },
    });
  }

  const canSave = selectedTeam !== null;
  const disabledReason = !selectedTeam
    ? "Select a team to link"
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existingLink ? "Edit Linear link" : "Link a Linear team"}
          </DialogTitle>
          <DialogDescription>
            Connect your Linear account and pick a team to browse its issues
            here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!connected || showTokenForm ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="linear-token">API key</Label>
                <Input
                  id="linear-token"
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="lin_api_…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleValidate();
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  Create a personal API key at{" "}
                  <button
                    type="button"
                    className="cursor-pointer underline underline-offset-2"
                    onClick={() =>
                      import("@tauri-apps/plugin-opener").then((m) =>
                        m.openUrl(LINEAR_API_KEY_URL),
                      )
                    }
                  >
                    linear.app/settings/api
                  </button>
                  .
                </p>
              </div>
              {connectError && (
                <p className="text-xs text-destructive">{connectError}</p>
              )}
              <Button
                onClick={handleValidate}
                disabled={!tokenInput.trim() || validating}
                className="cursor-pointer"
              >
                {validating && <Spinner className="mr-1.5 size-3" />}
                Connect
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <CheckCircleIcon className="size-4 text-success" />
              <span>
                Connected as{" "}
                <span className="font-medium">
                  {account?.email ?? stored.data?.email}
                </span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto cursor-pointer text-muted-foreground"
                onClick={() => setShowTokenForm(true)}
              >
                Change
              </Button>
            </div>
          )}

          {connected && !showTokenForm && (
            <div className="space-y-1.5">
              <Label>Team</Label>
              {teams.isPending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" /> Loading teams…
                </div>
              ) : teams.isError ? (
                <p className="text-xs text-destructive">
                  Couldn't load teams — your API key may have expired.
                </p>
              ) : (
                <div className="space-y-1">
                  {(teams.data ?? []).map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => setSelectedTeam(team)}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                        selectedTeam?.key === team.key
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="font-mono text-muted-foreground">
                        {team.key}
                      </span>
                      <span className="truncate">{team.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {existingLink && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto cursor-pointer text-destructive"
              onClick={handleUnlink}
            >
              <LinkBreakIcon data-icon="inline-start" />
              Unlink
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            size="sm"
            className="cursor-pointer"
            onClick={handleSave}
            disabled={!canSave}
            reason={disabledReason}
          >
            Save
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
