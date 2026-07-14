"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  CheckCircle2,
  Info,
  Mail,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatINR, formatNumber } from "@/lib/format";
import {
  REPORT_PERIODS,
  formatPaymentMode,
  type ReportChannel,
  type ReportPeriod,
  type ReportSummary,
} from "@/lib/mock/reporting";
import { useReportSummary, useSendReport } from "@/lib/queries/reporting";

/** Compose the report text client-side (fallback for the live preview). */
function composeReport(s: ReportSummary): string {
  const label =
    REPORT_PERIODS.find((p) => p.key === s.period)?.label ?? "Period";
  const range =
    s.from === s.to
      ? format(parseISO(s.from), "dd MMM yyyy")
      : `${format(parseISO(s.from), "dd MMM")} – ${format(parseISO(s.to), "dd MMM yyyy")}`;

  return [
    `${label} Sales Report — ${range}`,
    "",
    "SALES",
    `• Bills: ${formatNumber(s.sales.count)}`,
    `• Gross: ${formatINR(s.sales.gross)}`,
    `• Discount: ${formatINR(s.sales.discount)}`,
    `• Net: ${formatINR(s.sales.net)}`,
    "",
    "ORDERS",
    `• Booked: ${formatNumber(s.orders.count)}`,
    `• Advance: ${formatINR(s.orders.advance)}`,
    `• Estimation: ${formatINR(s.orders.estimation)}`,
    "",
    "PAYMENTS",
    `• Collected: ${formatINR(s.payments.total)} (${formatNumber(s.payments.count)} txns)`,
    ...Object.entries(s.payments.byMode).map(
      ([mode, amt]) => `• ${formatPaymentMode(mode)}: ${formatINR(amt)}`,
    ),
  ].join("\n");
}

function ChannelButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-[var(--gold)] bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-foreground shadow-xs"
          : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

type Outcome = { sent: boolean; disabled?: boolean; channel: ReportChannel };

/**
 * Send-report dialog (Module 10). Pick period + channel + recipient, see a
 * live preview of the composed report, then POST /reporting/send. When the
 * backend replies `disabled:true` the channel isn't configured yet — we show
 * an inline "preview only" note rather than treating it as an error.
 */
export function SendReportDialog({
  open,
  onOpenChange,
  initialPeriod,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPeriod: ReportPeriod;
}) {
  const [period, setPeriod] = useState<ReportPeriod>(initialPeriod);
  const [channel, setChannel] = useState<ReportChannel>("whatsapp");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const summaryQuery = useReportSummary(period);
  const sendReport = useSendReport();

  // Re-anchor to the rollup's current period each time the dialog opens.
  useEffect(() => {
    if (open) {
      setPeriod(initialPeriod);
      setOutcome(null);
    }
  }, [open, initialPeriod]);

  const preview = useMemo(
    () => (summaryQuery.data ? composeReport(summaryQuery.data) : ""),
    [summaryQuery.data],
  );

  const isEmail = channel === "email";
  const channelName = isEmail ? "Email" : "WhatsApp";

  function send() {
    const recipient = to.trim();
    if (!recipient) {
      toast.error(
        isEmail ? "Enter an email address." : "Enter a WhatsApp number.",
      );
      return;
    }
    if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (!isEmail && recipient.replace(/\D/g, "").length < 10) {
      toast.error("Enter a valid phone number.");
      return;
    }
    setOutcome(null);
    sendReport.mutate(
      { period, channel, to: recipient },
      {
        onSuccess: (res) => {
          setOutcome({
            sent: res.sent,
            disabled: res.disabled,
            channel: res.channel,
          });
          if (!res.disabled && res.sent) {
            toast.success(`${channelName} report sent`);
          }
        },
        onError: () => toast.error("Could not send the report."),
      },
    );
  }

  // Any change to the composition invalidates a prior send outcome.
  const clearOutcome = () => setOutcome(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send report</DialogTitle>
          <DialogDescription>
            Roll up the figures and deliver them over WhatsApp or email.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Period</Label>
            <Tabs
              value={period}
              onValueChange={(v) => {
                setPeriod(v as ReportPeriod);
                clearOutcome();
              }}
            >
              <TabsList className="w-full">
                {REPORT_PERIODS.map((p) => (
                  <TabsTrigger key={p.key} value={p.key} className="flex-1">
                    {p.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="grid gap-1.5">
            <Label>Channel</Label>
            <div className="grid grid-cols-2 gap-2">
              <ChannelButton
                active={channel === "whatsapp"}
                onClick={() => {
                  setChannel("whatsapp");
                  clearOutcome();
                }}
                icon={MessageCircle}
                label="WhatsApp"
              />
              <ChannelButton
                active={channel === "email"}
                onClick={() => {
                  setChannel("email");
                  clearOutcome();
                }}
                icon={Mail}
                label="Email"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="report-recipient">
              {isEmail ? "Recipient email" : "WhatsApp number"}
            </Label>
            <Input
              id="report-recipient"
              type={isEmail ? "email" : "tel"}
              inputMode={isEmail ? "email" : "tel"}
              placeholder={isEmail ? "owner@eclatdiamonds.in" : "9876500000"}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                clearOutcome();
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Preview</Label>
            {summaryQuery.isLoading ? (
              <Skeleton className="h-48 rounded-lg" />
            ) : summaryQuery.isError ? (
              <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                Couldn&apos;t load the figures for this period.
              </p>
            ) : (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
                {preview}
              </pre>
            )}
          </div>

          {outcome?.disabled ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {outcome.channel === "email" ? "Email" : "WhatsApp"} isn&apos;t
                configured yet — preview only. Nothing was sent.
              </span>
            </div>
          ) : outcome?.sent ? (
            <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Report delivered via{" "}
                {outcome.channel === "email" ? "email" : "WhatsApp"}.
              </span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={send}
            disabled={
              sendReport.isPending || summaryQuery.isLoading || !preview
            }
          >
            {sendReport.isPending ? "Sending…" : "Send report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
