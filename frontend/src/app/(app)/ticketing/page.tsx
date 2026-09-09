"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { ArrowRight, LifeBuoy, Repeat2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { EmptyState } from "@/components/ui/empty-state";
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
  categoryLabel,
  resolverFor,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/mock/ticketing";
import { apiErrorMessage, isRealName } from "@/lib/utils";

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
        purpose="Raise and track operational issues, routed to the back office."
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
              className="border-warning/30 bg-warning/5"
            >
              <CardContent className="flex gap-3 pt-6">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
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
              <p>Couldn&apos;t load tickets.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : tickets.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title="No tickets yet"
              description="Raise an internal ticket for an operational issue; it auto-routes to a resolver team by category."
              actionLabel="New Ticket"
              onAction={() => setAddOpen(true)}
            />
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
                      <div className="text-xs text-muted-foreground">
                        Raised by {t.reporter}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t.store}
                    </TableCell>
                    <TableCell>{categoryLabel(t.category)}</TableCell>
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
  // "none" = no category → server routes it to the back-office bucket.
  const [category, setCategory] = useState<TicketCategory | "none">("none");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Aggregate scope has no concrete store — let the ticket be HO-level (no storeId).
  const targetStoreId = currentStore.isAggregate ? undefined : currentStore.id;

  const resolvedCategory = category === "none" ? undefined : category;
  const routedTo = resolverFor(resolvedCategory);

  function save() {
    const next: Record<string, string> = {};
    if (!subject.trim()) next.subject = "Subject is required.";
    else if (!isRealName(subject))
      next.subject = "Enter a real subject (letters, not just a number).";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted field.");
      return;
    }
    setErrors({});
    createTicket.mutate(
      {
        storeId: targetStoreId,
        subject: subject.trim(),
        category: resolvedCategory,
        priority,
      },
      {
        onSuccess: () => {
          toast.success("Ticket raised", {
            description: `Auto-routed to ${routedTo}.`,
          });
          setSubject("");
          setCategory("none");
          setPriority("medium");
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not raise ticket.")),
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
            <Label htmlFor="subject">
              Subject <span className="text-destructive">*</span>
            </Label>
            <Input
              id="subject"
              placeholder="e.g. POS terminal freezes during billing"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                if (errors.subject) setErrors((p) => ({ ...p, subject: "" }));
              }}
              aria-invalid={!!errors.subject}
            />
            {errors.subject ? (
              <p className="mt-1 text-xs text-destructive">{errors.subject}</p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="cat">
                Category{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional — routed to back office)
                </span>
              </Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as TicketCategory | "none")}
              >
                <SelectTrigger id="cat">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    None — route to back office
                  </SelectItem>
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
            Routes to: {routedTo}
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
