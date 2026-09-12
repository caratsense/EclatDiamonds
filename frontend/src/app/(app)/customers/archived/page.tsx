"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowLeft, SearchX, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useParties, useRestoreParty } from "@/lib/queries/parties";
import { useDebouncedValue } from "@/lib/queries/search";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const PAGE_SIZE = 25;

/**
 * Archived contacts.
 *
 * The only way to see somebody who has been taken out of the directory. There is
 * no combined view on purpose: a list that mixes active and archived people is a
 * list somebody eventually campaigns from by mistake.
 */
export default function ArchivedContactsPage() {
  const role = useSession((s) => s.role);
  const canRestore = role === "store_manager" || role === "head_office" || role === "area_manager";

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [rawQuery, setRawQuery] = useState("");
  const query = useDebouncedValue(rawQuery, 300);

  const list = useParties({ page, pageSize, type: "all", archived: true, q: query || undefined });
  const restore = useRestoreParty();

  const onRestore = (id: string, name: string) => {
    restore.mutate(id, {
      onSuccess: (res) => {
        // Said plainly, because "restored" on its own invites the assumption
        // that they can be messaged again.
        toast.success(`${name} is back in the directory`, {
          description: res.isBlacklisted
            ? "They remain opted out — restoring does not undo that."
            : "They are searchable and reachable again.",
        });
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not restore that contact.")),
    });
  };

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All customers
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">Archived contacts</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Hidden from the directory, search, the counter lookup and every campaign
          audience. Nothing has been deleted — consent, opt-out and blacklist
          records are kept exactly as they were, which is what stops an archived
          contact being messaged again under a new record.
        </p>
      </div>

      <Input
        value={rawQuery}
        onChange={(e) => {
          setRawQuery(e.target.value);
          setPage(1);
        }}
        placeholder="Search archived contacts by name or number"
        className="max-w-md"
        aria-label="Search archived contacts"
      />

      {list.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : list.isError ? (
        <EmptyState
          icon={SearchX}
          title="Could not load archived contacts"
          description={apiErrorMessage(list.error, "Try again in a moment.")}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={query ? "No archived contact matches that" : "Nothing archived"}
          description={
            query
              ? "Try a different name or number."
              : "Contacts you archive from the customer directory appear here."
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border/80 bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Archived by</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.isBlacklisted ? (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <ShieldAlert className="h-3 w-3" aria-hidden />
                            Opted out
                          </Badge>
                        ) : null}
                      </div>
                      {p.city ? (
                        <div className="text-xs text-muted-foreground">{p.city}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="num">{p.phone ?? "—"}</TableCell>
                    <TableCell className="max-w-xs">
                      <span className="text-sm text-muted-foreground">
                        {p.archiveReason ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{p.archivedByName ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.archivedAt ? new Date(p.archivedAt).toLocaleDateString() : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {canRestore ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={restore.isPending}
                          onClick={() => onRestore(p.id, p.name)}
                        >
                          <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          Restore
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Manager only</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={list.data?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </>
      )}
    </div>
  );
}
