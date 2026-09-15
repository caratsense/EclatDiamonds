"use client";

import * as React from "react";
import { Download, Plus, Share } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePwaInstall } from "@/components/pwa/use-pwa-install";

/**
 * Step-by-step iOS install instructions. iOS Safari has no install prompt API,
 * so the user adds the app manually from the Share sheet. Controlled so the
 * standalone button and the user-menu item can each drive it.
 */
export function IosInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Install CaratOS</DialogTitle>
          <DialogDescription>
            Add CaratOS to your Home Screen to open it like an app.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3 text-sm">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              1
            </span>
            <span className="pt-0.5">
              Tap the <span className="font-medium">Share</span> control (the
              square with an upward arrow) in the Safari toolbar.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              2
            </span>
            <span className="pt-0.5">
              Scroll down and choose{" "}
              <span className="font-medium">Add to Home Screen</span>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <span className="pt-0.5">
              Tap <span className="font-medium">Add</span>. CaratOS will
              appear on your Home Screen.
            </span>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

export interface InstallAppButtonProps {
  /** Button label; ignored when `iconOnly`. */
  label?: string;
  /** Visual variant, forwarded to the shared Button. */
  variant?: ButtonProps["variant"];
  /** Button size, forwarded to the shared Button. */
  size?: ButtonProps["size"];
  className?: string;
  /** Render only the icon (compact placements such as a top bar). */
  iconOnly?: boolean;
}

/**
 * Visible "Install app" affordance that adapts to the platform:
 *  - Chromium / Android / desktop → triggers the native install prompt.
 *  - iOS Safari → opens step-by-step Add-to-Home-Screen instructions.
 *  - Already installed / not installable → renders nothing.
 */
export function InstallAppButton({
  label = "Install app",
  variant = "outline",
  size = "default",
  className,
  iconOnly = false,
}: InstallAppButtonProps) {
  const { status, promptNative } = usePwaInstall();
  const [iosOpen, setIosOpen] = React.useState(false);

  if (status === "hidden") return null;

  const isIOS = status === "ios";
  const Icon = isIOS ? Share : Download;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={iconOnly ? "icon" : size}
        className={className}
        aria-label={iconOnly ? label : undefined}
        onClick={() => (isIOS ? setIosOpen(true) : promptNative())}
      >
        <Icon />
        {iconOnly ? (
          <span className="sr-only">{label}</span>
        ) : (
          <>
            {label}
            {isIOS ? <Plus className="opacity-70" /> : null}
          </>
        )}
      </Button>
      {isIOS ? (
        <IosInstallDialog open={iosOpen} onOpenChange={setIosOpen} />
      ) : null}
    </>
  );
}
