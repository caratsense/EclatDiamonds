"use client";

import { useMemo, useState } from "react";
import { Code2, Copy, Globe, Lock, Power, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
  useCreateLeadForm,
  useLeadForms,
  useUpdateLeadForm,
  type LeadForm,
} from "@/lib/queries/lead-forms";
import { ROLE_RANK } from "@/lib/types";
import { useHydrated } from "@/lib/use-reset-on";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

export default function LeadFormsPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const currentStore = useSession((s) => s.currentStore);
  const hydrated = useHydrated();

  const forms = useLeadForms();
  const create = useCreateLeadForm();
  const update = useUpdateLeadForm();

  const realStores = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);
  const [storeId, setStoreId] = useState(
    () => (currentStore?.isAggregate ? "" : currentStore?.id) ?? "",
  );
  const [name, setName] = useState("");
  const [defaultInterest, setDefaultInterest] = useState("");
  const [campaign, setCampaign] = useState("");

  const origin = hydrated ? window.location.origin : "";

  if (ROLE_RANK[role] < ROLE_RANK.store_manager) {
    return (
      <div className="space-y-6">
        <SectionHeader
          title="Website enquiry forms"
          purpose="Turn an enquiry on your own website into a lead for a branch."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Lock className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Managers and above</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                Publishing a form creates a link that accepts enquiries for a
                branch without anyone signing in, so it is a manager&apos;s
                decision.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const submit = () => {
    if (!name.trim()) {
      toast.error("Give the form a name so your team can tell it apart.");
      return;
    }
    if (!storeId) {
      toast.error("Choose which branch these enquiries belong to.");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        storeId,
        ...(defaultInterest.trim() ? { defaultInterest: defaultInterest.trim() } : {}),
        ...(campaign.trim() ? { campaign: campaign.trim() } : {}),
      },
      {
        onSuccess: (form) => {
          toast.success(`"${form.name}" is live.`);
          setName("");
          setDefaultInterest("");
          setCampaign("");
        },
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not create the form. Please try again.")),
      },
    );
  };

  const toggle = (form: LeadForm) => {
    update.mutate(
      { id: form.id, enabled: !form.enabled },
      {
        onSuccess: () =>
          toast.success(form.enabled ? `"${form.name}" turned off.` : `"${form.name}" turned back on.`),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not change the form.")),
      },
    );
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch {
      toast.error("Could not copy — select it and copy by hand.");
    }
  };

  const embedFor = (form: LeadForm) =>
    `<a href="${origin}${form.submitPath}">Enquire now</a>`;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Website enquiry forms"
        purpose="Turn an enquiry on your own website into a lead for a branch."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" />
              Publish a form
            </CardTitle>
            <CardDescription>
              You get a link to put on your website. Anyone who fills it in
              becomes a lead for the branch you pick, with follow-ups already
              scheduled.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Form name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Homepage enquiry"
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">
                Only your team sees this.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Branch</Label>
              <Select value={storeId} onValueChange={setStoreId}>
                <SelectTrigger>
                  <SelectValue placeholder="Which branch is this for?" />
                </SelectTrigger>
                <SelectContent>
                  {realStores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>What is it about?</Label>
              <Input
                value={defaultInterest}
                onChange={(e) => setDefaultInterest(e.target.value)}
                placeholder="General enquiry"
                maxLength={280}
              />
              <p className="text-xs text-muted-foreground">
                Used when a visitor leaves the enquiry box empty, so the lead
                still says what it was about.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Campaign (optional)</Label>
              <Input
                value={campaign}
                onChange={(e) => setCampaign(e.target.value)}
                placeholder="spring-2026"
                maxLength={120}
              />
            </div>

            <Button onClick={submit} disabled={create.isPending} className="w-full">
              {create.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <Globe className="mr-2 h-4 w-4" />
                  Publish form
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your forms</CardTitle>
            <CardDescription>
              Anyone holding a form&apos;s link can file a lead for its branch,
              so share it the way you would a key to the counter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {forms.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : forms.isError ? (
              <p className="text-sm text-muted-foreground">
                {apiErrorMessage(forms.error, "Could not load your forms.")}
              </p>
            ) : !forms.data?.length ? (
              <EmptyState
                icon={Globe}
                title="No forms yet"
                description="Publish one and paste its link into your website."
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Form</TableHead>
                      <TableHead>Branch</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Link</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forms.data.map((form) => (
                      <TableRow key={form.id}>
                        <TableCell>
                          <div className="font-medium">{form.name}</div>
                          {form.campaign ? (
                            <div className="text-xs text-muted-foreground">
                              {form.campaign}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">{form.storeName}</TableCell>
                        <TableCell>
                          <Badge variant={form.enabled ? "success" : "outline"}>
                            {form.enabled ? "Live" : "Off"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => copy(`${origin}${form.submitPath}`, "Link")}
                            >
                              <Copy className="mr-1.5 h-3.5 w-3.5" />
                              Link
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => copy(embedFor(form), "Embed code")}
                            >
                              <Code2 className="mr-1.5 h-3.5 w-3.5" />
                              Embed
                            </Button>
                            <Button
                              size="sm"
                              variant={form.enabled ? "outline" : "default"}
                              onClick={() => toggle(form)}
                              disabled={update.isPending}
                            >
                              <Power className="mr-1.5 h-3.5 w-3.5" />
                              {form.enabled ? "Turn off" : "Turn on"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
