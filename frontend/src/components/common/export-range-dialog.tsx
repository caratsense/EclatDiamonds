"use client";

import { useEffect, useState } from "react";
import { CalendarRange, Download, Loader2 } from "lucide-react";

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
  type ExportRange,
  type RangePreset,
  RANGE_PRESET_LABELS,
  presetRange,
  rangeProblem,
} from "@/lib/queries/exports";

/**
 * "From which to which date do you want to download?" (client, 21 Nov.)
 *
 * ## Why All time is selected when it opens
 *
 * She downloads the whole sheet today, in one click. Asking first makes that
 * slower, and a dialog that opened with two empty boxes and a dead Download
 * button would have made it slower AND made the common case the hard one. So
 * All time is the landing state: open, Download, done — one extra click, not a
 * form to fill in. Every narrower range is one more click than that, which is
 * the right way round.
 *
 * ## Why one end of a custom range is enough
 *
 * "Everything since 1 November" is a real question and the server answers it
 * (an absent bound is simply not filtered). Only a backwards range is refused,
 * and refused here, beside the boxes — not as a failed download.
 */
export function ExportRangeDialog({
  open,
  onOpenChange,
  title,
  /**
   * Which date the server will filter on, in the words a person would use:
   * "the day the lead arrived", "the day the customer walked in". Named on
   * screen because an export ranged on the wrong column is a file that looks
   * right and reconciles wrong, and this is the only place we can say which.
   */
  rangedOn,
  /** Shown under the choices: which column format the file will use, if any. */
  formatNote,
  busy,
  onDownload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  rangedOn: string;
  formatNote?: string;
  busy?: boolean;
  onDownload: (range: ExportRange) => void;
}) {
  const [preset, setPreset] = useState<RangePreset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Re-opened means asked again. Carrying last time's range over would make the
  // second download silently narrower than the person expects.
  useEffect(() => {
    if (open) {
      setPreset("all");
      setFrom("");
      setTo("");
    }
  }, [open]);

  const range: ExportRange =
    preset === "custom"
      ? { from: from || undefined, to: to || undefined }
      : presetRange(preset);
  const problem = rangeProblem(range);

  const choose = (next: RangePreset) => {
    setPreset(next);
    if (next === "custom") return;
    // The boxes follow the choice rather than emptying, so "This month" shows
    // WHICH month — the dialog says what it is about to download, not just that
    // it will download something.
    const resolved = presetRange(next);
    setFrom(resolved.from ?? "");
    setTo(resolved.to ?? "");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarRange className="size-4" /> {title}
          </DialogTitle>
          <DialogDescription>
            Dated by {rangedOn}. Leave it on <b>All time</b> for the whole sheet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(RANGE_PRESET_LABELS) as (keyof typeof RANGE_PRESET_LABELS)[]).map(
              (key) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={preset === key ? "default" : "outline"}
                  aria-pressed={preset === key}
                  onClick={() => choose(key)}
                >
                  {RANGE_PRESET_LABELS[key]}
                </Button>
              ),
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="export-from">From</Label>
              <Input
                id="export-from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset("custom");
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="export-to">To</Label>
              <Input
                id="export-to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset("custom");
                }}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Both dates are included. Clear them both, or press <b>All time</b>, for everything.
          </p>

          {formatNote ? <p className="text-xs text-muted-foreground">{formatNote}</p> : null}

          {problem ? <p className="text-sm text-destructive">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onDownload(range)} disabled={busy || problem != null}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
