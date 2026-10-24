"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DailyReportForm } from "@/components/reporting/daily-report-form";
import { useSession } from "@/store/use-session";

/**
 * Filing the DSR as a dialog (design, 17 Oct).
 *
 * The sheet used to sit open on the page under everything else, so the screen
 * had to be a filing form and a reporting dashboard at the same time and was
 * not very good at either. Behind a button, the page is free to be the day's
 * figures, and filing is a deliberate act with its own surface.
 *
 * The form itself is unchanged — same fields, same funnel rule, same carried
 * opening balance. Only where it lives has moved.
 */
export function DailyReportDialog({
  trigger,
  open: openProp,
  onOpenChange,
}: {
  /** Replaces the default "File DSR" button — for a card or a menu row. */
  trigger?: React.ReactNode;
  /**
   * Controlled mode, for a page that already has a File DSR button of its own
   * in its header. Given these, the dialog renders NO trigger — two buttons
   * for one action on one screen is the thing this avoids.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolled;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setUncontrolled;
  const { currentStore } = useSession();
  const storeLabel = currentStore.isAggregate ? null : currentStore.name;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlled ? null : (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button variant="gold">
              <Plus className="h-4 w-4" />
              File DSR
            </Button>
          )}
        </DialogTrigger>
      )}
      {/*
       * Heading fixed, blocks scrolling, actions fixed: the five blocks run
       * past a laptop viewport when they are all open, and a dialog that
       * pushes its own File button off-screen cannot be submitted.
       */}
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-6 pb-3 pt-6">
          <DialogTitle>File today&apos;s report</DialogTitle>
          <DialogDescription>
            {storeLabel
              ? `Store-close figures for ${storeLabel}`
              : "Choose the store you're filing for"}
          </DialogDescription>
        </DialogHeader>
        <DailyReportForm
          inDialog
          onCancel={() => setOpen(false)}
          onFiled={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
