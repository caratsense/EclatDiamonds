"use client";

import { useState } from "react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/store/use-session";
import {
  REQUEST_KIND_LABELS,
  REQUEST_KINDS,
  useCreateSpecialRequest,
  type RequestPriority,
  type SpecialRequestKind,
} from "@/lib/queries/special-requests";
import { apiErrorMessage, isRealName, positiveNumberInput } from "@/lib/utils";

const PRIORITIES: RequestPriority[] = ["low", "medium", "high", "urgent"];

/**
 * Raise a request to someone above this branch.
 *
 * The approver is NOT chosen here — the server derives it from the kind, the
 * value and the requester's own rank. Letting the branch pick its own approver
 * would make the escalation ladder advisory rather than a control.
 */
export function NewRequestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore, stores } = useSession();
  const create = useCreateSpecialRequest();

  const [kind, setKind] = useState<SpecialRequestKind>("diamond_rate");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [amount, setAmount] = useState("");
  const [priority, setPriority] = useState<RequestPriority>("medium");
  const [neededBy, setNeededBy] = useState("");
  const [diamondSpec, setDiamondSpec] = useState("");
  const [rate, setRate] = useState("");
  // On "All Stores" the branch is a choice, never silently the first one.
  const [pickedStore, setPickedStore] = useState("");

  const isDiamond = kind === "diamond_rate";

  const branches = stores.filter((s) => !s.isAggregate);
  const targetStoreId = currentStore.isAggregate ? pickedStore : currentStore.id;

  function reset() {
    setKind("diamond_rate");
    setTitle("");
    setDetails("");
    setAmount("");
    setPriority("medium");
    setNeededBy("");
    setDiamondSpec("");
    setRate("");
    setPickedStore("");
  }

  function submit() {
    if (!targetStoreId) {
      toast.error("Pick the branch this request is for.");
      return;
    }
    if (title.trim().length < 3) {
      toast.error("Give the request a short title.");
      return;
    }
    if (!isRealName(title)) {
      toast.error("The title needs letters, not just a number.");
      return;
    }
    if (isDiamond && (!diamondSpec.trim() || !Number(rate))) {
      toast.error("A diamond-rate request needs the spec and the rate you want.");
      return;
    }

    create.mutate(
      {
        storeId: targetStoreId,
        kind,
        title: title.trim(),
        details: details.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
        priority,
        neededBy: neededBy || undefined,
        diamondSpec: isDiamond ? diamondSpec.trim() : undefined,
        requestedRatePerCarat: isDiamond ? Number(rate) : undefined,
      },
      {
        onSuccess: (r) => {
          toast.success(`Request ${r.ref} sent`, {
            description: `Waiting on ${r.requiredRoleLabel}.`,
          });
          reset();
          onOpenChange(false);
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not raise the request.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>
            {currentStore.isAggregate ? "" : `Raised from ${currentStore.name}. `}Who signs it off
            is decided by what you&apos;re asking for and how much it&apos;s worth.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {currentStore.isAggregate ? (
            <div className="grid gap-1.5">
              <Label htmlFor="req-store">Branch</Label>
              <Select value={pickedStore} onValueChange={setPickedStore}>
                <SelectTrigger id="req-store">
                  <SelectValue placeholder="Which branch is this for?" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="req-kind">What do you need?</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as SpecialRequestKind)}>
              <SelectTrigger id="req-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REQUEST_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {REQUEST_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isDiamond ? (
              <p className="text-xs text-muted-foreground">
                Diamond rates are set by head office, so this goes straight to
                them. Approving it publishes the new rate for this branch.
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="req-title">Title</Label>
            <Input
              id="req-title"
              placeholder={
                isDiamond
                  ? "e.g. Rate for Mehta wedding set"
                  : "e.g. Transfer 3 bangles from Surat"
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {isDiamond ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="req-spec">Diamond spec / code</Label>
                <Input
                  id="req-spec"
                  placeholder="e.g. VVS1-EF"
                  value={diamondSpec}
                  onChange={(e) => setDiamondSpec(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="req-rate">Rate you need (₹/carat)</Label>
                <Input
                  id="req-rate"
                  type="number"
                  min={0}
                  placeholder="e.g. 48000"
                  value={rate}
                  onChange={(e) => setRate(positiveNumberInput(e.target.value))}
                />
              </div>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="req-details">Details</Label>
            <Textarea
              id="req-details"
              rows={3}
              placeholder="Why you need it, and anything the approver should know."
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="req-amount">Value (₹)</Label>
              <Input
                id="req-amount"
                type="number"
                min={0}
                placeholder="Optional"
                value={amount}
                onChange={(e) => setAmount(positiveNumberInput(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground">
                Higher values route further up.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="req-priority">Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as RequestPriority)}
              >
                <SelectTrigger id="req-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p[0].toUpperCase() + p.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="req-needed">Needed by</Label>
              <Input
                id="req-needed"
                type="date"
                value={neededBy}
                onChange={(e) => setNeededBy(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
