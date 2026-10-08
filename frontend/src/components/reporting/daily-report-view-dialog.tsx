"use client";

import { useMemo } from "react";
import { Copy } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  composeDailyReportText,
  type DailyReport,
} from "@/lib/mock/reporting";

/**
 * A filed DSR, readable in full.
 *
 * This used to be the send dialog — channel pick, recipient box, Send button.
 * All of that is gone (client, 8 Oct): the DSR reaches head office through the
 * automated evening digest and nowhere else, and everyone else reads or
 * downloads. Copy stays because pasting a day's figures into a chat with a
 * colleague is reading, not delivery.
 */
export function DailyReportViewDialog({
  report,
  open,
  onOpenChange,
}: {
  report: DailyReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Prefer the server-composed text; fall back to composing client-side.
  const text = useMemo(() => {
    if (!report) return "";
    return report.text || composeDailyReportText(report, report.storeName ?? "");
  }, [report]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Report text copied");
    } catch {
      toast.error("Couldn't copy. Select the text and copy manually.");
    }
  }

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
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[12.5px] leading-relaxed">
            {text}
          </pre>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
