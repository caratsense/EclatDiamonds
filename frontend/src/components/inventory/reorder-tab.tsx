"use client";

import * as React from "react";
import { PackageSearch, TriangleAlert } from "lucide-react";
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
  type SpecialRequest,
} from "@/lib/queries/special-requests";
import {
  useLowStock,
  useSetLowStockDefault,
  useSetReorderLevel,
  type LowStockRow,
} from "@/lib/queries/low-stock";
import type { Product } from "@/lib/mock/catalogue";
import { useSession } from "@/store/use-session";
import { apiErrorMessage, positiveNumberInput } from "@/lib/utils";

/**
 * Module 9 — the Inventory "Reorder" tab (client 9 Oct, item 16).
 *
 * Two halves of one job, deliberately on one screen. The top half is the ALERT:
 * designs this branch sells and is now below its reorder level on, with how
 * many sit at other branches — because that turns a reorder into a transfer.
 * The bottom half is the ASK: when a design sells well, staff request N more
 * pieces of it, even when its current piece sits unsold elsewhere.
 *
 * The ask travels through the existing Branch Requests ladder (SpecialRequest
 * kind `reorder`), so it lands in the inbox a manager / head office already
 * works, with the usual no-self-approval rule — and a row in the alert raises
 * exactly that request, so noticing the gap and filling it are one gesture.
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
      <LowStockCard requests={requests} />

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

/**
 * What is below its reorder level right now.
 *
 * The count is the catalogue's own — pieces on hand of standard merchandise at
 * this branch — so the number here and the number on the design's card cannot
 * disagree. `elsewhere` is the same design at the OTHER branches in view: when
 * it is not zero the cheaper answer is a transfer, and saying so is the point
 * of showing it.
 *
 * A pending reorder for the same design at the same branch replaces the button,
 * so the list cannot be used to raise one ask five times.
 */
function LowStockCard({ requests }: { requests: SpecialRequest[] }) {
  const { role } = useSession();
  const { data, isLoading, isError, refetch } = useLowStock();
  const create = useCreateSpecialRequest();
  const setDefault = useSetLowStockDefault();
  const setLevel = useSetReorderLevel();
  const [raising, setRaising] = React.useState<string | null>(null);

  // The level applies at every branch, so only head office sets it. The server
  // enforces that; the inputs are simply not offered to anyone else.
  const canSetLevel = role === "head_office";

  const pending = React.useMemo(() => {
    const open = new Set<string>();
    for (const r of requests) {
      if (r.productId && (r.status === "pending" || r.status === "escalated")) {
        open.add(`${r.productId}|${r.storeId}`);
      }
    }
    return open;
  }, [requests]);

  function raise(row: LowStockRow) {
    const wanted = Math.max(1, row.level - row.onHand);
    setRaising(`${row.productId}|${row.storeId}`);
    create.mutate(
      {
        storeId: row.storeId,
        kind: "reorder",
        title: `Reorder ${wanted} × ${row.name}`,
        details:
          `Below the reorder level at ${row.storeName}: ${row.onHand} on hand, ${row.level} wanted.` +
          (row.elsewhere > 0
            ? ` ${row.elsewhere} at other branches.`
            : " None at any other branch."),
        productId: row.productId,
        quantity: wanted,
      },
      {
        onSuccess: (r) =>
          toast.success(`Reorder request ${r.ref} sent`, {
            description: `Waiting on ${r.requiredRoleLabel}.`,
          }),
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not raise the reorder request.")),
        onSettled: () => setRaising(null),
      },
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Below reorder level</CardTitle>
        <CardDescription>
          Designs a branch has sold and is now short of. A branch should hold{" "}
          {data ? data.defaultLevel : "—"} piece(s) of a design unless that design
          says otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {canSetLevel && data ? (
          <div className="mb-4 grid w-32 gap-1.5">
            <Label htmlFor="low-stock-default">Default level</Label>
            <Input
              id="low-stock-default"
              type="number"
              min={1}
              className="w-24"
              /* Keyed on the saved value so a save (or a refetch) re-seeds it. */
              key={data.defaultLevel}
              defaultValue={data.defaultLevel}
              /* Committed on leaving the field: a number typed digit by digit
                 must not save "1" on its way to "12". */
              onBlur={(e) => {
                const next = Number(e.target.value);
                if (!Number.isInteger(next) || next < 1 || next === data.defaultLevel) return;
                setDefault.mutate(next, {
                  onSuccess: () => toast.success(`A branch should hold at least ${next}.`),
                  onError: (err: unknown) =>
                    toast.error(apiErrorMessage(err, "Could not save the level.")),
                });
              }}
            />
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            <p>Couldn&apos;t load what is below its level.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title="Nothing is below its reorder level"
            description="Every design this branch sells has at least its level on the shelf."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Design</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Level</TableHead>
                  <TableHead className="text-right">At other branches</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => {
                  const key = `${r.productId}|${r.storeId}`;
                  return (
                    <TableRow key={key}>
                      <TableCell>
                        <div className="font-medium">{r.styleNumber ?? r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.sku}</div>
                      </TableCell>
                      <TableCell>{r.storeName}</TableCell>
                      <TableCell className="text-right">
                        <span className="num inline-flex items-center gap-1">
                          {r.onHand === 0 ? (
                            <TriangleAlert className="h-3.5 w-3.5 text-destructive" />
                          ) : null}
                          {r.onHand}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {canSetLevel ? (
                          <Input
                            type="number"
                            min={1}
                            aria-label={`Reorder level for ${r.name}`}
                            className="ml-auto h-8 w-20 text-right"
                            key={`${r.productId}-${r.level}`}
                            defaultValue={r.level}
                            onBlur={(e) => {
                              const next = Number(e.target.value);
                              if (!Number.isInteger(next) || next < 1 || next === r.level) return;
                              setLevel.mutate(
                                { productId: r.productId, level: next },
                                {
                                  onSuccess: () =>
                                    toast.success(`${r.name}: every branch holds ${next}.`),
                                  onError: (err: unknown) =>
                                    toast.error(apiErrorMessage(err, "Could not save the level.")),
                                },
                              );
                            }}
                          />
                        ) : (
                          <span className="num">{r.level}</span>
                        )}
                      </TableCell>
                      {/* Zero everywhere is the real reorder; anything else can be moved. */}
                      <TableCell className="text-right">
                        <span className="num">{r.elsewhere}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {pending.has(key) ? (
                          <span className="text-xs text-muted-foreground">Requested</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={raising === key}
                            onClick={() => raise(r)}
                          >
                            {raising === key ? "Sending…" : "Request reorder"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {data.truncated ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the {data.rows.length} deepest gaps of {data.total}. Pick a
                single branch in the top bar to work one counter at a time.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
