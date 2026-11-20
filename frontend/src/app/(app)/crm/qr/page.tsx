"use client";

import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Lock, Printer, QrCode, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
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
import { useIssueLeadQr, type IssuedLeadQr } from "@/lib/queries/lead-qr";
import { ROLE_RANK } from "@/lib/types";
import { useHydrated } from "@/lib/use-reset-on";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** Poster lifetimes offered to staff. The API caps the field at 2160 hours. */
const LIFETIMES = [
  { value: "168", label: "1 week" },
  { value: "720", label: "1 month" },
  { value: "2160", label: "3 months (longest)" },
];

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function LeadQrPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const currentStore = useSession((s) => s.currentStore);
  const hydrated = useHydrated();
  const issue = useIssueLeadQr();

  /*
   * The aggregate "All stores" option is a UI convenience, not a place. A QR
   * poster hangs on one wall in one branch, and the API refuses an aggregate
   * outright — so it is filtered here rather than offered and then rejected.
   */
  const realStores = useMemo(
    () => stores.filter((s) => !s.isAggregate),
    [stores],
  );

  const [storeId, setStoreId] = useState(
    () => (currentStore?.isAggregate ? "" : currentStore?.id) ?? "",
  );
  const [label, setLabel] = useState("");
  const [defaultInterest, setDefaultInterest] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("720");
  const [issued, setIssued] = useState<IssuedLeadQr | null>(null);

  /*
   * The scannable address. Built from the browser's own origin so the poster
   * points at whatever host this app is actually served from — a preview
   * deployment prints a preview link, production prints a production one, and
   * nothing here has to know either hostname.
   */
  const captureUrl =
    hydrated && issued ? `${window.location.origin}${issued.capturePath}` : "";

  if (ROLE_RANK[role] < ROLE_RANK.store_manager) {
    return (
      <div className="space-y-6">
        <SectionHeader
          title="Lead QR codes"
          purpose="Turn a scan at the counter into a lead for that branch."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Lock className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Managers and above</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                A QR code accepts enquiries for a branch without anyone signing
                in, so issuing one is a manager&apos;s decision. Ask your store
                manager to print a code for this counter.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const submit = () => {
    if (!storeId) {
      toast.error("Choose which branch this code belongs to.");
      return;
    }
    /*
     * Required here even though the API accepts a code without one.
     *
     * The capture form asks the visitor what they are interested in and lets
     * them skip it — but the server refuses a submission where BOTH that box
     * and this default are empty, and a stranger holding a phone has no way to
     * know a field marked optional was the one that mattered. Guaranteeing the
     * poster carries a fallback is what makes "optional" true on their side.
     */
    if (!defaultInterest.trim()) {
      toast.error("Say what the code is advertising, e.g. 'Bridal collection'.");
      return;
    }
    issue.mutate(
      {
        storeId,
        ...(label.trim() ? { label: label.trim() } : {}),
        defaultInterest: defaultInterest.trim(),
        expiresInHours: Number(expiresInHours),
      },
      {
        onSuccess: (data) => {
          setIssued(data);
          toast.success(`Code ready for ${data.storeName}.`);
        },
        onError: (e) =>
          toast.error(
            apiErrorMessage(e, "Could not create the code. Please try again."),
          ),
      },
    );
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(captureUrl);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy — select the link and copy it by hand.");
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Lead QR codes"
        purpose="Turn a scan at the counter into a lead for that branch."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <QrCode className="h-4 w-4" />
              Print a new code
            </CardTitle>
            <CardDescription>
              Anyone who scans it fills in their name, number and what they are
              looking for. It arrives as a lead for the branch you pick below,
              with follow-ups already scheduled. No app, no sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
              <p className="text-xs text-muted-foreground">
                Every lead from this code is filed here, so put the code on that
                branch&apos;s counter only.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Where will it go? (optional)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Front counter"
                maxLength={100}
              />
              <p className="text-xs text-muted-foreground">
                Only your team sees this. It helps you tell two posters apart
                later.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>What is it advertising?</Label>
              <Input
                value={defaultInterest}
                onChange={(e) => setDefaultInterest(e.target.value)}
                placeholder="Bridal collection"
                maxLength={280}
              />
              <p className="text-xs text-muted-foreground">
                Required, because it is what the lead says when a visitor leaves
                the enquiry box empty. Without it the shop gets a name and a
                number and no idea what they came in for.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Stop working after</Label>
              <Select value={expiresInHours} onValueChange={setExpiresInHours}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIFETIMES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A code that leaves the building keeps working until it expires.
                Shorter is safer; print a fresh one when it lapses.
              </p>
            </div>

            <Button
              onClick={submit}
              disabled={issue.isPending}
              className="w-full"
            >
              {issue.isPending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <QrCode className="mr-2 h-4 w-4" />
                  Create code
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your code</CardTitle>
            <CardDescription>
              {issued
                ? "Print it, or send the link to whoever is printing."
                : "It will appear here once you create one."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!issued ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <QrCode className="h-5 w-5" />
                </div>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Pick a branch and create a code. Each one is unique — creating
                  a second does not cancel the first.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex justify-center rounded-lg border bg-white p-6">
                  {captureUrl ? (
                    <QRCodeSVG
                      value={captureUrl}
                      size={200}
                      level="M"
                      marginSize={2}
                    />
                  ) : null}
                </div>

                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Branch</dt>
                    <dd className="font-medium">{issued.storeName}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Works until
                    </dt>
                    <dd className="font-medium">
                      {formatExpiry(issued.expiresAt)}
                    </dd>
                  </div>
                  {issued.label ? (
                    <div className="col-span-2">
                      <dt className="text-xs text-muted-foreground">Label</dt>
                      <dd className="font-medium">{issued.label}</dd>
                    </div>
                  ) : null}
                </dl>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => window.print()} className="flex-1">
                    <Printer className="mr-2 h-4 w-4" />
                    Print poster
                  </Button>
                  <Button
                    variant="outline"
                    onClick={copyLink}
                    className="flex-1"
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    Copy link
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Anyone holding this link can file a lead for{" "}
                  {issued.storeName}, so share it the way you would a key to the
                  counter — not in a public post.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/*
       * The printed artefact. Hidden on screen and revealed by the print
       * stylesheet in globals.css, so `window.print()` above puts a clean
       * poster on paper instead of the application chrome around it.
       */}
      {issued && captureUrl ? (
        <div className="qr-poster" aria-hidden>
          <p className="qr-poster-eyebrow">{issued.storeName}</p>
          <h2 className="qr-poster-title">Scan to enquire</h2>
          <p className="qr-poster-sub">
            Point your phone camera at the code. Tell us what you are looking
            for and we will call you back.
          </p>
          <div className="qr-poster-code">
            <QRCodeSVG value={captureUrl} size={320} level="M" marginSize={2} />
          </div>
          {issued.label ? <p className="qr-poster-foot">{issued.label}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
