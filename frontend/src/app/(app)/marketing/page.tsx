"use client";

import { useState } from "react";
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
import {
  useAgencyTasks,
  useCampaigns,
  useCreateCampaign,
  useMarketingAssets,
} from "@/lib/queries/marketing";
import {
  CAMPAIGN_TYPES,
  type Campaign,
  type CampaignType,
  type SharedAsset,
} from "@/lib/mock/marketing";

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

  return (
    <>
      <SectionHeader
        title="Marketing"
        purpose="Coordinate external campaigns and agency deliverables."
        primaryAction="New Campaign"
        onPrimaryAction={() => setNewOpen(true)}
      />

      <NewCampaignDialog open={newOpen} onOpenChange={setNewOpen} />

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
              <CardTitle className="text-base">Shared deliverables</CardTitle>
              <CardDescription>
                Tasks shared with external agencies — review and approve
                submissions.
              </CardDescription>
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
                      <TableHead>Deliverable</TableHead>
                      <TableHead>Agency</TableHead>
                      <TableHead>Assignee</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-center">Assets</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.title}</TableCell>
                        <TableCell>{t.agency}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.assignee}
                        </TableCell>
                        <TableCell>
                          {t.dueDate
                            ? format(parseISO(t.dueDate), "dd MMM")
                            : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="num">{t.assetCount}</span>
                        </TableCell>
                        <TableCell>
                          <AgencyTaskStatusBadge status={t.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {tasks.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-10 text-center text-muted-foreground"
                        >
                          No agency tasks yet. Share a deliverable to begin.
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
              <CardTitle className="text-base">Shared assets</CardTitle>
              <CardDescription>
                Creative uploaded by agencies for sign-off.
              </CardDescription>
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
                  No shared assets yet. Agency uploads will appear here.
                </p>
              ) : (
                assets.map((a) => <AssetTile key={a.id} asset={a} />)
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

function AssetTile({ asset }: { asset: SharedAsset }) {
  const Icon = ASSET_ICON[asset.kind];
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
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
  const [name, setName] = useState("");
  const [type, setType] = useState<CampaignType>("festive");
  const [budget, setBudget] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  function reset() {
    setName("");
    setType("festive");
    setBudget("");
    setStartDate("");
    setEndDate("");
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
      },
      {
        onSuccess: () => {
          toast.success("Campaign created");
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not create campaign."),
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
