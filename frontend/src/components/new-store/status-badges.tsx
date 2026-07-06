import { Badge } from "@/components/ui/badge";
import type {
  ChecklistStatus,
  MilestoneState,
  VendorStatus,
} from "@/lib/mock/new-store";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning";

export function ChecklistStatusBadge({ status }: { status: ChecklistStatus }) {
  const map: Record<ChecklistStatus, { label: string; variant: BadgeVariant }> =
    {
      done: { label: "Done", variant: "success" },
      in_progress: { label: "In progress", variant: "default" },
      blocked: { label: "Blocked", variant: "destructive" },
      todo: { label: "To do", variant: "secondary" },
    };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function VendorStatusBadge({ status }: { status: VendorStatus }) {
  const map: Record<VendorStatus, { label: string; variant: BadgeVariant }> = {
    on_track: { label: "On track", variant: "success" },
    at_risk: { label: "At risk", variant: "warning" },
    delayed: { label: "Delayed", variant: "destructive" },
    completed: { label: "Completed", variant: "secondary" },
  };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function MilestoneStateBadge({ state }: { state: MilestoneState }) {
  const map: Record<MilestoneState, { label: string; variant: BadgeVariant }> =
    {
      complete: { label: "Complete", variant: "success" },
      current: { label: "In progress", variant: "default" },
      at_risk: { label: "At risk", variant: "warning" },
      upcoming: { label: "Upcoming", variant: "secondary" },
    };
  const m = map[state];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

/** Simple track-fill progress bar (no shadcn progress component installed). */
export function ProgressBar({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <div
      className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
