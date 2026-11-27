"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Tag,
  ThumbsUp,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CAMPAIGN_STATUS_LABELS,
  useApproveCampaign,
  useCampaign,
  useCampaignRecipients,
  useCampaignRetryPlan,
  useCancelCampaign,
  useRetryCampaign,
  useTagCampaignRecipients,
  type CampaignCounts,
  type CampaignRecipientRow,
} from "@/lib/queries/campaigns";
import { useLeadTags } from "@/lib/queries/lead-tags";
import {
  allTaggableSelected,
  taggableRows,
  withPageSelected,
} from "./recipient-selection";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Why a person was not messaged, in words they can act on.
 *
 * The API stores machine reasons so they stay stable; the translation belongs
 * here rather than in the database, where changing the wording would mean
 * rewriting history.
 */
const EXCLUSION_LABELS: Record<string, string> = {
  blocked_customer: "Blocked customer",
  campaign_cancelled: "Broadcast cancelled",
  /*
   * Deliberately vague no longer.
   *
   * This read "Consent or messaging rules refused it at send time" for every
   * refusal, so the owner — who had already told us his customer list IS the
   * permission — kept reading "consent" for customers whose real problem was
   * an unusable number or a thread not linked to any customer. The row now
   * shows the server's own sentence when there is one, and falls back to this
   * only when there is not.
   */
  policy_refused_at_send: "The messaging rules refused it at send time",
  /*
   * The answer to "these many people have already received this template, do
   * you want to send again? If no, exclude them." Named on the row, because
   * somebody reading this list a week later needs to know these people were
   * left out on purpose and by whose decision.
   */
  already_received_template: "Already had this template, so left out on purpose",
};

/**
 * The tabs, as questions rather than column values.
 *
 * They used to be the raw statuses: Everyone, Sent, Excluded, Failed, Given
 * up. "Sent" therefore meant the seven people whose delivery receipt had not
 * come back yet — not the 145 who got the message — and the 138 who were
 * delivered or had already read it could not be listed at all. The owner's
 * words: "it's not showing sent, all names, only 7 people I can see in the
 * sent tab... we cannot clearly see who all received what each means."
 *
 * `count` reads the campaign's own figures, so a tab never disagrees with the
 * delivery row above it.
 */
const RECIPIENT_TABS: {
  value: string;
  label: string;
  count: (c: CampaignCounts) => number;
  hint?: string;
}[] = [
  { value: "all", label: "Everyone", count: (c) => c.targeted + c.excluded },
  {
    value: "reached",
    label: "Got it",
    count: (c) => c.sent + c.delivered + c.read,
    hint: "The message arrived on their phone.",
  },
  { value: "read", label: "Read", count: (c) => c.read, hint: "They opened and read it." },
  {
    value: "delivered",
    label: "Delivered",
    count: (c) => c.delivered,
    hint: "It reached their phone; they have not opened it yet.",
  },
  {
    value: "sent",
    label: "Sent, no receipt",
    count: (c) => c.sent,
    hint: "WhatsApp accepted it but has not confirmed delivery yet.",
  },
  {
    value: "not_reached",
    label: "Did not arrive",
    count: (c) => c.failed + c.dead,
    hint: "WhatsApp refused it. The reason is on each row.",
  },
  {
    value: "excluded",
    label: "Not messaged",
    count: (c) => c.excluded,
    hint: "Left out before sending — no usable number, opted out, or blocked.",
  },
];

/** What a row's status means, in the words a person would use. */
const STATUS_WORDS: Record<string, string> = {
  read: "Read",
  delivered: "Delivered",
  sent: "Sent",
  queued: "Waiting to send",
  pending: "Waiting to send",
  failed: "Did not arrive",
  // Never "dead" on a screen. It is a queue word for a row that has used up
  // its attempts, and it reads as something that happened to the customer.
  dead: "Did not arrive",
  excluded: "Not messaged",
  cancelled: "Cancelled",
};

