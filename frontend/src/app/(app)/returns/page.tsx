"use client";

import * as React from "react";
import { Check, Gem, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PhotoIntake } from "@/components/returns/photo-intake";
import { ReturnCalculatorDialog } from "@/components/returns/return-calculator-dialog";
import { DiamondRatesDialog } from "@/components/returns/diamond-rates-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINR } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import {
  CHOSEN_OPTION_LABELS,
  RETURN_STATUS_LABELS,
  RETURN_TYPE_LABELS,
  type ReturnRecord,
  type ReturnStatus,
} from "@/lib/mock/returns";
import {
  useApproveReturn,
  useRates,
  useRejectReturn,
  useReturns,
} from "@/lib/queries/returns";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

const STATUS_VARIANT: Record<
  ReturnStatus,
  "default" | "secondary" | "destructive" | "success" | "outline"
> = {
  draft: "outline",
  pending_approval: "secondary",
  approved: "success",
  rejected: "destructive",
  settled: "default",
};

/** Prefer the new server-computed value; fall back to the legacy creditValue. */
function optionValue(r: ReturnRecord, which: "exchange" | "buyback"): number | null {
  if (which === "exchange") {
    return r.exchangeValue ?? (r.settlement === "exchange" ? r.creditValue : null);
  }
  return r.buybackValue ?? (r.settlement !== "exchange" ? r.creditValue : null);
}

