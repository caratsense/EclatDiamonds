"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { format, parseISO } from "date-fns";
import {
  FileText,
  FileVideo,
  Image as ImageIcon,
  Type as TypeIcon,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { CampaignPlanner } from "@/components/marketing/campaign-planner";
import {
  AgencyTaskStatusBadge,
  CampaignStatusBadge,
} from "@/components/marketing/status-badges";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINRCompact } from "@/lib/format";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useAgencyTasks,
  useCampaigns,
  useCreateAgencyTask,
  useCreateAsset,
  useCreateCampaign,
  useMarketingAssets,
  useUpdateAgencyTask,
  useUpdateAssetStatus,
  type AssetStatus,
} from "@/lib/queries/marketing";
import {
  CAMPAIGN_TYPES,
  type AgencyTask,
  type Campaign,
  type CampaignType,
  type SharedAsset,
} from "@/lib/mock/marketing";
import { apiErrorMessage } from "@/lib/utils";

/** Marketing delivery channels offered when targeting a campaign. */
const CHANNEL_OPTIONS = [
  "Instagram",
  "WhatsApp",
  "Email",
  "SMS",
  "Print",
  "Google",
];

/** Raw deliverable statuses an area manager can set on an asset. */
const ASSET_TRANSITIONS: { status: AssetStatus; label: string }[] = [
  { status: "approved", label: "Approve" },
  { status: "changes_requested", label: "Request changes" },
  { status: "rejected", label: "Reject" },
];

/** Statuses a store manager can move an agency task through. */
const AGENCY_TASK_STATUSES: { value: AssetStatus; label: string }[] = [
  { value: "pending", label: "Awaiting brief" },
  { value: "in_progress", label: "In progress" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "rejected", label: "Rejected" },
];

const typeLabel = (key: Campaign["type"]) =>
  CAMPAIGN_TYPES.find((t) => t.key === key)?.label ?? key;

const ASSET_ICON = {
  video: FileVideo,
  image: ImageIcon,
  pdf: FileText,
  copy: TypeIcon,
} as const;

