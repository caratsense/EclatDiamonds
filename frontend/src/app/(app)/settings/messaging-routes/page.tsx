"use client";

import Link from "next/link";
import { ArrowLeft, MessageSquare, Phone, ShieldAlert, Unlink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ROUTE_STATE,
  useClearMessagingRoute,
  useMessagingRoutes,
  useSetMessagingRoute,
} from "@/lib/queries/messaging-routes";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Which number each branch answers on.
 *
 * The screen leads with what is BROKEN, because that is the only reason
 * somebody opens it: a branch with several numbers connected and none mapped
 * sends nothing at all, and that is stated in those words rather than as
 * "unconfigured". Before routing existed the same situation sent from whichever
 * number happened to be oldest, so a customer who wrote to Surat was answered
 * from Mumbai and nothing in the product said so.
 *
 * Numbers are shown by their last four digits only. A phone-number id is not a
 * secret exactly, but it is the routing identity of a business, and a settings
 * screen that prints it in full is a screenshot away from being useful to
 * somebody else.
 */
export default function MessagingRoutesPage() {
  const routes = useMessagingRoutes("whatsapp");
  const setRoute = useSetMessagingRoute();
  const clearRoute = useClearMessagingRoute();

  const numbers = routes.data?.numbers ?? [];
  const sendable = numbers.filter((n) => n.isActive);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessageSquare className="size-5" /> Who sends from which number
        </h1>
        <p className="text-sm text-muted-foreground">
          A customer who writes to a branch is answered from that branch&rsquo;s number. Map each
          one below.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {routes.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (routes.data?.unroutable ?? []).length > 0 ? (
        <Card className="border-rose-500/40 bg-rose-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="size-4" />
              {routes.data!.unroutable.length} branch
              {routes.data!.unroutable.length === 1 ? "" : "es"} cannot send
            </CardTitle>
            <CardDescription>
              {routes.data!.unroutable.join(", ")} — {sendable.length} numbers are connected and
              none is mapped to {routes.data!.unroutable.length === 1 ? "it" : "them"}. Nothing
              will be sent from {routes.data!.unroutable.length === 1 ? "it" : "them"} until you
              choose, because sending from the wrong number reaches the customer as a different
              business.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {routes.isLoading ? null : numbers.length === 0 ? (
        <EmptyState
          icon={Phone}
          title="No WhatsApp number is connected"
          description="Connect a WhatsApp Business account under Settings → Integrations, then come back to map your branches."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {numbers.length} number{numbers.length === 1 ? "" : "s"} across{" "}
                {routes.data!.accounts.length} account
                {routes.data!.accounts.length === 1 ? "" : "s"}
              </CardTitle>
              <CardDescription>
                Each account has its own access token, so a number can only be used by the
                account that owns it. Ownership is marked verified only after a live check with
                the provider &mdash; a typed-in id is not proof.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Number</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Verified with provider</TableHead>
                      <TableHead className="text-right">Branches using</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {numbers.map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>
                          <span className="num font-medium">{n.phoneNumberIdSuffix}</span>
                          {n.name ? (
                            <div className="text-xs text-muted-foreground">{n.name}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">{n.accountName}</TableCell>
                        <TableCell>
                          <StatusPill tone={n.providerOwnershipVerified ? "good" : "wait"}>
                            {n.providerOwnershipVerified ? "Verified" : "Not checked"}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="num text-right">{n.branchesUsing}</TableCell>
                        <TableCell>
                          <StatusPill tone={n.isActive ? "good" : "mute"}>
                            {n.isActive ? "Active" : "Retired"}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Branches</CardTitle>
              <CardDescription>
                One number per branch. A number may serve several branches &mdash; a head-office
                line answering for three shops is an ordinary arrangement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Branch</TableHead>
                      <TableHead>Sends from</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(routes.data?.branches ?? []).map((b) => {
                      const state = ROUTE_STATE[b.effective];
                      return (
                        <TableRow key={b.storeId}>
                          <TableCell>
                            <div className="font-medium">{b.name}</div>
                            <div className="text-xs text-muted-foreground">{b.city}</div>
                          </TableCell>
                          <TableCell>
                            <select
                              className="h-9 max-w-[16rem] rounded-md border bg-background px-2 text-sm"
                              aria-label={`Number ${b.name} sends from`}
                              value={b.assetId ?? ""}
                              disabled={setRoute.isPending}
                              onChange={(e) => {
                                const assetId = e.target.value;
                                if (!assetId) return;
                                setRoute.mutate(
                                  { storeId: b.storeId, assetId },
                                  {
                                    onSuccess: () => toast.success(`${b.name} mapped.`),
                                    onError: (err) =>
                                      toast.error(
                                        apiErrorMessage(err, "Could not map that branch."),
                                      ),
                                  },
                                );
                              }}
                            >
                              <option value="">Not mapped</option>
                              {sendable.map((n) => (
                                <option key={n.id} value={n.id}>
                                  {n.phoneNumberIdSuffix} · {n.accountName}
                                  {n.name ? ` · ${n.name}` : ""}
                                </option>
                              ))}
                            </select>
                          </TableCell>
                          <TableCell>
                            <StatusPill tone={state.tone}>{state.label}</StatusPill>
                            <div className="max-w-sm text-xs text-muted-foreground">
                              {state.detail}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {b.assetId ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={clearRoute.isPending}
                                onClick={() =>
                                  clearRoute.mutate(
                                    { storeId: b.storeId },
                                    {
                                      onSuccess: (res) =>
                                        res.warning
                                          ? toast.warning(res.warning)
                                          : toast.success(`${b.name} unmapped.`),
                                      onError: (err) =>
                                        toast.error(
                                          apiErrorMessage(err, "Could not unmap that branch."),
                                        ),
                                    },
                                  )
                                }
                              >
                                <Unlink className="size-3.5" /> Unmap
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            A conversation stays on the number it started on, even if you re-map the branch
            afterwards. Moving an existing thread to another number would start a second
            conversation on the customer&rsquo;s phone and lose the 24-hour reply window on the
            first.
          </p>
        </>
      )}
    </div>
  );
}
