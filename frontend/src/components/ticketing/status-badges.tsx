import { Badge } from "@/components/ui/badge";
import type { TicketPriority, TicketStatus } from "@/lib/mock/ticketing";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success";

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const map: Record<TicketPriority, { label: string; variant: BadgeVariant }> =
    {
      low: { label: "Low", variant: "outline" },
      medium: { label: "Medium", variant: "secondary" },
      high: { label: "High", variant: "default" },
      urgent: { label: "Urgent", variant: "destructive" },
    };
  const m = map[priority];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const map: Record<TicketStatus, { label: string; variant: BadgeVariant }> = {
    open: { label: "Open", variant: "destructive" },
    routed: { label: "Routed", variant: "secondary" },
    in_progress: { label: "In progress", variant: "default" },
    resolved: { label: "Resolved", variant: "success" },
    closed: { label: "Closed", variant: "outline" },
  };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
