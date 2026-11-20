"use client";

import * as React from "react";
import { Camera, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { INTAKE_PHOTO_SLOTS } from "@/lib/mock/returns";

/**
 * Photo-based intake (Module 14): terminal-friendly capture tiles that prompt
 * staff to document the condition of returned jewelry / old-gold at intake.
 *
 * Each tile is a real camera capture — on a tablet/phone `capture="environment"`
 * opens the rear camera; on desktop it falls back to a file picker. The thumbnail
 * shown is the ACTUAL captured image (object URL), not a placeholder.
 *
 * ponytail: capture + local preview only; server persistence of intake photos is
 * a backend follow-up (no /returns intake-photo endpoint yet). Wire the captured
 * File[] to an upload when that lands.
 */
export function PhotoIntake() {
  // slot key -> captured File (kept so a future submit can upload them).
  const [files, setFiles] = React.useState<Record<string, File>>({});
  // slot key -> object URL for the preview; revoked when replaced/cleared.
  const [previews, setPreviews] = React.useState<Record<string, string>>({});

  // Revoke every outstanding object URL on unmount so we don't leak blobs.
  React.useEffect(() => {
    return () => {
      Object.values(previews).forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function capture(key: string, file: File | undefined) {
    if (!file) return;
    setPreviews((prev) => {
      if (prev[key]) URL.revokeObjectURL(prev[key]);
      return { ...prev, [key]: URL.createObjectURL(file) };
    });
    setFiles((prev) => ({ ...prev, [key]: file }));
  }

  function clear(key: string) {
    setPreviews((prev) => {
      if (prev[key]) URL.revokeObjectURL(prev[key]);
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setFiles((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const count = Object.keys(files).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Condition photos</p>
        <span className="text-xs text-muted-foreground">
          <span className="num">{count}</span> /{" "}
          <span className="num">{INTAKE_PHOTO_SLOTS.length}</span> captured
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {INTAKE_PHOTO_SLOTS.map((slot) => {
          const preview = previews[slot.key];
          const inputId = `intake-photo-${slot.key}`;
          return (
            <div key={slot.key} className="relative">
              {/* Real capture: rear camera on mobile, file picker on desktop. */}
              <input
                id={inputId}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  capture(slot.key, e.target.files?.[0]);
                  // Allow re-selecting the same file to re-fire onChange.
                  e.target.value = "";
                }}
              />
              {preview ? (
                <div className="group relative aspect-square overflow-hidden rounded-lg border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview}
                    alt={`${slot.label} — captured`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => clear(slot.key)}
                    aria-label={`Remove ${slot.label}`}
                    className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <span className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 text-left text-[11px] font-medium text-white">
                    {slot.label}
                  </span>
                </div>
              ) : (
                <label
                  htmlFor={inputId}
                  className={cn(
                    "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/30 text-center transition-colors hover:border-primary/50 hover:bg-accent",
                  )}
                >
                  <Plus className="h-5 w-5 text-muted-foreground" />
                  <span className="px-1 text-[11px] text-muted-foreground">
                    {slot.label}
                  </span>
                </label>
              )}
            </div>
          );
        })}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Camera className="h-3.5 w-3.5" />
        Tap a tile to capture from the device camera. Photos stay on this device
        until intake-photo sync is enabled.
      </p>
    </div>
  );
}
