import type { TransferStatus } from "@/lib/queries/stock-transfers";

/** Badge colour per transfer status — shared by the list + detail views. */
export const STATUS_VARIANT: Record<
  TransferStatus,
  "default" | "secondary" | "destructive" | "success" | "outline" | "warning"
> = {
  draft: "outline",
  // Waiting on a person at another branch, which is the one state somebody has
  // to chase. It reads like the other "somebody must act" stage, HO approved.
  pending_source: "warning",
  submitted: "secondary",
  ho_approved: "warning",
  dispatched: "secondary",
  received: "secondary",
  acknowledged: "success",
  // A branch keeping its own stock is a normal answer, not a failure — the
  // same muted treatment as a withdrawn request rather than a red one.
  declined: "outline",
  rejected: "destructive",
  cancelled: "outline",
};
