"use client";

import { useState } from "react";
import { Camera, Loader2, Plus, ScanLine, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BarcodeScannerSheet } from "@/components/instore/barcode-scanner-sheet";
import {
  useRecordVisit,
  type ScannedItem,
  type VisitEnquiryInput,
} from "@/lib/queries/instore";
import { useT } from "@/lib/i18n";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Record a walk-in.
 *
 * One visit holds many enquiries, because a customer who looks at three things
 * and buys one is the normal case; recording that as three visits loses the fact
 * that it was one conversation, and makes the branch's footfall look triple.
 *
 * Nothing here names a jewellery concept. The drop-off reasons below are generic
 * and a tenant can extend them through its own taxonomy; the item is whatever
 * the catalogue holds.
 */

/**
 * Reasons that apply to any business. A tenant's pack may add its own
 * ("design not liked" for a jeweller, "consultant unavailable" for a clinic) —
 * these are the floor, not the whole list.
 */
const DROP_OFF_REASONS = [
  { value: "price", label: "Price" },
  { value: "not_available", label: "Not available right now" },
  { value: "still_deciding", label: "Still deciding" },
  { value: "wanted_something_else", label: "Wanted something else" },
  { value: "will_return", label: "Will come back" },
  { value: "other", label: "Other" },
];

interface EnquiryRow extends VisitEnquiryInput {
  /** What to show for the item, resolved or raw. */
  label: string;
}

/**
 * A scan becomes an enquiry line either way.
 *
 * A code the catalogue does not know is still kept, as a raw sku and labelled
 * as unmatched. Dropping it would lose the fact that a customer asked about
 * something — which is exactly the fact this screen exists to record.
 */
function enquiryFromScan(result: ScannedItem): EnquiryRow {
  return result.found && result.item
    ? { productId: result.item.id, label: result.item.name, converted: false }
    : { sku: result.code, label: `${result.code} (not in catalogue)`, converted: false };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  customerName: string;
  /**
   * An item already scanned before the customer was chosen.
   *
   * On the floor the tag is usually in hand before the name is — somebody is
   * holding the piece and asking about it. The scan-first path (the camera
   * button on the floor app) carries the result here so it is not re-scanned.
   */
  initialScan?: ScannedItem | null;
}

export function AddVisitDialog({
  open,
  onOpenChange,
  partyId,
  customerName,
  initialScan,
}: Props) {
  const stores = useSession((s) => s.stores);
  const currentStore = useSession((s) => s.currentStore);
  /*
   * The tenant's own word for a branch. `useT` substitutes whatever the
   * industry pack declared — "Branch" for a clinic, "Plant" for a mill — so this
   * dialog never says "Showroom" to a hospital.
   */
  const t = useT();
  const storeWord = t("label.store", "Branch");

  const [scannerOpen, setScannerOpen] = useState(false);
  // Seeded once at mount. The dialog is only rendered while it is open, so a
  // lazy initializer is enough — no effect, and no way for a stale scan to
  // reappear on the next customer.
  const [enquiries, setEnquiries] = useState<EnquiryRow[]>(() =>
    initialScan ? [enquiryFromScan(initialScan)] : [],
  );
  // Optional counter photo. Held until submit so the visit is written once.
  const [photo, setPhoto] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [storeId, setStoreId] = useState(
    () => (currentStore?.isAggregate ? "" : currentStore?.id) ?? "",
  );

  const record = useRecordVisit();
  const realStores = stores.filter((s) => !s.isAggregate);

  const addScanned = (result: ScannedItem) =>
    setEnquiries((prev) => [...prev, enquiryFromScan(result)]);

  const update = (i: number, patch: Partial<EnquiryRow>) =>
    setEnquiries((prev) => prev.map((e, n) => (n === i ? { ...e, ...patch } : e)));

  const submit = () => {
    if (!storeId && realStores.length > 1) {
      toast.error(`Choose which ${storeWord.toLowerCase()} this visit happened at.`);
      return;
    }
    record.mutate(
      {
        partyId,
        ...(storeId ? { storeId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(photo ? { photo } : {}),
        // `label` is display-only state; the API takes the item reference.
        enquiries: enquiries.map((e) => ({
          productId: e.productId,
          sku: e.sku,
          converted: e.converted,
          quantity: e.quantity,
          notes: e.notes,
          dropOffReason: e.dropOffReason,
        })),
      },
      {
        onSuccess: (res) => {
          toast.success(
            res.partiallyConverted
              ? "Visit recorded — partly converted."
              : res.converted
                ? "Visit recorded as converted."
                : "Visit recorded.",
          );
          setEnquiries([]);
          setNotes("");
          onOpenChange(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not record this visit.")),
      },
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Record a visit</DialogTitle>
            <DialogDescription>{customerName}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {realStores.length > 1 ? (
              <div className="space-y-1.5">
                <Label>{storeWord}</Label>
                <Select value={storeId} onValueChange={setStoreId}>
                  <SelectTrigger>
                    <SelectValue placeholder={`Which ${storeWord.toLowerCase()}?`} />
                  </SelectTrigger>
                  <SelectContent>
                    {realStores.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>What did they look at?</Label>
                <Button size="sm" variant="outline" onClick={() => setScannerOpen(true)}>
                  <ScanLine className="mr-1.5 h-3.5 w-3.5" />
                  Scan
                </Button>
              </div>

              {!enquiries.length ? (
                <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  Scan a tag or add an item. A visit can be recorded with none.
                </p>
              ) : (
                <div className="space-y-2">
                  {enquiries.map((e, i) => (
                    <div key={i} className="space-y-2 rounded-md border border-border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{e.label}</p>
                          {e.sku ? (
                            <Badge variant="outline" className="mt-1 text-[10px]">
                              Not in catalogue
                            </Badge>
                          ) : null}
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEnquiries((prev) => prev.filter((_, n) => n !== i))}
                          aria-label="Remove this item"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={e.converted ? "default" : "outline"}
                          onClick={() => update(i, { converted: true, dropOffReason: undefined })}
                        >
                          Bought
                        </Button>
                        <Button
                          size="sm"
                          variant={e.converted === false ? "default" : "outline"}
                          onClick={() => update(i, { converted: false })}
                        >
                          Did not buy
                        </Button>
                      </div>

                      {!e.converted ? (
                        <Select
                          value={e.dropOffReason ?? ""}
                          onValueChange={(v) => update(i, { dropOffReason: v })}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Why not? (optional)" />
                          </SelectTrigger>
                          <SelectContent>
                            {DROP_OFF_REASONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                onClick={() => setScannerOpen(true)}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add another
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>Photo (optional)</Label>
              {photo ? (
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photo}
                    alt="Photo taken for this visit"
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setCameraOpen(true)}>
                      Retake
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPhoto(null)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setCameraOpen(true)}>
                  <Camera className="mr-1.5 h-3.5 w-3.5" />
                  Take a photo
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Kept with the visit so anyone picking it up later can see who came in. Nothing is
                matched against it.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Anything worth remembering next time."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={record.isPending}>
              {record.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save visit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FaceScannerDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={(shot) => {
          setPhoto(shot);
          setCameraOpen(false);
        }}
        title="Photo for this visit"
        confirmLabel="Use this photo"
      />

      <BarcodeScannerSheet
        open={scannerOpen}
        onOpenChange={setScannerOpen}
        onResolved={addScanned}
      />
    </>
  );
}
