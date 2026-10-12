"use client";

import * as React from "react";
import { PackageSearch } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
import { Textarea } from "@/components/ui/textarea";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { DesignSearchField } from "@/components/requests/design-search-field";
import { RequestStatusBadge } from "@/components/requests/request-badges";
import {
  useCreateSpecialRequest,
  useSpecialRequests,
} from "@/lib/queries/special-requests";
import type { Product } from "@/lib/mock/catalogue";
import { useSession } from "@/store/use-session";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/**
 * Module 9 — the Inventory "Reorder" tab (client 9 Oct, item 16).
 *
 * "Reorder" here means MERCHANDISING, not low-stock alerts: when a design
 * sells well, staff ask for N more pieces of it — even when its current piece
 * sits unsold at another branch. The ask travels through the existing Branch
 * Requests ladder (SpecialRequest kind `reorder`), so it lands in the inbox a
 * manager / head office already works, with the usual no-self-approval rule.
 */
export function ReorderTab() {
  const { role } = useSession();
  // A storeperson holds Inventory but not Branch Requests (auth/access.ts), so
  // the raise-and-track surface below would only 403 for them.
  if (role === "storeperson") {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            icon={PackageSearch}
            title="Reorder requests are raised by sales staff"
            description="Asking for more pieces of a design goes through Branch Requests, which your role does not hold. A salesperson or manager at this branch can raise one."
          />
        </CardContent>
      </Card>
    );
  }
  return <ReorderContent />;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

function ReorderContent() {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const create = useCreateSpecialRequest();
  // `all` keeps decided requests visible — "was my ask approved?" is the point.
  // The server narrows the list to the active store, and a salesperson to
  // their own requests.
  const {
    data: requests = [],
    isLoading,
    isError,
    refetch,
  } = useSpecialRequests({ scope: "all", kind: "reorder" });

  const [design, setDesign] = React.useState<Product | null>(null);
  const [qty, setQty] = React.useState("");
  const [note, setNote] = React.useState("");

  function submit() {
    if (!targetStoreId) {
      toast.error("Pick the branch this reorder is for.");
      return;
    }
    if (!design || !(Number(qty) >= 1)) {
      toast.error("Pick the design and how many more pieces you need.");
      return;
    }
    create.mutate(
      {
        storeId: targetStoreId,
        kind: "reorder",
        title: `Reorder ${Number(qty)} × ${design.name}`,
        details: note.trim() || undefined,
        productId: design.id,
        quantity: Number(qty),
      },
      {
        onSuccess: (r) => {
          toast.success(`Reorder request ${r.ref} sent`, {
            description: `Waiting on ${r.requiredRoleLabel}.`,
          });
          setDesign(null);
          setQty("");
          setNote("");
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not raise the reorder request.")),
      },
    );
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Request more of a design</CardTitle>
          <CardDescription>
            When a design sells, ask for more pieces of it — even if its current
            piece is unsold at another branch. The request goes to your manager
            (or head office) for approval, from {storeLabel}.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {/* Branch — only a choice on the "All Stores" scope. */}
          <StoreScopeField
            value={pickedStoreId}
            onChange={setPickedStoreId}
            label="Branch"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="reorder-design">
              Design <span className="text-destructive">*</span>
            </Label>
            <DesignSearchField
              inputId="reorder-design"
              value={design}
              onChange={setDesign}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="reorder-qty">
              Pieces needed <span className="text-destructive">*</span>
            </Label>
            <Input
              id="reorder-qty"
              type="number"
              min={1}
              className="w-32"
              placeholder="e.g. 3"
              value={qty}
              onChange={(e) => setQty(positiveNumberInput(e.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="reorder-note">Note</Label>
            <Textarea
              id="reorder-note"
              rows={2}
              placeholder="Why it should be reordered — e.g. sold twice this week, customer asks pending."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div>
            <Button variant="gold" onClick={submit} disabled={create.isPending}>
              {create.isPending ? "Sending…" : "Request reorder"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Reorder requests</CardTitle>
          <CardDescription>
            This store&apos;s reorder asks and where each one stands.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <p>Couldn&apos;t load reorder requests.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : requests.length === 0 ? (
            <EmptyState
              icon={PackageSearch}
              title="No reorder requests yet"
              description="Raise one above when a design is selling and you want more pieces of it."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Design</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Raised by</TableHead>
                  <TableHead>Decided by</TableHead>
                  <TableHead className="text-right">Raised</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <span className="num">{r.ref}</span>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {r.product?.name ?? r.title}
                      </div>
                      {r.product ? (
                        <div className="text-xs text-muted-foreground">
                          {r.product.sku}
                          {r.product.styleNumber
                            ? ` · Style ${r.product.styleNumber}`
                            : ""}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">{r.quantity ?? "—"}</span>
                    </TableCell>
                    <TableCell>
                      <RequestStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.requestedByName || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.decidedBy ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {fmtDate(r.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
