"use client";

import * as React from "react";
import { format, parseISO } from "date-fns";
import { ArrowRightLeft, Bot } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PriorityBadge,
  TicketStatusBadge,
} from "@/components/ticketing/status-badges";
import { useReplyToTicket, useTicket, useUpdateTicket } from "@/lib/queries/ticketing";
import { CATEGORIES, resolverFor, type TicketStatus } from "@/lib/mock/ticketing";

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "routed", label: "Routed" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

export function TicketDetailDialog({
  ticketId,
  open,
  onOpenChange,
}: {
  ticketId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: ticket, isLoading } = useTicket(open ? ticketId : null);
  const reply = useReplyToTicket();
  const updateTicket = useUpdateTicket();
  const [body, setBody] = React.useState("");

  function send() {
    if (!ticketId || !body.trim()) return;
    reply.mutate(
      { id: ticketId, body: body.trim() },
      {
        onSuccess: () => {
          setBody("");
          toast.success("Reply sent");
        },
        onError: () => toast.error("Could not send reply."),
      },
    );
  }

  function changeStatus(status: TicketStatus) {
    if (!ticketId) return;
    updateTicket.mutate(
      { id: ticketId, status },
      {
        onSuccess: () =>
          toast.success(
            `Status updated to ${STATUS_OPTIONS.find((s) => s.value === status)?.label}`,
          ),
        onError: () => toast.error("Could not update status."),
      },
    );
  }

  const categoryLabel = ticket
    ? (CATEGORIES.find((c) => c.key === ticket.category)?.label ?? ticket.category)
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {isLoading || !ticket ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {ticket.ref}
                </span>
                <TicketStatusBadge status={ticket.status} />
                <PriorityBadge priority={ticket.priority} />
              </div>
              <DialogTitle className="text-left">{ticket.subject}</DialogTitle>
              <DialogDescription className="text-left">
                {ticket.store} · {categoryLabel} · reported by {ticket.reporter}
              </DialogDescription>
            </DialogHeader>

            {/* Auto-routing indicator */}
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Auto-routed to</span>
              <Badge variant="secondary">{resolverFor(ticket.category)}</Badge>
              <span className="ml-auto text-xs text-muted-foreground">
                Assignee: {ticket.assignee}
              </span>
            </div>

            {/* Status control */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Status</span>
              <Select
                value={ticket.status}
                onValueChange={(v) => changeStatus(v as TicketStatus)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Conversation thread */}
            <div className="space-y-3">
              {ticket.thread.map((m) => (
                <div key={m.id} className="flex gap-3">
                  <div
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                      m.system
                        ? "bg-accent text-accent-foreground"
                        : "bg-primary text-primary-foreground"
                    }`}
                  >
                    {m.system ? (
                      <Bot className="h-3.5 w-3.5" />
                    ) : (
                      m.author.charAt(0)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{m.author}</span>
                      <span className="num text-xs text-muted-foreground">
                        {format(parseISO(m.at), "dd MMM")}
                      </span>
                    </div>
                    <p
                      className={`text-sm ${m.system ? "italic text-muted-foreground" : ""}`}
                    >
                      {m.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter className="sm:flex-col sm:items-stretch sm:space-x-0">
              <div className="flex gap-2">
                <Input
                  placeholder="Add a reply…"
                  className="flex-1"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") send();
                  }}
                />
                <Button onClick={send} disabled={reply.isPending || !body.trim()}>
                  {reply.isPending ? "Sending…" : "Send"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
