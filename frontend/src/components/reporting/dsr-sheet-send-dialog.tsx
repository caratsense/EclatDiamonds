"use client";

import { useState } from "react";
import { CheckCircle2, Info } from "lucide-react";
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
import { ChannelStatusNotice } from "@/components/integrations/channel-status-notice";
import {
  cn,
  apiErrorMessage,
  isValidEmail,
  normalizeIndianMobile,
  phoneInputValue,
} from "@/lib/utils";
import { useSendDsrSheet, type DsrSheetInput } from "@/lib/queries/reporting";
import { useResetOn } from "@/lib/use-reset-on";
import { useSession } from "@/store/use-session";

/**
 * Who gets the sheet. The app has no head-office address on file, so head
 * office is the plain email option — typed once, per send.
 */
type Target = "myself" | "email" | "whatsapp";

const TARGETS: { value: Target; label: string }[] = [
  { value: "myself", label: "Myself" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
];

/**
 * Send the DSR sheet as a file (POST /reporting/daily/sheet/send) — the same
 * grid the Download button saves, over WhatsApp or email. `disabled:true` back
 * from the server means that channel isn't configured: an inline note, not an
 * error, exactly as the filed-report dialog treats it.
 */
export function DsrSheetSendDialog({
  sheet,
  open,
  onOpenChange,
}: {
  sheet: DsrSheetInput;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useSession();
  // The login id is a sign-in identifier, not necessarily a mailbox.
  const ownEmail = [user.contactEmail, user.email].find(
    (e): e is string => !!e && isValidEmail(e),
  );
  const [target, setTarget] = useState<Target>(ownEmail ? "myself" : "email");
  const [to, setTo] = useState("");
  const [outcome, setOutcome] = useState<{ sent: boolean; disabled?: boolean } | null>(null);
  const send = useSendDsrSheet();

  useResetOn(open ? `${sheet.storeId}:${sheet.period}:${sheet.date}` : null, () => {
    setTarget(ownEmail ? "myself" : "email");
    setTo("");
    setOutcome(null);
  });

  const isWhatsApp = target === "whatsapp";
  const channel = isWhatsApp ? "whatsapp" : "email";
  const trimmed = to.trim();
  const recipient =
    target === "myself"
      ? (ownEmail ?? "")
      : isWhatsApp
        ? (normalizeIndianMobile(trimmed) ?? "")
        : isValidEmail(trimmed)
          ? trimmed
          : "";
  const recipientError = target !== "myself" && trimmed.length > 0 && !recipient;

  function submit() {
    if (!recipient) {
      toast.error(
        isWhatsApp
          ? "Enter a valid 10-digit Indian mobile number."
          : "Enter a valid email address.",
      );
      return;
    }
    setOutcome(null);
    send.mutate(
      { ...sheet, channel, to: recipient },
      {
        onSuccess: (res) => {
          setOutcome({ sent: res.sent, disabled: res.disabled });
          if (res.sent) toast.success(`Sheet sent — ${res.filename}`);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not send the sheet.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Send the DSR sheet</DialogTitle>
          <DialogDescription>
            {`${sheet.period === "day" ? "Day" : sheet.period === "week" ? "Week" : "Month"} of ${sheet.date} · ${
              sheet.format === "xlsx" ? "Excel" : "PDF"
            }`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Send to</Label>
            <div className="grid grid-cols-3 gap-2">
              {TARGETS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-pressed={target === t.value}
                  disabled={t.value === "myself" && !ownEmail}
                  onClick={() => {
                    setTarget(t.value);
                    setTo("");
                    setOutcome(null);
                  }}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
                    target === t.value
                      ? "border-[var(--gold)] bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-foreground shadow-xs"
                      : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <ChannelStatusNotice channel={isWhatsApp ? "whatsapp" : "email"} />

          {target === "myself" ? (
            <p className="text-sm text-muted-foreground">
              Emailed to {ownEmail ?? "your address"}.
            </p>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-sheet-to">
                {isWhatsApp ? "WhatsApp number" : "Recipient email"}
              </Label>
              <Input
                id="dsr-sheet-to"
                type={isWhatsApp ? "tel" : "email"}
                inputMode={isWhatsApp ? "numeric" : "email"}
                maxLength={isWhatsApp ? 10 : undefined}
                placeholder={isWhatsApp ? "9876500000" : "reports@example.com"}
                value={to}
                aria-invalid={recipientError}
                onChange={(e) => {
                  setTo(isWhatsApp ? phoneInputValue(e.target.value) : e.target.value);
                  setOutcome(null);
                }}
              />
              {recipientError ? (
                <p className="text-xs text-destructive">
                  {isWhatsApp
                    ? "Enter a valid 10-digit Indian mobile number (digits only)."
                    : "Enter a valid email address."}
                </p>
              ) : null}
            </div>
          )}

          {outcome?.disabled ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {isWhatsApp ? "WhatsApp" : "Email"} isn&apos;t configured yet — nothing
                was sent.
              </span>
            </div>
          ) : outcome?.sent ? (
            <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Sheet delivered.</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={submit} disabled={send.isPending || !recipient}>
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
