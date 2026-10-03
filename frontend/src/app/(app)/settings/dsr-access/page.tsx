"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Search, Smartphone, Unlink } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getNavItem } from "@/lib/navigation";
import {
  useDsrRoster,
  useIssueLinkCode,
  useRevokeIdentity,
  type DsrRosterRow,
  type IssuedLinkCode,
} from "@/lib/queries/whatsapp-access";
import { ROLE_LABELS } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Who can file a daily report over WhatsApp.
 *
 * ## Why this screen had to exist before the feature was usable
 *
 * The bot answers a handset only when that number is bound to a CaratSense
 * user, and the only way to bind one was an API call by hand. So shipping the
 * DSR bot without this meant one person running curl for every store manager
 * in the business, and nobody else being able to add anyone ever again.
 *
 * ## The code is read out, not sent
 *
 * There is no "send them the code" button, and that is not an omission. The
 * bot cannot message a number it has never heard from — WhatsApp only allows a
 * business to open a conversation with an approved template, and a one-time
 * code is not a thing Meta will approve a template for. So the flow is the one
 * that actually works: the admin reads the code out, and the manager sends it
 * from the handset they want bound.
 *
 * That has a useful property. Nobody types a phone number anywhere here, so
 * nobody can bind a number they do not hold — the number is learnt from the
 * message that carries the code.
 */
export default function DsrAccessPage() {
  const item = getNavItem("settings/dsr-access");
  const roster = useDsrRoster();
  const [query, setQuery] = useState("");

  const rows = (roster.data ?? []).filter((r) =>
    `${r.name} ${r.email} ${r.stores.map((s) => s.name).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const linked = (roster.data ?? []).filter((r) => r.identity).length;

  return (
    <>
      <SectionHeader
        title={item?.title ?? "WhatsApp Reporting Access"}
        purpose={
          item?.purpose ??
          "Who can file a daily report over WhatsApp, and who still needs setting up."
        }
      />

      <Card>
        <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Team</CardTitle>
            <CardDescription>
              {roster.isLoading
                ? "Loading…"
                : `${linked} of ${roster.data?.length ?? 0} can file a report from their phone.`}
            </CardDescription>
          </div>
          <div className="relative sm:w-64">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Name, email or branch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {roster.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {query ? "No one matches." : "No team members in your branches yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <PersonRow key={row.userId} row={row} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function PersonRow({ row }: { row: DsrRosterRow }) {
  const issue = useIssueLinkCode();
  const revoke = useRevokeIdentity();
  const [issued, setIssued] = useState<IssuedLinkCode | null>(null);
  const [copied, setCopied] = useState(false);

  const onIssue = async () => {
    try {
      setIssued(await issue.mutateAsync(row.userId));
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not create a code."));
    }
  };

  const onCopy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const onRevoke = async () => {
    if (!row.identity) return;
    try {
      await revoke.mutateAsync(row.identity.id);
      toast.success(`${row.name} can no longer file reports from that phone`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not remove that access."));
    }
  };

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.name}</div>
        <div className="text-xs text-muted-foreground">
          {ROLE_LABELS[row.role] ?? row.role}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {row.stores.map((s) => s.name).join(", ") || "—"}
      </TableCell>
      <TableCell>
        {row.identity ? (
          <Badge variant="outline" className="font-mono text-[11px]">
            {row.identity.phoneSuffix}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not set up</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {/*
          Last seen, not "verified at". Whether somebody has USED the bot is the
          fact a manager acts on; the day they linked it stopped being
          interesting the moment they filed their first report.
        */}
        {row.identity?.lastSeenAt
          ? new Date(row.identity.lastSeenAt).toLocaleDateString()
          : row.identity
            ? "Never"
            : "—"}
      </TableCell>
      <TableCell className="text-right">
        {row.identity ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onRevoke}
            disabled={revoke.isPending}
          >
            <Unlink className="size-3.5" />
            Remove
          </Button>
        ) : issued ? (
          /*
            The code, shown once, with what to do with it. It is read out to the
            person rather than sent: the bot cannot open a conversation with a
            number it has never heard from, and a one-time code is not something
            Meta approves a template for.
          */
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest">
                {issued.code}
              </code>
              <Button size="icon" variant="ghost" className="size-7" onClick={onCopy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
            <p className="max-w-[18rem] text-right text-[11px] leading-relaxed text-muted-foreground">
              {row.name.split(" ")[0]} sends this to{" "}
              <span className="font-medium text-foreground">
                {issued.botNumber ?? "the reporting number"}
              </span>{" "}
              from their own phone, within {issued.expiresInMinutes} minutes.
            </p>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onIssue} disabled={issue.isPending}>
            <KeyRound className="size-3.5" />
            {issue.isPending ? "Creating…" : "Set up"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
