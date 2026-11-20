"use client";

import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/utils";
import {
  PURGE_CONFIRM_PHRASE,
  usePurgeDemo,
  usePurgePreview,
  type PurgeResult,
} from "@/lib/queries/purge-demo";

/**
 * Going live: drop the demonstration rows now that the shop's own data is in.
 *
 * The screen shows what WOULD go before anything goes, and will not arm itself
 * until the phrase is typed. That is not ceremony — this deletes leads, quotes,
 * check-ins, attendance, DSRs, targets, tickets and campaigns outright, and the
 * only defence against deleting a customer's real work is that a person read
 * the list first.
 *
 * The server refuses entirely until synced data exists, so an empty tenant
 * cannot purge itself into nothing.
 */
export function RemoveDemoData() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<PurgeResult | null>(null);
  const preview = usePurgePreview(open);
  const purge = usePurgeDemo();

  const rows = Object.entries(preview.data?.wouldDelete ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  const armed = typed.trim() === PURGE_CONFIRM_PHRASE && total > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trash2 className="h-4 w-4" />
          Remove demo data
        </CardTitle>
        <CardDescription>
          The sample leads, quotes, check-ins and reports this system was set up with.
          Your own synced and imported records are never touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Show me what would go
          </Button>
        ) : preview.isLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : preview.isError ? (
          <p className="text-sm text-destructive">
            {apiErrorMessage(
              preview.error,
              "Could not work out what is demo data. Nothing has been changed.",
            )}
          </p>
        ) : done ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{done.message}</p>
            <ul className="text-xs text-muted-foreground">
              {Object.entries(done.deleted)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k}>
                    {k}: {n}
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <>
            {total === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing to remove — there is no demo data left.
              </p>
            ) : (
              <>
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-xs font-medium">
                    {total} record{total === 1 ? "" : "s"} would be deleted
                  </p>
                  <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-3">
                    {rows.map(([k, n]) => (
                      <li key={k} className="flex justify-between gap-2">
                        <span className="truncate">{k}</span>
                        <span className="num">{n}</span>
                      </li>
                    ))}
                  </ul>
                  {preview.data && preview.data.storesToDelete.length > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Stores removed: {preview.data.storesToDelete.join(", ")}
                    </p>
                  ) : null}
                  {preview.data && preview.data.usersToDelete.length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Logins removed: {preview.data.usersToDelete.length}
                    </p>
                  ) : null}
                </div>

                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
                  <span>
                    This cannot be undone. Read the list above — anything your team
                    entered by hand that is not in it stays, and anything in it goes.
                  </span>
                </p>

                <div className="grid gap-1">
                  <Label htmlFor="purge-confirm" className="text-xs">
                    Type <span className="font-mono">{PURGE_CONFIRM_PHRASE}</span> to
                    confirm
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="purge-confirm"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={PURGE_CONFIRM_PHRASE}
                      autoComplete="off"
                      className="h-9 max-w-xs"
                    />
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!armed || purge.isPending}
                      onClick={() =>
                        purge
                          .mutateAsync(PURGE_CONFIRM_PHRASE)
                          .then((r) => {
                            setDone(r);
                            toast.success(r.message);
                          })
                          .catch((e) =>
                            toast.error(
                              apiErrorMessage(e, "Could not remove the demo data."),
                            ),
                          )
                      }
                    >
                      Remove demo data
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
