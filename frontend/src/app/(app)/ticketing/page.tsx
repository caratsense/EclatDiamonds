"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { ArrowRight, Repeat2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { TicketDetailDialog } from "@/components/ticketing/ticket-detail-dialog";
import {
  PriorityBadge,
  TicketStatusBadge,
} from "@/components/ticketing/status-badges";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateTicket,
  useTickets,
  type TicketListItem,
} from "@/lib/queries/ticketing";
import { useSession } from "@/store/use-session";
import {
  CATEGORIES,
  resolverFor,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/mock/ticketing";

export default function TicketingPage() {
  const { data, isLoading, isError, refetch } = useTickets();
  const tickets = data?.tickets ?? [];
  const patterns = data?.patterns ?? [];

  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const openCount = tickets.filter(
    (t) => t.status !== "resolved" && t.status !== "closed",
  ).length;

  const view = (t: TicketListItem) => {
    setActiveId(t.id);
    setOpen(true);
  };

  return (
    <>
      <SectionHeader
        title="Ticketing"
        purpose="Internal helpdesk for operational issues with auto-routing."
        primaryAction="New Ticket"
        onPrimaryAction={() => setAddOpen(true)}
      />

      {/* Auto-routing reference: category -> resolver team */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            Auto-routing
          </CardTitle>
          <CardDescription>
            Tickets route to a resolver team automatically by category.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <div
              key={c.key}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="font-medium">{c.label}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <Badge variant="secondary">{c.resolverTeam}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Recurring pattern callouts */}
      {patterns.length > 0 ? (
        <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {patterns.map((p) => (
            <Card
              key={p.tag}
              className="border-amber-300 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20"
            >
              <CardContent className="flex gap-3 pt-6">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  <Repeat2 className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium capitalize">{p.label}</p>
                    <Badge variant="destructive">
                      <span className="num">{p.count}</span> tickets
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {p.insight}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Across: {p.stores.join(", ")}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Ticket list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            Tickets
            <Badge variant="secondary" className="ml-1">
              <span className="num">{openCount}</span> open
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <p>We could not load tickets just now.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Try again
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Routed to</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((t) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => view(t)}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {t.ref}
                    </TableCell>
                    <TableCell className="max-w-[18rem]">
                      <span className="font-medium">{t.subject}</span>
                      {t.patternTag ? (
                        <Badge
                          variant="outline"
                          className="ml-2 align-middle text-[10px]"
                        >
                          recurring
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.store}
                    </TableCell>
                    <TableCell>
                      {CATEGORIES.find((c) => c.key === t.category)?.label}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {resolverFor(t.category)}
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={t.priority} />
                    </TableCell>
                    <TableCell>
                      <TicketStatusBadge status={t.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.assignee}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(parseISO(t.updatedAt), "dd MMM")}
                    </TableCell>
                  </TableRow>
                ))}
                {tickets.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No tickets yet — raise the first one.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <TicketDetailDialog
        ticketId={activeId}
        open={open}
        onOpenChange={setOpen}
      />
      <NewTicketDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function NewTicketDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
  const createTicket = useCreateTicket();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<TicketCategory>("it");
  const [priority, setPriority] = useState<TicketPriority>("medium");

  // Aggregate scope has no concrete store — let the ticket be HO-level (no storeId).
  const targetStoreId = currentStore.isAggregate ? undefined : currentStore.id;

  function save() {
    if (!subject.trim()) {
      toast.error("Subject is required.");
      return;
    }
    createTicket.mutate(
      { storeId: targetStoreId, subject: subject.trim(), category, priority },
      {
        onSuccess: () => {
          toast.success("Ticket raised", {
            description: `Auto-routed to ${resolverFor(category)}.`,
          });
          setSubject("");
          setCategory("it");
          setPriority("medium");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not raise ticket."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Raised against{" "}
            {currentStore.isAggregate ? "Head Office" : currentStore.name}. It
            auto-routes to a resolver team by category.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              placeholder="e.g. POS terminal freezes during billing"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cat">Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as TicketCategory)}
              >
                <SelectTrigger id="cat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prio">Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as TicketPriority)}
              >
                <SelectTrigger id="prio">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Routes to: {resolverFor(category)}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createTicket.isPending}>
            {createTicket.isPending ? "Raising…" : "Raise ticket"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
