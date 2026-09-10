"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Plus, RefreshCw, ShieldCheck, Trash2, Users } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  SEGMENT_FIELD_GROUPS,
  useAudiencePreview,
  useCreateCampaign,
  useSubmitCampaign,
  type SegmentCondition,
  type SegmentDefinition,
} from "@/lib/queries/campaigns";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The campaign wizard.
 *
 * Six steps, and the ordering is not cosmetic: the audience is chosen and
 * PREVIEWED before a template is picked, so the person writing the message
 * already knows how many people will read it. Preview is also the only place the
 * count comes from — it is a database aggregate, not the length of the sample
 * rows shown beneath it.
 */

const STEPS = ["Details", "Audience", "Message", "Schedule", "Review"] as const;
type Step = (typeof STEPS)[number];

const ALL_FIELDS = SEGMENT_FIELD_GROUPS.flatMap((g) => g.fields);

function fieldMeta(field: string) {
  return ALL_FIELDS.find((f) => f.field === field);
}

/** Ops that take a plain number rather than a list of values. */
const NUMERIC_OPS = new Set(["within_days", "older_than_days", "gte", "lte"]);
/** Ops that take nothing at all. */
const NULLARY_OPS = new Set(["is_set", "is_not_set"]);

export default function NewCampaignPage() {
  const router = useRouter();
  const stores = useSession((s) => s.stores);
  const realStores = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);

  const [step, setStep] = useState<Step>("Details");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<SegmentCondition[]>([
    { field: "party.type", op: "in", value: ["customer"] },
  ]);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateLanguage, setTemplateLanguage] = useState("en_US");
  const [bodyPreview, setBodyPreview] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");

  const preview = useAudiencePreview();
  const create = useCreateCampaign();
  const submit = useSubmitCampaign();

  const definition: SegmentDefinition = { match, conditions };

  const index = STEPS.indexOf(step);
  const go = (delta: number) => setStep(STEPS[Math.min(Math.max(index + delta, 0), STEPS.length - 1)]);

  const runPreview = () => {
    preview.mutate(
      { definition, ...(storeIds.length ? { storeIds } : {}) },
      {
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not work out who this campaign would reach.")),
      },
    );
  };

  const updateCondition = (i: number, patch: Partial<SegmentCondition>) => {
    setConditions((prev) => prev.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  };

  const finish = () => {
    if (!name.trim()) {
      toast.error("Give the campaign a name.");
      setStep("Details");
      return;
    }
    if (!templateName.trim()) {
      toast.error("Choose the approved template this campaign sends.");
      setStep("Message");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        definition,
        templateName: templateName.trim(),
        templateLanguage: templateLanguage.trim(),
        ...(bodyPreview.trim() ? { bodyPreview: bodyPreview.trim() } : {}),
        ...(storeIds.length ? { storeIds } : {}),
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      },
      {
        onSuccess: (campaign) => {
          submit.mutate(
            { id: campaign.id },
            {
              onSuccess: () => {
                toast.success(`"${campaign.name}" is waiting for approval.`);
                router.push(`/campaigns/${campaign.id}`);
              },
              onError: (e) => {
                // The campaign exists as a draft; say so rather than implying
                // the whole thing was lost.
                toast.error(
                  apiErrorMessage(e, "Saved as a draft, but could not send it for approval."),
                );
                router.push(`/campaigns/${campaign.id}`);
              },
            },
          );
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not create the campaign.")),
      },
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="New campaign"
        purpose="Choose who it reaches, then what it says. Consent is checked again for every person at the moment of sending."
      />

      {/* Step rail. Numbered because these steps are a real sequence: the
          audience decides the count the message is written for. */}
      <div className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(s)}
            className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
              i === index
                ? "border-foreground bg-foreground text-background"
                : i < index
                  ? "border-border bg-muted text-foreground"
                  : "border-border text-muted-foreground"
            }`}
          >
            <span className="font-[family-name:var(--font-mono-face)]">{i + 1}</span>
            {s}
          </button>
        ))}
      </div>

      {step === "Details" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What is this campaign?</CardTitle>
            <CardDescription>Only your team sees these.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Campaign name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="September reminder"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Purpose (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Why this is going out, and to whom."
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "Audience" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Who should receive it?</CardTitle>
              <CardDescription>
                Rules are checked against your own records. Nobody outside your
                organisation can ever match.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Match</span>
                <Select value={match} onValueChange={(v) => setMatch(v as "all" | "any")}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all of these</SelectItem>
                    <SelectItem value="any">any of these</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                {conditions.map((c, i) => {
                  const meta = fieldMeta(c.field);
                  return (
                    <div
                      key={i}
                      className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                    >
                      <Select
                        value={c.field}
                        onValueChange={(field) => {
                          const next = fieldMeta(field);
                          updateCondition(i, {
                            field,
                            op: next?.ops[0]?.op ?? "in",
                            value: undefined,
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEGMENT_FIELD_GROUPS.map((group) => (
                            <div key={group.label}>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                {group.label}
                              </div>
                              {group.fields.map((f) => (
                                <SelectItem key={f.field} value={f.field}>
                                  {f.label}
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select value={c.op} onValueChange={(op) => updateCondition(i, { op, value: undefined })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(meta?.ops ?? [{ op: "in", label: "is one of" }]).map((o) => (
                            <SelectItem key={o.op} value={o.op}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {NULLARY_OPS.has(c.op) ? (
                        <div className="flex items-center text-xs text-muted-foreground">
                          No value needed
                        </div>
                      ) : (
                        <Input
                          value={
                            Array.isArray(c.value) ? c.value.join(", ") : (c.value as string) ?? ""
                          }
                          onChange={(e) =>
                            updateCondition(i, {
                              value: NUMERIC_OPS.has(c.op)
                                ? Number(e.target.value)
                                : e.target.value.split(",").map((v) => v.trim()).filter(Boolean),
                            })
                          }
                          placeholder={NUMERIC_OPS.has(c.op) ? "30" : "customer, supplier"}
                          inputMode={NUMERIC_OPS.has(c.op) ? "numeric" : "text"}
                        />
                      )}

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setConditions((prev) => prev.filter((_, n) => n !== i))}
                        disabled={conditions.length === 1}
                        aria-label="Remove this rule"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>

                      {meta?.hint ? (
                        <p className="text-xs text-muted-foreground sm:col-span-4">{meta.hint}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConditions((prev) => [...prev, { field: "party.city", op: "in", value: [] }])
                  }
                  disabled={conditions.length >= 25}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add a rule
                </Button>
                <Button size="sm" onClick={runPreview} disabled={preview.isPending}>
                  {preview.isPending ? (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Users className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Count who this reaches
                </Button>
              </div>

              {realStores.length > 1 ? (
                <div className="space-y-1.5 border-t border-border pt-4">
                  <Label>Branches (optional)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {realStores.map((s) => {
                      const on = storeIds.includes(s.id);
                      return (
                        <Button
                          key={s.id}
                          size="sm"
                          variant={on ? "default" : "outline"}
                          onClick={() =>
                            setStoreIds((prev) =>
                              on ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                            )
                          }
                        >
                          {s.name}
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Leave all off to include every branch you can see.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Who this reaches</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!preview.data ? (
                <p className="text-sm text-muted-foreground">
                  Press <span className="font-medium">Count who this reaches</span> to see the real
                  number before you write anything.
                </p>
              ) : (
                <>
                  <div>
                    <div className="font-[family-name:var(--font-display-face)] text-4xl tabular-nums">
                      {preview.data.total.toLocaleString()}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      people match. {preview.data.contactable.toLocaleString()} have a number we can
                      message.
                    </p>
                  </div>

                  <div className="space-y-1 rounded-md border border-border p-3 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">No phone or WhatsApp</span>
                      <span className="tabular-nums">{preview.data.excluded.noContactPoint}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Blocked customers</span>
                      <span className="tabular-nums">{preview.data.excluded.blocked}</span>
                    </div>
                  </div>

                  {/* The honest caveat, on the screen where the decision is made
                      rather than buried in a document. */}
                  <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <p className="text-muted-foreground">
                      Marketing consent is checked again for every person when the message is
                      actually sent, so the number that receives it can be lower than this. Anyone
                      who has replied STOP is never messaged.
                    </p>
                  </div>

                  <div>
                    <p className="mb-1.5 text-xs font-medium">Because</p>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {preview.data.reasons.map((r, i) => (
                        <li key={i}>• {r}</li>
                      ))}
                    </ul>
                  </div>

                  {preview.data.sample.length ? (
                    <div>
                      <p className="mb-1.5 text-xs font-medium">
                        A few of them
                        {preview.data.sampleCapped ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            (showing {preview.data.sample.length})
                          </span>
                        ) : null}
                      </p>
                      <ul className="space-y-1 text-xs">
                        {preview.data.sample.slice(0, 8).map((p) => (
                          <li key={p.id} className="flex items-center justify-between gap-2">
                            <span className="truncate">{p.name}</span>
                            <span className="shrink-0 font-[family-name:var(--font-mono-face)] text-muted-foreground">
                              {p.contact ?? "no number"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {step === "Message" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What does it say?</CardTitle>
            <CardDescription>
              WhatsApp only allows an approved template for a message a customer did not ask for.
              Enter the template exactly as it is registered, including its language.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="space-y-1.5">
                <Label>Template name</Label>
                <Input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="appointment_reminder"
                  maxLength={512}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Input
                  value={templateLanguage}
                  onChange={(e) => setTemplateLanguage(e.target.value)}
                  placeholder="en_US"
                  maxLength={16}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>What it looks like (optional)</Label>
              <Textarea
                value={bodyPreview}
                onChange={(e) => setBodyPreview(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Paste the approved wording here so your approver can read it."
              />
              <p className="text-xs text-muted-foreground">
                For the approval screen only. The message actually sent is the approved template
                held by the provider.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "Schedule" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">When should it go out?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Send at (optional)</Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to send as soon as it is approved.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === "Review" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Check it over</CardTitle>
            <CardDescription>
              Sending it for approval freezes the audience: changing a saved audience afterwards
              will not change who this campaign reaches.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Name" value={name || "—"} />
            <Row label="Channel" value="WhatsApp" />
            <Row
              label="Audience"
              value={
                preview.data
                  ? `${preview.data.total.toLocaleString()} match, ${preview.data.contactable.toLocaleString()} contactable`
                  : "Not counted yet"
              }
            />
            <Row label="Rules" value={`${conditions.length} rule${conditions.length === 1 ? "" : "s"}, match ${match}`} />
            <Row
              label="Template"
              value={templateName ? `${templateName} · ${templateLanguage}` : "Not chosen"}
            />
            <Row
              label="Schedule"
              value={scheduledAt ? new Date(scheduledAt).toLocaleString() : "As soon as approved"}
            />
            <Row
              label="Branches"
              value={
                storeIds.length
                  ? realStores.filter((s) => storeIds.includes(s.id)).map((s) => s.name).join(", ")
                  : "Every branch you can see"
              }
            />
            <div className="pt-2">
              <Badge variant="outline">Needs approval before anything is sent</Badge>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => go(-1)} disabled={index === 0}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        {step === "Review" ? (
          <Button onClick={finish} disabled={create.isPending || submit.isPending}>
            {create.isPending || submit.isPending ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Send for approval
          </Button>
        ) : (
          <Button onClick={() => go(1)}>
            Next
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
