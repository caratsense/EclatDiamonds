"use client";

import { useState } from "react";
import { Copy, HardDrive, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useConnectAgents,
  useEnrolAgent,
  useRevokeAgent,
  useRotateAgent,
  type ConnectAgent,
} from "@/lib/queries/crm-ai";
import { useConnectorRuntime } from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

/**
 * CaratOS Connect — the agents that push data out of a shop's own machine.
 *
 * There is no "connect" button here and there never will be. The cloud does not
 * dial into a customer's network; the agent dials out. So this screen enrols an
 * identity, shows whether that identity has been checking in, and lets someone
 * revoke it — which is the whole of what the server can honestly offer.
 *
 * The token is shown once, in a dialog that says so. Anything else would mean
 * storing a recoverable secret.
 */
export function ConnectAgents() {
  const { data: agents, isLoading } = useConnectAgents();
  const { data: sources } = useConnectorRuntime();
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  // Only push-based sources can host an agent. Offering "csv" here would be
  // offering to install a Windows service to upload a spreadsheet.
  const agentSources = (sources ?? []).filter((s) => s.intakeMode === "push");

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">On-site agents</h3>
          <p className="text-xs text-muted-foreground">
            Software installed on a machine in your shop that sends its data out to CaratOS.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEnrolOpen(true)}>
          <Plus className="h-4 w-4" />
          Enrol an agent
        </Button>
      </div>

      {!agents?.length ? (
        <EmptyState
          icon={HardDrive}
          title="No agents enrolled"
          description="Enrol one to get an installation token for the shop machine that holds your existing system."
        />
      ) : (
        agents.map((a) => <AgentRow key={a.id} agent={a} onIssued={setIssued} />)
      )}

      <EnrolDialog
        open={enrolOpen}
        onOpenChange={setEnrolOpen}
        sources={agentSources.map((s) => ({ value: s.sourceSystem, label: s.name }))}
        onIssued={setIssued}
      />
      <TokenDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function AgentRow({
  agent,
  onIssued,
}: {
  agent: ConnectAgent;
  onIssued: (v: { name: string; token: string }) => void;
}) {
  const rotate = useRotateAgent();
  const revoke = useRevokeAgent();

  const tone =
    agent.status === "active"
      ? "secondary"
      : agent.status === "error" || agent.status === "revoked"
        ? "destructive"
        : "outline";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
            {agent.name}
            <Badge variant={tone}>{agent.status}</Badge>
          </CardTitle>
          {/* The server's own sentence, rendered verbatim — the badge alone
              would need interpreting, and this is what someone acts on. */}
          <p className="mt-1 text-xs text-muted-foreground">{agent.statusReason}</p>
        </div>
        {agent.status !== "revoked" ? (
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              title="Issue a new token — the current one stops working"
              onClick={() =>
                rotate
                  .mutateAsync(agent.id)
                  .then((r) => onIssued({ name: agent.name, token: r.token }))
                  .catch((e) => toast.error(apiErrorMessage(e, "Could not rotate the token.")))
              }
            >
              {rotate.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              title="Revoke this agent"
              onClick={() =>
                revoke
                  .mutateAsync(agent.id)
                  .then(() => toast.success(`${agent.name} revoked.`))
                  .catch((e) => toast.error(apiErrorMessage(e, "Could not revoke the agent.")))
              }
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Fact label="Source" value={agent.sourceSystem} />
        <Fact label="Branch" value={agent.store?.name ?? "Whole organisation"} />
        <Fact label="Token" value={`${agent.tokenPrefix}…`} />
        <Fact label="Version" value={agent.agentVersion ?? "not reported"} />
        <Fact label="Machine" value={agent.hostname ?? "not reported"} />
        <Fact
          label="Last check-in"
          value={agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "never"}
        />
        {agent.lastError ? (
          <p className="col-span-full text-destructive">{agent.lastError}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function EnrolDialog({
  open,
  onOpenChange,
  sources,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sources: { value: string; label: string }[];
  onIssued: (v: { name: string; token: string }) => void;
}) {
  const enrol = useEnrolAgent();
  const { stores } = useSession();
  const [name, setName] = useState("");
  const [sourceSystem, setSourceSystem] = useState(sources[0]?.value ?? "gati");
  const [storeId, setStoreId] = useState("");

  async function submit() {
    if (!name.trim()) {
      toast.error("Give the agent a name you will recognise.");
      return;
    }
    try {
      const res = await enrol.mutateAsync({
        name: name.trim(),
        sourceSystem,
        storeId: storeId || undefined,
      });
      onIssued({ name: res.agent.name, token: res.token });
      setName("");
      onOpenChange(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not enrol the agent."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrol an on-site agent</DialogTitle>
          <DialogDescription>
            This creates an identity for one machine. You will get a token to paste into the
            installer.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              placeholder="e.g. Surat back-office PC"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Reads from</Label>
            <Select value={sourceSystem} onValueChange={setSourceSystem}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Branch (optional)</Label>
            <Select value={storeId || "all"} onValueChange={(v) => setStoreId(v === "all" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Whole organisation</SelectItem>
                {stores
                  .filter((s) => !s.isAggregate)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={enrol.isPending}>
            {enrol.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Enrol
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The token, shown once.
 *
 * Stated plainly rather than softened, because someone who closes this dialog
 * without copying has to rotate — and being surprised by that later is worse
 * than being warned now.
 */
function TokenDialog({
  issued,
  onClose,
}: {
  issued: { name: string; token: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!issued} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Token for {issued?.name}
          </DialogTitle>
          <DialogDescription>
            Copy this now. It is stored only as a hash and cannot be shown again — if it is
            lost, rotate the agent to issue a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-md border bg-muted/40 px-3 py-2 text-xs">
            {issued?.token}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!issued) return;
              void navigator.clipboard
                .writeText(issued.token)
                .then(() => toast.success("Token copied."))
                .catch(() => toast.error("Could not copy — select the text and copy it manually."));
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I have copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
