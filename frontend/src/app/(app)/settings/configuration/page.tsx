"use client";

import { useState } from "react";
import { Boxes, Building2, Languages, Layers, Plus, Sparkles, Tag } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PipelineConfig } from "@/components/crm/pipeline-config";
import { QualificationConfig } from "@/components/crm/qualification-config";
import { AdSetAutomationConfig } from "@/components/crm/adset-automation-config";
import { useT } from "@/lib/i18n";
import { NAV_ITEMS } from "@/lib/navigation";
import {
  type ConfigBootstrap,
  useApplyPack,
  useConfigBootstrap,
  useCreateTerm,
  useIndustryPacks,
  useUpdateTerm,
  useUpsertAttribute,
} from "@/lib/queries/tenant-config";
import { useBackfillIdentity, useMergeCandidates } from "@/lib/queries/crm";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Business configuration (CaratOS Phase A2/A11) — the screen that makes CaratOS
 * industry-neutral without a code change.
 *
 * The industry pack seeds a starting vocabulary; everything after that is the
 * tenant's. Re-applying a pack only ADDS what is missing, so a term someone
 * renamed here survives every future release — the UI says so, because an admin
 * who does not believe that will not risk editing anything.
 */
export default function ConfigurationPage() {
  const { data: config, isLoading } = useConfigBootstrap();
  const { data: packs } = useIndustryPacks();
  const applyPack = useApplyPack();
  /** The industry the user has asked to switch to, pending confirmation. */
  const [pendingPack, setPending] = useState<{ code: string; name: string } | null>(null);

  async function apply(code: string, name: string) {
    setPending(null);
    try {
      const r = await applyPack.mutateAsync(code);
      toast.success(r.packName ?? name, { description: r.message });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save that change."));
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Business configuration"
        purpose="What your business calls things, and which fields your team fills in."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4" />
            Industry
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="text-sm font-medium">
                {config?.industry.packName ?? "No industry chosen"}
              </p>
              <p className="text-xs text-muted-foreground">
                {config?.organisation.country} · {config?.organisation.currency} ·{" "}
                {config?.organisation.timezone} · configuration v
                {config?.organisation.configVersion}
              </p>
            </div>
            {config?.industry.upgradeAvailable && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                A newer version of this pack is available
              </Badge>
            )}
            {config?.industry.packMissing && (
              <Badge variant="destructive">
                This release does not contain the recorded pack
              </Badge>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {packs?.packs.map((p) => {
              const current = config?.industry.packCode === p.code;
              return (
                <div
                  key={p.code}
                  className={`rounded-lg border p-3 ${current ? "border-primary" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{p.name}</p>
                    {current && <Badge>Current</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                  <Button
                    size="sm"
                    variant={current ? "outline" : "default"}
                    className="mt-3 w-full"
                    disabled={applyPack.isPending}
                    onClick={() => {
                      // Re-applying the CURRENT industry is additive and cannot
                      // remove anything, so it goes straight through. SWITCHING
                      // is a different act: it changes which sections the whole
                      // organisation sees, and that is not something anyone
                      // should be able to do to every colleague by misreading a
                      // row of buttons. Confirm first.
                      if (current) return apply(p.code, p.name);
                      setPending({ code: p.code, name: p.name });
                    }}
                  >
                    {current ? "Re-apply / update" : "Use this"}
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Your vocabulary, custom fields and sales stages are only ever added to — anything
            you have renamed or created yourself is kept exactly as it is. Your industry does
            decide which sections your team sees in the menu, so changing it changes that list.
          </p>
        </CardContent>
      </Card>

      <IndustryEffect config={config} />

      <Tabs defaultValue="taxonomy">
        <TabsList>
          <TabsTrigger value="taxonomy">Vocabulary</TabsTrigger>
          <TabsTrigger value="fields">Custom fields</TabsTrigger>
          <TabsTrigger value="pipeline">Sales stages</TabsTrigger>
          <TabsTrigger value="qualification">Lead scoring</TabsTrigger>
          <TabsTrigger value="ad-routing">Ad routing</TabsTrigger>
          <TabsTrigger value="identity">Customer identity</TabsTrigger>
        </TabsList>

        <TabsContent value="taxonomy" className="mt-4 space-y-4">
          {Object.entries(config?.taxonomies ?? {}).length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No vocabulary yet"
              description="Choose an industry above to get a starting set of terms you can then edit."
            />
          ) : (
            Object.entries(config!.taxonomies).map(([kind, vocab]) => (
              <VocabularyCard key={kind} kind={kind} vocab={vocab} />
            ))
          )}
        </TabsContent>

        <TabsContent value="fields" className="mt-4 space-y-4">
          <CustomFields config={config} />
        </TabsContent>

        <TabsContent value="pipeline" className="mt-4 space-y-4">
          <PipelineConfig />
        </TabsContent>

        <TabsContent value="qualification" className="mt-4 space-y-4">
          <QualificationConfig />
        </TabsContent>

        <TabsContent value="ad-routing" className="mt-4 space-y-4">
          <AdSetAutomationConfig />
        </TabsContent>

        <TabsContent value="identity" className="mt-4 space-y-4">
          <IdentityAdmin />
        </TabsContent>
      </Tabs>

      <Dialog open={!!pendingPack} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change your industry to {pendingPack?.name}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              This changes the words the app uses and which sections everyone in your
              organisation sees in the menu. It takes effect for your whole team.
            </p>
            <p className="text-muted-foreground">
              Nothing is deleted: your existing vocabulary, custom fields and sales stages stay
              exactly as they are, and {pendingPack?.name}&apos;s are added alongside them. You
              can switch back at any time.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={applyPack.isPending}
              onClick={() => pendingPack && apply(pendingPack.code, pendingPack.name)}
            >
              Change industry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * What choosing this industry actually did.
 *
 * The industry picker above is a row of buttons whose effect is otherwise
 * invisible until someone notices the sidebar has changed. This says it plainly:
 * the words the product now uses, and the sections it now includes. It is
 * read-only on purpose — these come from the pack, and inventing an editor for
 * them here would imply a per-tenant override that does not exist yet.
 */
function IndustryEffect({ config }: { config: ConfigBootstrap | undefined }) {
  // Through the tenant's vocabulary, like the sidebar these badges describe —
  // otherwise this card lists "Customers" while the menu beside it says
  // "Patients", and the screen explaining the relabelling is the one place it
  // has not been applied.
  const t = useT();
  const labels = Object.entries(config?.labels ?? {});
  const sections = config?.industry.enabledNavigation ?? null;
  const words = WORDS.map(([key, caption]) => ({
    caption,
    value: config?.lexicon?.[key],
  })).filter((w) => !!w.value);

  if (!config) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Languages className="h-4 w-4" />
          What this industry sets up
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-sm font-medium">The words your team sees</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {labels.length === 0
              ? "This industry uses the standard wording, so nothing is renamed."
              : `${labels.length} label${labels.length === 1 ? "" : "s"} across the app use your industry's words.`}
          </p>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {words.map((w) => (
              <div key={w.caption} className="rounded-lg border px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {w.caption}
                </p>
                <p className="text-sm font-medium">{w.value}</p>
              </div>
            ))}
          </div>
        </div>

        {config.industry.aiContext ? (
          <div>
            <p className="text-sm font-medium">What your assistant is for</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The subject your CRM assistant is briefed on when it drafts a reply. It only ever
              answers from documents you have added.
            </p>
            <p className="mt-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {config.industry.aiContext}
            </p>
          </div>
        ) : null}

        <div>
          <p className="text-sm font-medium">The sections it includes</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {sections
              ? "Your team sees these in the sidebar. Changing industry changes the list."
              : "This release does not recognise your saved industry, so nothing is hidden."}
          </p>
          {sections ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {sections.map((slug) => (
                <Badge key={slug} variant="secondary" className="font-normal">
                  {t(NAV_TITLE[slug] ?? slug, NAV_TITLE[slug] ?? slug)}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Nouns worth showing, with the question each one answers. */
const WORDS: [string, string][] = [
  ["customer_plural", "People you sell to"],
  ["lead_plural", "New enquiries"],
  ["product_plural", "What you offer"],
  ["catalogue", "Where you browse them"],
  ["store_plural", "Your locations"],
];

/** Route slug -> the name the sidebar gives it, for the section list above. */
const NAV_TITLE: Record<string, string> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.slug, item.title]),
);

function VocabularyCard({
  kind,
  vocab,
}: {
  kind: string;
  vocab: { label: string; systemBacked: boolean; terms: { id: string; code: string; label: string; packCode: string | null; systemValue: string | null }[] };
}) {
  const createTerm = useCreateTerm();
  const updateTerm = useUpdateTerm();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");

  const add = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    // A code is derived from the label so an admin never has to think about slugs.
    const code = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    try {
      await createTerm.mutateAsync({ kind, code, label: trimmed });
      setLabel("");
      setAdding(false);
      toast.success(`Added "${trimmed}"`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save that change."));
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" />
            {vocab.label}
          </CardTitle>
          {vocab.systemBacked && (
            <p className="mt-1 text-xs text-muted-foreground">
              Built-in list. You can rename these; new entries are labels only and will not
              change how existing reports group this field.
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {adding && (
          <div className="flex gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="New term"
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <Button size="sm" onClick={add} disabled={createTerm.isPending}>
              Save
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {vocab.terms.map((t) => (
            <button
              key={t.id}
              className="group rounded-full border px-3 py-1 text-sm hover:bg-accent"
              onClick={() => {
                const next = window.prompt(`Rename "${t.label}" to:`, t.label);
                if (next && next.trim() && next !== t.label) {
                  updateTerm.mutate(
                    { id: t.id, label: next.trim() },
                    { onError: (e) => toast.error(apiErrorMessage(e, "Could not save that change.")) },
                  );
                }
              }}
              title={t.packCode ? `From the ${t.packCode} pack` : "Created by your team"}
            >
              {t.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CustomFields({ config }: { config: ReturnType<typeof useConfigBootstrap>["data"] }) {
  const upsert = useUpsertAttribute();
  const [entity, setEntity] = useState("product");
  const [label, setLabel] = useState("");

  const add = async () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    try {
      await upsert.mutateAsync({ entity, key, label: trimmed, dataType: "text" });
      setLabel("");
      toast.success(`Added "${trimmed}"`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save that change."));
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4" />
            Add a field
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>Applies to</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
            >
              {(config?.configurableEntities ?? ["product", "party", "lead"]).map((e) => (
                <option key={e} value={e}>
                  {e === "party" ? "customer" : e}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <Label>Field name</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Warranty period"
            />
          </div>
          <Button onClick={add} disabled={upsert.isPending || !label.trim()}>
            Add field
          </Button>
        </CardContent>
      </Card>

      {Object.entries(config?.attributes ?? {}).map(([ent, attrs]) => (
        <Card key={ent}>
          <CardHeader>
            <CardTitle className="text-base capitalize">
              {ent === "party" ? "Customer" : ent} fields
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {attrs.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <span className="font-medium">{a.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{a.key}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{a.dataType}</Badge>
                  {a.unit && <Badge variant="outline">{a.unit}</Badge>}
                  {a.required && <Badge>required</Badge>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </>
  );
}

/**
 * Customer identity admin. The backfill turns existing phone/email columns into
 * matchable contact records; conflicts are surfaced for a human rather than
 * merged, because merging the wrong two customers is close to unrecoverable.
 */
function IdentityAdmin() {
  const backfill = useBackfillIdentity();
  const { data: candidates } = useMergeCandidates();

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" />
            Build customer matching
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Turns the phone numbers and emails already on your customer records into matchable
            contact details, so a WhatsApp message, a walk-in and a sale all recognise the same
            person. Safe to run more than once — it never moves a detail that already belongs to
            another customer.
          </p>
          <Button
            onClick={async () => {
              try {
                const r = await backfill.mutateAsync(1000);
                toast.success(`${r.created} contact record(s) created`, {
                  description: r.message,
                });
              } catch (e) {
                toast.error(apiErrorMessage(e, "Could not save that change."));
              }
            }}
            disabled={backfill.isPending}
          >
            {backfill.isPending ? "Working…" : "Run matching"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Possible duplicates</CardTitle>
        </CardHeader>
        <CardContent>
          {!candidates?.length ? (
            <p className="text-sm text-muted-foreground">
              Nothing to review. Two customers sharing a phone number would show up here.
            </p>
          ) : (
            <div className="space-y-2">
              {candidates.map((c) => (
                <div key={c.id} className="rounded-md border px-3 py-2 text-sm">
                  <p>
                    <span className="font-medium">{c.primaryParty?.name}</span> and{" "}
                    <span className="font-medium">{c.duplicateParty?.name ?? "an unknown sender"}</span>{" "}
                    share the same {c.matchKind}.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.reason ?? "Raised automatically."} Nothing has been changed.
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