/**
 * One figure on the delivery row.
 *
 * `muted` is for a figure that is part of another one on the same row — the
 * readers are also among the reached — so the eye reads the headline number
 * first and the breakdown as detail under it, rather than as four totals to
 * add together.
 */
function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: number;
  tone?: "bad" | "good";
  muted?: boolean;
}) {
  const colour =
    tone === "bad" && value > 0
      ? "text-destructive"
      : tone === "good" && value > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "";
  return (
    <div className={`rounded-md border p-3 ${muted ? "border-dashed border-border/60" : "border-border"}`}>
      <div
        className={`font-[family-name:var(--font-display-face)] tabular-nums ${
          muted ? "text-xl text-muted-foreground" : "text-2xl"
        } ${colour}`}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * Re-send to the people this broadcast did not reach.
 *
 * The number comes BEFORE the click. Meta caps marketing per recipient (error
 * 131049), so a re-send is not free — and on the nails-event broadcast the
 * outcome tracked attempts almost exactly: 80% of the people tried twice got
 * it, 9% of those tried three times did, and nobody tried four times did. The
 * retries were debugging a delivery bug and they made the delivery worse. So
 * anyone messaged in the last day is held back, the screen says how many and
 * why, and including them is a deliberate tick rather than a default.
 *
 * While the broadcast is still going out it SAYS SO instead of rendering
 * nothing. Re-sending to a recipient the outbox is still working through would
 * double-message them, so the button genuinely has to wait — but a tab holding
 * a hundred people who did not get it, with no button and no sentence
 * explaining the absence, is indistinguishable from the button never having
 * been built. That is exactly what it was reported as.
 */
function RetrySection({
  id,
  inFlight,
}: {
  id: string;
  /** The broadcast is still being sent, so a re-send has to wait its turn. */
  inFlight: boolean;
}) {
  const plan = useCampaignRetryPlan(id, !inFlight);
  const retry = useRetryCampaign();
  const [override, setOverride] = useState(false);

  if (inFlight) {
    return (
      <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        This broadcast is still going out. Sending again becomes available here once it has
        finished, so nobody is messaged twice over.
      </p>
    );
  }
  if (plan.isLoading) return <Skeleton className="h-20 w-full" />;
  if (plan.isError) {
    // Said out loud rather than rendered as an empty space. A section that
    // vanishes when its one read fails reads as a missing feature.
    return (
      <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        {apiErrorMessage(plan.error, "Could not work out who sending again would go to.")}
      </p>
    );
  }
  if (!plan.data || plan.data.retryable === 0) return null;

  const p = plan.data;
  const willSend = override ? p.willSendWithOverride : p.willSend;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <p className="font-medium">Send it again to these people</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {/* The figure the button will act on, not the size of the tab.
                A number that ignores the hold-back is the number somebody
                plans around and then has to explain. */}
            {willSend.toLocaleString()} of {p.retryable.toLocaleString()} will be messaged.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={retry.isPending || willSend === 0}
          onClick={() =>
            retry.mutate(
              { id, includeRecentlyMessaged: override },
              {
                onSuccess: (r) => {
                  toast.success(
                    r.retried === 0
                      ? "Nobody was eligible, so nothing was sent."
                      : `Sending again to ${r.retried.toLocaleString()} ${
                          r.retried === 1 ? "person" : "people"
                        }.` +
                          (r.heldBack
                            ? ` ${r.heldBack.toLocaleString()} held back for ${r.cooldownHours}h.`
                            : ""),
                  );
                  setOverride(false);
                },
                onError: (e) => toast.error(apiErrorMessage(e, "Could not send it again.")),
              },
            )
          }
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${retry.isPending ? "animate-spin" : ""}`} />
          {willSend === 0
            ? "Nobody can be messaged yet"
            : `Send again to ${willSend.toLocaleString()}`}
        </Button>
      </div>

      {p.heldBack > 0 ? (
        <div className="flex gap-2 rounded-md border border-border bg-background p-3 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground tabular-nums">
                {p.heldBack.toLocaleString()}
              </span>{" "}
              of them were already messaged in the last {p.cooldownHours} hours, so they are being
              held back. WhatsApp limits how much marketing one person receives, and messaging them
              again spends that allowance — it is the likeliest way to have them refused a second
              time.
            </p>
            <label className="flex items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              <span>
                Include them anyway
                <span className="block text-muted-foreground">
                  Sends to all {p.willSendWithOverride.toLocaleString()}, the held-back included.
                </span>
              </span>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tag the people ticked on the recipient list.
 *
 * The client's words: "I can select multiple people at a time and then I can
 * give them a custom tag. So next time when I create a broadcast I can include
 * or exclude those people through tags." The include and exclude already exist
 * in the audience builder — Tag / has any of / does not have — so this is the
 * half that was missing.
 *
 * The tag goes on the CUSTOMER, which is why a row with no customer record
 * cannot be ticked at all and says so on the row rather than being quietly
 * dropped from the count.
 */
function TagSelectedBar({
  id,
  selected,
  rows,
  onDone,
}: {
  id: string;
  selected: Set<string>;
  rows: CampaignRecipientRow[];
  onDone: () => void;
}) {
  const tags = useLeadTags();
  const apply = useTagCampaignRecipients(id);
  const [newName, setNewName] = useState("");

  const anyTaggable = rows.some((r) => r.partyId);

  if (!selected.size) {
    return anyTaggable ? (
      <p className="text-xs text-muted-foreground">
        Tick people to give them a tag. A tag put on somebody here can include or exclude them from
        the next broadcast.
      </p>
    ) : null;
  }

  const run = (input: { tagId?: string; tagName?: string }) =>
    apply.mutate(
      { recipientIds: [...selected], ...input },
      {
        onSuccess: (r) => {
          const parts = [
            r.tagged
              ? `Tagged ${r.tagged.toLocaleString()} ${r.tagged === 1 ? "customer" : "customers"} "${r.tag.name}".`
              : `Nobody new was tagged "${r.tag.name}".`,
          ];
          // Said out loud rather than folded into a smaller number. Somebody
          // who ticked nine people and tagged seven needs to know which two
          // were left and why.
          if (r.alreadyTagged) parts.push(`${r.alreadyTagged} already had it.`);
          if (r.withoutCustomer) {
            parts.push(`${r.withoutCustomer} had no customer record, so could not be tagged.`);
          }
          if (r.notOnThisBroadcast) {
            parts.push(`${r.notOnThisBroadcast} are no longer on this broadcast.`);
          }
          toast.success(parts.join(" "));
          setNewName("");
          onDone();
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not tag them.")),
      },
    );

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
      <span className="px-1 text-sm tabular-nums">
        {selected.size.toLocaleString()} selected
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={apply.isPending}>
            <Tag className="mr-1.5 h-3.5 w-3.5" />
            Tag selected
          </Button>
        </DropdownMenuTrigger>
        {/*
          OPENS DOWNWARD, AND THE WAY TO MAKE A TAG IS THE FIRST THING IN IT.

          Both halves of this were one bug. The menu listed every existing tag
          and put the new-tag field underneath them — so with a dozen branch
          tags the field sat below the fold of a menu that was by then taller
          than the space under the button, which made Radix flip the whole
          thing above the trigger and push the field off the top of the screen.
          The client's reading of it was exactly right: "it is telling me to
          give an existing tag, there should be an option to create new tag",
          and "who gives that selector above, it should be below".

          `side="bottom"` with collisions off keeps it under the button, and
          capping the list is what earns that — a menu that cannot outgrow the
          space below it never needs to flip.
        */}
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={6}
          avoidCollisions={false}
          className="w-72"
        >
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Tag {selected.size.toLocaleString()}{" "}
            {selected.size === 1 ? "person" : "people"}
          </DropdownMenuLabel>
          {/*
            One field that both finds and creates, rather than a list with a
            form hidden under it. Typing narrows the tags that exist and offers
            to make the one that does not, so neither path is buried.
          */}
          <div className="p-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Find or create a tag"
              maxLength={40}
              autoFocus
              // Enter would close the menu and lose what was typed.
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const typed = newName.trim();
                if (typed.length < 2) return;
                const exact = (tags.data ?? []).find(
                  (t) => t.name.toLowerCase() === typed.toLowerCase(),
                );
                run(exact ? { tagId: exact.id } : { tagName: typed });
              }}
            />
          </div>
          {newName.trim().length >= 2 &&
          !(tags.data ?? []).some(
            (t) => t.name.toLowerCase() === newName.trim().toLowerCase(),
          ) ? (
            <DropdownMenuItem onSelect={() => run({ tagName: newName.trim() })}>
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Create &ldquo;{newName.trim()}&rdquo;</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <div className="max-h-56 overflow-y-auto">
            {tags.isLoading ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
            ) : (
              (() => {
                const typed = newName.trim().toLowerCase();
                const shown = (tags.data ?? []).filter(
                  (t) => !typed || t.name.toLowerCase().includes(typed),
                );
                if (!(tags.data ?? []).length) {
                  return (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      No tags yet. Type a name above to make the first one.
                    </p>
                  );
                }
                if (!shown.length) {
                  return (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      No tag matches that. Press enter to make it.
                    </p>
                  );
                }
                return shown.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => run({ tagId: t.id })}>
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: t.colour ?? "var(--muted-foreground)" }}
                    />
                    <span className="truncate">{t.name}</span>
                  </DropdownMenuItem>
                ));
              })()
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="ghost" onClick={onDone} disabled={apply.isPending}>
        Clear
      </Button>
      {apply.isPending ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
}

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const role = useSession((s) => s.role);
  const [tab, setTab] = useState("all");

  const campaign = useCampaign(id);
  /*
   * Read before the early returns because the recipient list needs it: a send
   * in progress rewrites those rows, so the list has to keep up with it rather
   * than hold the state it was first opened on.
   */
  const inFlight = ["expanding", "queued", "sending"].includes(campaign.data?.status ?? "");
  const [page, setPage] = useState(1);
  const recipients = useCampaignRecipients(id, tab === "all" ? undefined : tab, page, 10, inFlight);
  const recipientRows = recipients.data?.items ?? [];
  const approve = useApproveCampaign();
  const cancel = useCancelCampaign();

  /*
   * Ticked rows, by recipient id, kept across pages.
   *
   * Across pages on purpose: a page holds ten rows and the client asked to
   * "select multiple people at a time and then give them a custom tag" — a
   * selection that emptied itself every time she turned the page would make
   * tagging thirty people thirty separate decisions. Cleared when the tab
   * changes, because the tabs are different questions and a selection carried
   * from "Got it" into "Did not arrive" is a selection nobody made.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const clearSelection = () => setSelected(new Set());
  /** Rows on this page that have a customer behind them to carry a tag. */
  const taggableOnPage = useMemo(() => taggableRows(recipientRows), [recipientRows]);
  const allOnPageSelected = allTaggableSelected(recipientRows, selected);

  const canApprove = ROLE_RANK[role] >= ROLE_RANK.area_manager;
  /*
   * Sending marketing to customers is not a salesperson's call.
   *
   * Store manager and up, which is the same line CampaignsService.assertManager
   * draws on the re-send itself — so the only people who see the button are the
   * people whose click will work. Hidden rather than disabled, exactly as
   * "Approve and send" is, because a salesperson has nothing to do about it.
   */
  const canRetry = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  if (campaign.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/campaigns">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All campaigns
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          {apiErrorMessage(campaign.error, "Could not load this broadcast.")}
        </p>
      </div>
    );
  }

  const c = campaign.data;
  const stoppable = [
    "draft",
    "awaiting_approval",
    "approved",
    "scheduled",
    "expanding",
    "queued",
    "sending",
  ].includes(c.status);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/campaigns">
          <ArrowLeft className="mr-2 h-4 w-4" />
          All campaigns
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader title={c.name} purpose={c.description ?? "WhatsApp broadcast."} />
        <div className="flex flex-wrap gap-2">
            {c.status === "awaiting_approval" && canApprove ? (
              <Button
                onClick={() =>
                  approve.mutate(
                    { id },
                    {
                      onSuccess: () => toast.success("Approved. The list is being built now."),
                      onError: (e) =>
                        toast.error(apiErrorMessage(e, "Could not approve this broadcast.")),
                    },
                  )
                }
                disabled={approve.isPending}
              >
                <ThumbsUp className="mr-2 h-4 w-4" />
                Approve and send
              </Button>
            ) : null}
            {/*
              The re-send button used to live here, beside Approve and Cancel,
              and said "Retry failed" with no number on it. It is now on the
              "Did not arrive" tab instead: that tab IS the group it re-sends
              to, and a button there can say how many people it will actually
              message before anybody presses it.
            */}
            {stoppable ? (
              <Button
                variant="outline"
                onClick={() =>
                  cancel.mutate(
                    { id, body: { reason: "Stopped from the broadcast screen" } },
                    {
                      onSuccess: () => toast.success("Cancelled. Nobody else will be messaged."),
                      onError: (e) => toast.error(apiErrorMessage(e, "Could not cancel.")),
                    },
                  )
                }
                disabled={cancel.isPending}
              >
                <Ban className="mr-2 h-4 w-4" />
                Cancel
              </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={c.status === "failed" ? "destructive" : "secondary"}>
          {CAMPAIGN_STATUS_LABELS[c.status]}
        </Badge>
        {c.templateName ? (
          <Badge variant="outline">
            {c.templateName} · {c.templateLanguage}
          </Badge>
        ) : null}
        {inFlight ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Updating automatically
          </span>
        ) : null}
      </div>

      {c.lastError ? (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{c.lastError}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery</CardTitle>
          <CardDescription>
            Counted in the database across the whole campaign, not from the rows listed below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            REACHED FIRST, AND THE READERS COUNTED.

            This row used to run Targeted / Excluded / Queued / Sent /
            Delivered / Failed / Given up — with no tile for `read`, which the
            API had been returning all along. On the nails-event broadcast that
            left 59 of 126 people nowhere on the screen: the tiles added up to
            67, the customer who had opened and read the invitation was counted
            as neither delivered nor anything else, and the campaign looked
            like it had reached a third of the list when it had reached four
            fifths of it.

            `Reached` leads because it is the question the screen is opened to
            answer. The three states underneath it are the same people in more
            detail, which is why they are muted — a reader is also delivered,
            and showing both as equals invites adding them together.
          */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Stat label="Targeted" value={c.counts.targeted} />
            <Stat
              label="Reached"
              value={c.counts.sent + c.counts.delivered + c.counts.read}
              tone="good"
            />
            <Stat label="Read" value={c.counts.read} muted />
            <Stat label="Delivered" value={c.counts.delivered} muted />
            <Stat label="Sent" value={c.counts.sent} muted />
            <Stat label="Queued" value={c.counts.queued} />
            <Stat label="Failed" value={c.counts.failed} tone="bad" />
            <Stat label="Given up" value={c.counts.dead} tone="bad" />
          </div>
          <p className="pt-3 text-xs text-muted-foreground">
            {/* Said plainly, because three of the tiles above are subsets of
                one another and somebody will otherwise add them up. */}
            Reached counts everyone the message got to — sent, delivered and
            read are the same people at different stages.
            {c.counts.excluded > 0
              ? ` ${c.counts.excluded} more were not messaged; the reasons are below.`
              : ""}
          </p>
        </CardContent>
      </Card>

      {c.counts.excluded > 0 ? (
        <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {c.counts.excluded.toLocaleString()} of them were not messaged — each one is listed
            below with the reason. A customer who has replied STOP, one marked blocked, and one
            whose number cannot be messaged are each enough on their own, and every person is
            checked again at the moment of sending, so this number can grow after approval.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Page 1 on every tab change: "Sent" has seven rows and the reader
              could be on page four of "Everyone" when they switch. */}
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              setPage(1);
              clearSelection();
            }}
          >
            <TabsList>
              {RECIPIENT_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value} title={t.hint}>
                  {t.label}
                  {/* The count on the tab itself, from the campaign's own
                      figures. Without it somebody opens a tab to find out how
                      many are behind it, and an empty one looks broken rather
                      than empty. */}
                  <span className="ml-1.5 tabular-nums opacity-60">{t.count(c.counts)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* What the tab they are on actually means. One line, under the
              tabs, because every one of these words is a WhatsApp distinction
              rather than an ordinary English one. */}
          {RECIPIENT_TABS.find((t) => t.value === tab)?.hint ? (
            <p className="pb-1 pt-2 text-xs text-muted-foreground">
              {RECIPIENT_TABS.find((t) => t.value === tab)?.hint}
            </p>
          ) : null}

          {/* The re-send sits on the tab it acts on, so "that group" is the
              group on screen rather than a word in a button. */}
          {tab === "not_reached" && canRetry ? (
            <RetrySection id={id} inFlight={inFlight} />
          ) : null}

          <TagSelectedBar
            id={id}
            selected={selected}
            rows={recipientRows}
            onDone={clearSelection}
          />

          {recipients.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !recipientRows.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {c.status === "draft" || c.status === "awaiting_approval"
                ? "The list is built when the broadcast is approved."
                : "Nothing here."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      {/* Select-all is this page, not the whole broadcast: a
                          tick that silently selected four hundred people on
                          pages nobody had looked at would be a tag applied
                          sight unseen. Rows with no customer behind them are
                          skipped, because there is nothing there to tag. */}
                      <input
                        type="checkbox"
                        aria-label="Select everyone on this page"
                        checked={allOnPageSelected}
                        onChange={(e) =>
                          setSelected(
                            withPageSelected(selected, recipientRows, e.target.checked),
                          )
                        }
                        disabled={!taggableOnPage.length}
                      />
                    </TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Sent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipientRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          disabled={!r.partyId}
                          aria-label={
                            r.partyId
                              ? `Select ${r.contact ?? "this recipient"}`
                              : "This number is not linked to a customer, so it cannot be tagged"
                          }
                          title={
                            r.partyId
                              ? undefined
                              : "Not linked to a customer record, so there is nobody to tag."
                          }
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            setSelected(next);
                          }}
                        />
                      </TableCell>
                      <TableCell className="font-[family-name:var(--font-mono-face)] text-sm">
                        {r.contact ?? "—"}
                        {/* Said on the row rather than only in a disabled
                            tick box: the reason a row cannot be tagged is
                            about the record, not about the tick box. */}
                        {!r.partyId ? (
                          <span className="block text-[11px] font-sans text-muted-foreground">
                            No customer record — cannot be tagged
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === "sent" || r.status === "delivered" || r.status === "read"
                              ? "success"
                              : r.status === "failed" || r.status === "dead"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {STATUS_WORDS[r.status] ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {/*
                          The server's own sentence first. It names the actual
                          problem — "that is not a usable WhatsApp number" —
                          where the category label can only say a rule refused
                          it, which is what had fifty rows reading the same
                          unhelpful line.
                        */}
                        {r.lastError ??
                          (r.exclusionReason
                            ? (EXCLUSION_LABELS[r.exclusionReason] ?? r.exclusionReason)
                            : "—")}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.sentAt ? (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            {new Date(r.sentAt).toLocaleString()}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Numbered pages, because somebody reading this is looking for
                  one person among a few hundred and needs to get back to the
                  page they were just on. The range is spelled out so the list
                  never again hides four fifths of itself behind a count. */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {recipients.data
                    ? recipients.data.total === 0
                      ? "None here."
                      : `${(recipients.data.page - 1) * recipients.data.pageSize + 1}–${Math.min(
                          recipients.data.page * recipients.data.pageSize,
                          recipients.data.total,
                        )} of ${recipients.data.total}`
                    : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || recipients.isFetching}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {recipients.data?.page ?? page} of {recipients.data?.pageCount ?? 1}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={
                      recipients.isFetching ||
                      page >= (recipients.data?.pageCount ?? 1)
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
