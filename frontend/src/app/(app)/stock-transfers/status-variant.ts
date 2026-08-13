import type { TransferStatus } from "@/lib/queries/stock-transfers";

/** Badge colour per transfer status — shared by the list + detail views. */
export const STATUS_VARIANT: Record<
  TransferStatus,
  "default" | "secondary" | "destructive" | "success" | "outline" | "warning"
> = {
  draft: "outline",
  submitted: "secondary",
  ho_approved: "warning",
  dispatched: "secondary",
  received: "secondary",
  acknowledged: "success",
  rejected: "destructive",
  cancelled: "outline",
};
