"use client";

import * as React from "react";
import { Gem, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR } from "@/lib/format";
import { useAddDiamondRate, useDiamondRates } from "@/lib/queries/returns";

interface DiamondRatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 14 — Head-Office diamond-rate table. The diamond rate is set manually
 * by HO and only changes every 3–6 months (unlike the daily gold rate). This
 * lets HO view the current table and add / update a spec's ₹/ct.
 */
export function DiamondRatesDialog({
  open,
  onOpenChange,
}: DiamondRatesDialogProps) {
  const { data: rates = [], isLoading, isError, refetch } = useDiamondRates();
  const addRate = useAddDiamondRate();

  const [spec, setSpec] = React.useState("");
  const [rate, setRate] = React.useState("");

  function add() {
    const specTrim = spec.trim();
    const rateNum = Number(rate);
    if (!specTrim) {
      toast.error("Enter a spec / internal code.");
      return;
    }
    if (!Number.isFinite(rateNum) || rateNum <= 0) {
      toast.error("Enter a valid rate per carat.");
      return;
    }
    addRate.mutate(
      { spec: specTrim, ratePerCarat: rateNum },
      {
        onSuccess: () => {
          toast.success("Diamond rate saved", {
            description: `${specTrim} · ${formatINR(rateNum)}/ct`,
          });
          setSpec("");
          setRate("");
        },
        onError: () => toast.error("Could not save the rate."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gem className="h-4 w-4 text-primary" />
            Diamond rate table
          </DialogTitle>
          <DialogDescription>
            Head-Office maintained. Diamond rates change only every 3–6 months,
            unlike the daily gold rate. Adding an existing spec updates its rate.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Add / update row */}
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="dr-spec">Spec / code</Label>
              <Input
                id="dr-spec"
                placeholder="e.g. 1 ct / 20 cent / D-code"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5 sm:w-40">
              <Label htmlFor="dr-rate">Rate (₹/ct)</Label>
              <Input
                id="dr-rate"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="0"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <Button onClick={add} disabled={addRate.isPending}>
              <Plus className="h-4 w-4" />
              {addRate.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {/* Current table */}
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <p>Could not load the diamond rate table.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Spec / code</TableHead>
                  <TableHead className="text-right">Rate / carat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rates.map((r) => (
                  <TableRow key={r.spec}>
                    <TableCell className="font-medium">{r.spec}</TableCell>
                    <TableCell className="text-right">
                      <span className="num">{formatINR(r.ratePerCarat)}</span>
                    </TableCell>
                  </TableRow>
                ))}
                {rates.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={2}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No diamond rates yet — add the first one above.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
