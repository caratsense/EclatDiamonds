import { Badge } from "@/components/ui/badge";
import type {
  RequestPriority,
  SpecialRequestStatus,
} from "@/lib/queries/special-requests";

const STATUS_META: Record<
  SpecialRequestStatus,
  { label: string; variant: "secondary" | "success" | "destructive" | "warning" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  escalated: { label: "Escalated", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Withdrawn", variant: "secondary" },
};

const PRIORITY_META: Record<
  RequestPriority,
  { label: string; variant: "secondary" | "warning" | "destructive" }
> = {
  low: { label: "Low", variant: "secondary" },
  medium: { label: "Medium", variant: "secondary" },
  high: { label: "High", variant: "warning" },
  urgent: { label: "Urgent", variant: "destructive" },
};

export function RequestStatusBadge({ status }: { status: SpecialRequestStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export function RequestPriorityBadge({ priority }: { priority: RequestPriority }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.medium;
  // Low and medium are the default state and add nothing worth a chip.
  if (priority === "low" || priority === "medium") return null;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
