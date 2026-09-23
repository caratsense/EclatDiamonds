"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
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
import {
  cn,
  apiErrorMessage,
  isValidEmail,
  normalizeIndianMobile,
  phoneInputValue,
} from "@/lib/utils";
import { ChannelStatusNotice } from "@/components/integrations/channel-status-notice";
import {
  composeDailyReportText,
  type DailyReport,
  type ReportChannel,
} from "@/lib/mock/reporting";
import { useSendDailyReport } from "@/lib/queries/reporting";
import { useResetOn } from "@/lib/use-reset-on";

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
 * View a filed DSR's full composed WhatsApp text and send it over WhatsApp or
 * email (POST /reporting/daily/:id/send). When the backend replies
 * `disabled:true` the channel isn't configured yet — we show an inline
 * "preview only" note rather than treating it as an error.
 */
export function DailyReportSendDialog({
  report,
  open,
  onOpenChange,
}: {
  report: DailyReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [channel, setChannel] = useState<ReportChannel>("whatsapp");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sendReport = useSendDailyReport();

  useResetOn(open ? (report?.id ?? "open") : null, () => {
    if (open) {
      setChannel("whatsapp");
      setTo("");
      setOutcome(null);
    }
  });

  // Prefer the server-composed text; fall back to composing client-side.
  const text = useMemo(() => {
    if (!report) return "";
    return report.text || composeDailyReportText(report, report.storeName ?? "");
  }, [report]);

  const isEmail = channel === "email";
  const channelName = isEmail ? "Email" : "WhatsApp";

  const trimmed = to.trim();
  const normalizedPhone = isEmail ? null : normalizeIndianMobile(trimmed);
  const recipientValid = isEmail
    ? isValidEmail(trimmed)
    : normalizedPhone != null;
  const recipientError = trimmed.length > 0 && !recipientValid;

  function send() {
    if (!report) return;
    if (!trimmed) {
      toast.error(isEmail ? "Enter an email address." : "Enter a WhatsApp number.");
      return;
    }
    if (!recipientValid) {
      toast.error(
        isEmail
          ? "Enter a valid email address."
          : "Enter a valid 10-digit Indian mobile number.",
      );
      return;
    }
    const recipient = isEmail ? trimmed : (normalizedPhone as string);
    setOutcome(null);
    sendReport.mutate(
      { id: report.id, channel, to: recipient },
      {
        onSuccess: (res) => {
          setOutcome({ sent: res.sent, disabled: res.disabled, channel });
          if (!res.disabled && res.sent) {
            toast.success(`${channelName} report sent`);
          }
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not send the report.")),
      },
    );
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Report text copied");
    } catch {
      toast.error("Couldn't copy. Select the text and copy manually.");
    }
  }

  const clearOutcome = () => setOutcome(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Daily report</DialogTitle>
          <DialogDescription>
            {report
              ? `${report.storeName ?? "Store"} · ${report.reportDate}`
              : "Filed store-close report"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Composed report text */}
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>Report</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={copyText}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[12.5px] leading-relaxed">
              {text}
            </pre>
          </div>

          {/* Channel */}
          <div className="grid gap-1.5">
            <Label>Send to</Label>
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

          {/* Warn before the number is typed, not after the send returns. */}
          <ChannelStatusNotice channel={isEmail ? "email" : "whatsapp"} />

          {/* Recipient */}
          <div className="grid gap-1.5">
            <Label htmlFor="dsr-send-to">
              {isEmail ? "Recipient email" : "WhatsApp number"}
            </Label>
            <Input
              id="dsr-send-to"
              type={isEmail ? "email" : "tel"}
              inputMode={isEmail ? "email" : "numeric"}
              maxLength={isEmail ? undefined : 10}
              placeholder={isEmail ? "reports@example.com" : "9876500000"}
              value={to}
              aria-invalid={recipientError}
              onChange={(e) => {
                setTo(isEmail ? e.target.value : phoneInputValue(e.target.value));
                clearOutcome();
              }}
            />
            {recipientError ? (
              <p className="text-xs text-destructive">
                {isEmail
                  ? "Enter a valid email address."
                  : "Enter a valid 10-digit Indian mobile number (digits only)."}
              </p>
            ) : null}
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
            disabled={sendReport.isPending || !report || !text || !recipientValid}
          >
            {sendReport.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
