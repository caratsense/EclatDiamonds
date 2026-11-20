import { Badge } from "@/components/ui/badge";
import type {
  AgencyTaskStatus,
  CampaignStatus,
} from "@/lib/mock/marketing";

type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success";

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const map: Record<CampaignStatus, { label: string; variant: BadgeVariant }> =
    {
      planning: { label: "Planning", variant: "secondary" },
      in_review: { label: "In review", variant: "default" },
      live: { label: "Live", variant: "success" },
      completed: { label: "Completed", variant: "outline" },
    };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function AgencyTaskStatusBadge({
  status,
}: {
  status: AgencyTaskStatus;
}) {
  const map: Record<
    AgencyTaskStatus,
    { label: string; variant: BadgeVariant }
  > = {
    awaiting_brief: { label: "Awaiting brief", variant: "secondary" },
    in_progress: { label: "In progress", variant: "default" },
    submitted: { label: "Submitted", variant: "default" },
    approved: { label: "Approved", variant: "success" },
    changes_requested: { label: "Changes requested", variant: "destructive" },
  };
  const m = map[status];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}
