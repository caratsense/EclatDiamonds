"use client";

import { useState } from "react";
import { Loader2, ScanLine } from "lucide-react";
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
import { useRecordInteraction } from "@/lib/queries/crm";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Record what a customer was shown, at the counter.
 *
 * Universal vocabulary on purpose — shown / tried / shortlisted / rejected say
 * nothing about what the product is, so this is the same screen for a jeweller,
 * a pharmacy and a fabric shop. The identifier is called an item code rather
 * than a tag number for the same reason.
 *
 * An unrecognised code is still recorded, as text. The server links it to the
 * catalogue when it matches and keeps the raw code either way: an item that is
 * not catalogued yet was still shown to someone, and losing that is worse than
 * storing it unlinked.
 */

const KINDS = [
  { value: "shown", label: "Shown to them" },
  { value: "tried", label: "Tried on / sampled" },
  { value: "shortlisted", label: "Shortlisted" },
  { value: "quoted", label: "Quoted" },
  { value: "rejected", label: "Not for them" },
] as const;

export function RecordInterestDialog({
  open,
  onOpenChange,
  partyId,
  customerName,
  storeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  customerName: string;
  /** Which branch this happened at. Omitted, the server records it unattributed. */
  storeId?: string;
}) {
  const record = useRecordInteraction();
  const [sku, setSku] = useState("");
  const [kind, setKind] = useState<string>("shown");
  const [notes, setNotes] = useState("");

  async function save() {
    const code = sku.trim();
    if (!code) {
      toast.error("Enter or scan the item code.");
      return;
    }
    try {
      await record.mutateAsync({
        kind,
        partyId,
        sku: code,
        storeId,
        channel: "store",
        notes: notes.trim() || undefined,
      });
      toast.success(`Recorded against ${customerName}.`);
      setSku("");
      setNotes("");
      onOpenChange(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not record that."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What did you show {customerName}?</DialogTitle>
          <DialogDescription>
            This builds their history, so the next person serving them knows what they
            liked.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ri-sku">Item code</Label>
            <div className="relative">
              <ScanLine className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              {/* autoFocus so a barcode scanner (which types and presses Enter)
                  works with no tapping at all. */}
              <Input
                id="ri-sku"
                autoFocus
                className="pl-8"
                placeholder="Scan or type the code"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ri-kind">What happened</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="ri-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ri-notes">Note (optional)</Label>
            <Textarea
              id="ri-notes"
              rows={2}
              placeholder="e.g. wanted it a size smaller"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={record.isPending}>
            {record.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