export default function ReturnsPage() {
  const nav = getNavItem("returns");
  const { currentStore, role } = useSession();
  const isHeadOffice = role === "head_office";

  const { data: rows = [], isLoading, isError, refetch } = useReturns();
  const { data: rates } = useRates();
  const approve = useApproveReturn();
  const reject = useRejectReturn();

  const [calcOpen, setCalcOpen] = React.useState(false);
  const [ratesOpen, setRatesOpen] = React.useState(false);
  // Id of the return being rejected (drives the reason dialog).
  const [rejectId, setRejectId] = React.useState<string | null>(null);
  const [rejectNote, setRejectNote] = React.useState("");

  const pending = rows.filter((r) => r.status === "pending_approval").length;

  function approveRow(id: string) {
    approve.mutate(id, {
      onSuccess: () => toast.success("Return approved"),
      onError: (err) => toast.error(apiErrorMessage(err, "Could not approve the return.")),
    });
  }

  function confirmReject() {
    if (!rejectId) return;
    reject.mutate(
      { id: rejectId, note: rejectNote.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Return rejected");
          setRejectId(null);
          setRejectNote("");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not reject the return.")),
      },
    );
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Returns & Exchange"}
        purpose={nav?.purpose ?? ""}
        primaryAction="New Return / Exchange"
        onPrimaryAction={() => setCalcOpen(true)}
      />

      {/* Today's rates + HO diamond-rate admin */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
            Today&apos;s gold:{" "}
            <span className="num font-medium text-foreground">
              {rates?.gold?.[0]
                ? `${formatINR(rates.gold[0].ratePerGram)}/g`
                : "—"}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Gem className="h-3.5 w-3.5 text-primary" />
            Diamond specs:{" "}
            <span className="num font-medium text-foreground">
              {rates?.diamond?.length ?? 0}
            </span>
          </span>
        </div>
        {isHeadOffice ? (
          <Button variant="outline" size="sm" onClick={() => setRatesOpen(true)}>
            <Gem className="h-4 w-4" />
            Manage diamond rates
          </Button>
        ) : null}
      </div>

      <Tabs defaultValue="list" className="space-y-4">
        <TabsList>
          <TabsTrigger value="list">
            All Returns
            {pending > 0 ? (
              <Badge variant="secondary" className="ml-2">
                <span className="num">{pending}</span>
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="repairs">Photo intake</TabsTrigger>
        </TabsList>

        {/* ---- LIST TAB ---- */}
        <TabsContent value="list">
          <Card>
            <CardHeader>
              <CardTitle>Returns, exchanges &amp; buybacks</CardTitle>
              <CardDescription>
                {rows.length} record{rows.length === 1 ? "" : "s"} for{" "}
                {currentStore.name}.
                {isHeadOffice
                  ? " Approve or reject pending requests below."
                  : " Pending requests await Head-Office approval."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : isError ? (
                <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  <p>Couldn&apos;t load returns.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={RotateCcw}
                  title="No intakes yet"
                  description="Start a return, exchange or buyback for a customer — values are computed at today's rates and sent to Head Office for approval."
                  actionLabel="New Intake"
                  onAction={() => setCalcOpen(true)}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ref</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Exchange</TableHead>
                      <TableHead className="text-right">Buyback</TableHead>
                      <TableHead>Chosen</TableHead>
                      <TableHead>Status</TableHead>
                      {isHeadOffice ? (
                        <TableHead className="text-right">Approval</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const exVal = optionValue(r, "exchange");
                      const bbVal = optionValue(r, "buyback");
                      const isPending = r.status === "pending_approval";
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.ref}</TableCell>
                          <TableCell>
                            <div>{r.customer}</div>
                            <div className="text-xs text-muted-foreground">
                              {r.phone}
                            </div>
                            {r.decisionNote &&
                            (r.status === "approved" ||
                              r.status === "rejected") ? (
                              <p className="mt-0.5 max-w-[220px] text-xs text-muted-foreground">
                                Note from approver: {r.decisionNote}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {RETURN_TYPE_LABELS[r.type]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="num">
                              {exVal != null ? formatINR(exVal) : "—"}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="num">
                              {bbVal != null ? formatINR(bbVal) : "—"}
                            </span>
                          </TableCell>
                          <TableCell>
                            {r.chosenOption ? (
                              <Badge
                                variant={
                                  r.chosenOption === "exchange"
                                    ? "gold"
                                    : "secondary"
                                }
                              >
                                {CHOSEN_OPTION_LABELS[r.chosenOption]}
                              </Badge>
                            ) : (
                              <span className="text-xs capitalize text-muted-foreground">
                                {r.settlement?.replace("_", " ") ?? "—"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={STATUS_VARIANT[r.status]}>
                              {r.status === "approved" || r.status === "settled" ? (
                                <Check className="mr-1 h-3 w-3" />
                              ) : r.status === "rejected" ? (
                                <X className="mr-1 h-3 w-3" />
                              ) : null}
                              {RETURN_STATUS_LABELS[r.status]}
                            </Badge>
                          </TableCell>
                          {isHeadOffice ? (
                            <TableCell className="text-right">
                              {isPending ? (
                                <div className="flex justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      approve.isPending &&
                                      approve.variables === r.id
                                    }
                                    onClick={() => approveRow(r.id)}
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                    disabled={
                                      reject.isPending &&
                                      reject.variables?.id === r.id
                                    }
                                    onClick={() => {
                                      setRejectNote("");
                                      setRejectId(r.id);
                                    }}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                    Reject
                                  </Button>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- REPAIRS / PHOTO-INTAKE TAB ---- */}
        <TabsContent value="repairs">
          <Card>
            <CardHeader>
              <CardTitle>Photo intake</CardTitle>
              <CardDescription>
                Document the condition of a piece at the counter — used for
                repairs and buyback evidence. Software receipt integration is
                planned for a later phase.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PhotoIntake />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ReturnCalculatorDialog open={calcOpen} onOpenChange={setCalcOpen} />
      {isHeadOffice ? (
        <DiamondRatesDialog open={ratesOpen} onOpenChange={setRatesOpen} />
      ) : null}

      <Dialog
        open={rejectId != null}
        onOpenChange={(o) => {
          if (!o) {
            setRejectId(null);
            setRejectNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject return</DialogTitle>
            <DialogDescription>
              Add an optional reason. It is shared with the store as a note from
              the approver.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="return-reject-note">Reason for rejection</Label>
            <Textarea
              id="return-reject-note"
              placeholder="e.g. Piece condition does not match the intake photos."
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectId(null);
                setRejectNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmReject}
              disabled={reject.isPending}
            >
              {reject.isPending ? "Rejecting…" : "Reject return"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