export default function MarketingPage() {
  const {
    data: campaigns = [],
    isLoading: campaignsLoading,
    isError: campaignsError,
    refetch: refetchCampaigns,
  } = useCampaigns();
  const {
    data: tasks = [],
    isLoading: tasksLoading,
    isError: tasksError,
    refetch: refetchTasks,
  } = useAgencyTasks();
  const {
    data: assets = [],
    isLoading: assetsLoading,
    isError: assetsError,
    refetch: refetchAssets,
  } = useMarketingAssets();
  const [newOpen, setNewOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  const role = useSession((s) => s.role);
  const canCreateCampaign = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const canCreateDeliverable = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const canApprove = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  return (
    <>
      <SectionHeader
        title="Marketing"
        purpose="Plan campaigns and track agency deliverables."
        primaryAction={canCreateCampaign ? "New Campaign" : undefined}
        onPrimaryAction={() => setNewOpen(true)}
      />

      <NewCampaignDialog open={newOpen} onOpenChange={setNewOpen} />
      <NewDeliverableDialog
        open={assetOpen}
        onOpenChange={setAssetOpen}
        campaigns={campaigns}
      />
      <NewAgencyTaskDialog
        open={taskOpen}
        onOpenChange={setTaskOpen}
        campaigns={campaigns}
      />

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="agency">Agency portal</TabsTrigger>
        </TabsList>

        {/* Campaign planner + cards */}
        <TabsContent value="campaigns" className="space-y-4">
          {campaignsLoading ? (
            <>
              <Skeleton className="h-64 w-full rounded-xl" />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-48 rounded-xl" />
                ))}
              </div>
            </>
          ) : campaignsError ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
                <p>Couldn&apos;t load campaigns.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchCampaigns()}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : campaigns.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                No campaigns yet. Create a campaign to get started.
              </CardContent>
            </Card>
          ) : (
            <>
              <CampaignPlanner campaigns={campaigns} />

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {campaigns.map((c) => (
                  <CampaignCard key={c.id} campaign={c} />
                ))}
              </div>
            </>
          )}
        </TabsContent>

        {/* Agency collaboration portal */}
        <TabsContent value="agency" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Agency tasks</CardTitle>
                  <CardDescription>
                    Tasks shared with external agencies — review and approve
                    submissions.
                  </CardDescription>
                </div>
                {canCreateDeliverable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={campaigns.length === 0}
                    onClick={() => setTaskOpen(true)}
                  >
                    New task
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {tasksLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : tasksError ? (
                <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  <p>Couldn&apos;t load agency tasks.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => refetchTasks()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Task</TableHead>
                      <TableHead>Agency</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead>Status</TableHead>
                      {canCreateDeliverable ? (
                        <TableHead className="text-right">Update</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((t) => (
                      <AgencyTaskRow
                        key={t.id}
                        task={t}
                        canUpdate={canCreateDeliverable}
                      />
                    ))}
                    {tasks.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={canCreateDeliverable ? 6 : 5}
                          className="py-10 text-center text-muted-foreground"
                        >
                          No agency tasks yet. Create a task to begin.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Creative assets</CardTitle>
                  <CardDescription>
                    Creative uploaded by agencies for sign-off.
                  </CardDescription>
                </div>
                {canCreateDeliverable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={campaigns.length === 0}
                    onClick={() => setAssetOpen(true)}
                  >
                    New asset
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {assetsLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-lg" />
                ))
              ) : assetsError ? (
                <div className="col-span-full rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  <p>Couldn&apos;t load shared assets.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => refetchAssets()}
                  >
                    Retry
                  </Button>
                </div>
              ) : assets.length === 0 ? (
                <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                  No creative assets yet. Agency uploads will appear here.
                </p>
              ) : (
                assets.map((a) => (
                  <AssetTile key={a.id} asset={a} canApprove={canApprove} />
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const pct = campaign.budget
    ? Math.round((campaign.spent / campaign.budget) * 100)
    : 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-snug">
            {campaign.name}
          </CardTitle>
          <CampaignStatusBadge status={campaign.status} />
        </div>
        <CardDescription>
          {typeLabel(campaign.type)}
          {campaign.agency ? ` · ${campaign.agency}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="num">
            {campaign.start ? format(parseISO(campaign.start), "dd MMM") : "—"} –{" "}
            {campaign.end
              ? format(parseISO(campaign.end), "dd MMM yyyy")
              : "—"}
          </span>
          <span>{campaign.owner}</span>
        </div>
        <div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Budget</span>
            <span className="num font-medium">
              {formatINRCompact(campaign.spent)} /{" "}
              {formatINRCompact(campaign.budget)}
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
        {campaign.channels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {campaign.channels.map((ch) => (
              <Badge key={ch} variant="outline" className="text-xs">
                {ch}
              </Badge>
            ))}
          </div>
        ) : null}
        {campaign.stores.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            <span className="num">{campaign.stores.length}</span> store
            {campaign.stores.length > 1 ? "s" : ""}:{" "}
            {campaign.stores.join(", ")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AssetTile({
  asset,
  canApprove,
}: {
  asset: SharedAsset;
  canApprove: boolean;
}) {
  const Icon = ASSET_ICON[asset.kind];
  const updateStatus = useUpdateAssetStatus();

  function setStatus(status: AssetStatus, label: string) {
    updateStatus.mutate(
      { id: asset.id, status },
      {
        onSuccess: () => toast.success(`Asset ${label.toLowerCase()}`),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the asset.")),
      },
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{asset.name}</p>
          <p className="text-xs text-muted-foreground">
            {asset.agency}
            {asset.updatedAt
              ? ` · ${format(parseISO(asset.updatedAt), "dd MMM")}`
              : ""}
          </p>
          <Badge
            variant={asset.approved ? "success" : "secondary"}
            className="mt-1.5 text-xs"
          >
            {asset.approved ? "Approved" : "Pending review"}
          </Badge>
        </div>
      </div>
      {canApprove ? (
        <div className="flex flex-wrap gap-1.5">
          {ASSET_TRANSITIONS.map((t) => (
            <Button
              key={t.status}
              size="sm"
              variant={t.status === "approved" ? "default" : "outline"}
              disabled={updateStatus.isPending}
              onClick={() => setStatus(t.status, t.label)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgencyTaskRow({
  task,
  canUpdate,
}: {
  task: AgencyTask;
  canUpdate: boolean;
}) {
  const updateTask = useUpdateAgencyTask();

  function change(status: AssetStatus) {
    updateTask.mutate(
      { id: task.id, status },
      {
        onSuccess: () => toast.success("Task updated"),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the task.")),
      },
    );
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{task.title}</TableCell>
      <TableCell>{task.agency}</TableCell>
      <TableCell className="text-muted-foreground">{task.assignee}</TableCell>
      <TableCell>
        {task.dueDate ? format(parseISO(task.dueDate), "dd MMM") : "—"}
      </TableCell>
      <TableCell>
        <AgencyTaskStatusBadge status={task.status} />
      </TableCell>
      {canUpdate ? (
        <TableCell className="text-right">
          <Select
            onValueChange={(v) => change(v as AssetStatus)}
            disabled={updateTask.isPending}
          >
            <SelectTrigger className="ml-auto h-8 w-40">
              <SelectValue placeholder="Set status" />
            </SelectTrigger>
            <SelectContent>
              {AGENCY_TASK_STATUSES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** A wrap of toggleable chips backing a lightweight multi-select. */
function ChipMultiSelect({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onToggle(o.value)}
            aria-pressed={active}
            className={
              active
                ? "rounded-full border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                : "rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function NewCampaignDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createCampaign = useCreateCampaign();
  // Stores the current user can target (exclude the synthetic "All Stores").
  const stores = useSession((s) => s.stores).filter((st) => !st.isAggregate);
  const [name, setName] = useState("");
  const [type, setType] = useState<CampaignType>("festive");
  const [budget, setBudget] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);

  function toggle(
    setter: Dispatch<SetStateAction<string[]>>,
    value: string,
  ) {
    setter((prev) =>
      prev.includes(value)
        ? prev.filter((v) => v !== value)
        : [...prev, value],
    );
  }

  function reset() {
    setName("");
    setType("festive");
    setBudget("");
    setStartDate("");
    setEndDate("");
    setStoreIds([]);
    setChannels([]);
  }

  function save() {
    if (!name.trim()) {
      toast.error("Campaign name is required.");
      return;
    }
    const budgetNum = budget.trim() ? Number(budget) : undefined;
    if (budgetNum != null && (Number.isNaN(budgetNum) || budgetNum < 0)) {
      toast.error("Enter a valid budget.");
      return;
    }
    createCampaign.mutate(
      {
        name: name.trim(),
        type,
        budget: budgetNum,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        storeIds: storeIds.length ? storeIds : undefined,
        channels: channels.length ? channels : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Campaign created");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not create campaign.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            Set up a marketing campaign for the planner.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              id="campaign-name"
              placeholder="e.g. Diwali Festive Drop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-type">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as CampaignType)}
            >
              <SelectTrigger id="campaign-type">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_TYPES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-budget">Budget (₹)</Label>
            <Input
              id="campaign-budget"
              type="number"
              min={0}
              placeholder="e.g. 500000"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="campaign-start">Start date</Label>
              <Input
                id="campaign-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="campaign-end">End date</Label>
              <Input
                id="campaign-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Target stores</Label>
            <ChipMultiSelect
              options={stores.map((st) => ({ value: st.id, label: st.name }))}
              selected={storeIds}
              onToggle={(v) => toggle(setStoreIds, v)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for a pan-India campaign.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label>Channels</Label>
            <ChipMultiSelect
              options={CHANNEL_OPTIONS.map((c) => ({ value: c, label: c }))}
              selected={channels}
              onToggle={(v) => toggle(setChannels, v)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createCampaign.isPending}>
            {createCampaign.isPending ? "Saving…" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DELIVERABLE_TYPES = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "pdf", label: "PDF" },
  { value: "copy", label: "Copy" },
];

function NewDeliverableDialog({
  open,
  onOpenChange,
  campaigns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaigns: Campaign[];
}) {
  const createAsset = useCreateAsset();
  const [campaignId, setCampaignId] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("image");
  const [url, setUrl] = useState("");

  function reset() {
    setCampaignId("");
    setTitle("");
    setType("image");
    setUrl("");
  }

  function save() {
    if (!campaignId) {
      toast.error("Pick a campaign.");
      return;
    }
    if (!title.trim()) {
      toast.error("An asset title is required.");
      return;
    }
    createAsset.mutate(
      {
        campaignId,
        title: title.trim(),
        type,
        url: url.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Asset added");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not add the asset.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New asset</DialogTitle>
          <DialogDescription>
            Attach a creative asset to a campaign for sign-off.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="asset-campaign">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger id="asset-campaign">
                <SelectValue placeholder="Select a campaign" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="asset-title">Title</Label>
            <Input
              id="asset-title"
              placeholder="e.g. bridal_hero_v1.mp4"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="asset-type">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="asset-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIVERABLE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="asset-url">Link</Label>
              <Input
                id="asset-url"
                placeholder="Optional URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createAsset.isPending}>
            {createAsset.isPending ? "Saving…" : "Add asset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewAgencyTaskDialog({
  open,
  onOpenChange,
  campaigns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaigns: Campaign[];
}) {
  const createTask = useCreateAgencyTask();
  const [campaignId, setCampaignId] = useState("");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");

  function reset() {
    setCampaignId("");
    setTitle("");
    setAssignee("");
    setDueDate("");
  }

  function save() {
    if (!campaignId) {
      toast.error("Pick a campaign.");
      return;
    }
    if (!title.trim()) {
      toast.error("A task title is required.");
      return;
    }
    createTask.mutate(
      {
        campaignId,
        title: title.trim(),
        assignee: assignee.trim() || undefined,
        dueDate: dueDate || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Agency task created");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not create the task.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Brief an agency on a campaign task.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="task-campaign">Campaign</Label>
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger id="task-campaign">
                <SelectValue placeholder="Select a campaign" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              placeholder="e.g. Instagram carousel — necklace edit"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="task-assignee">Assignee</Label>
              <Input
                id="task-assignee"
                placeholder="Optional"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createTask.isPending}>
            {createTask.isPending ? "Saving…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
