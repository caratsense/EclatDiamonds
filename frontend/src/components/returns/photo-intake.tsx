"use client";

import * as React from "react";
import { Camera, ImageIcon, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { INTAKE_PHOTO_SLOTS } from "@/lib/mock/returns";

/**
 * Photo-based intake (Module 14): terminal-friendly drop zones that prompt
 * staff to document the condition of returned jewelry / old-gold at intake.
 * Tiles are mocked (no real upload) — clicking toggles a captured thumbnail.
 */
export function PhotoIntake() {
  const [captured, setCaptured] = React.useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCaptured((prev) => ({ ...prev, [key]: !prev[key] }));

  const count = Object.values(captured).filter(Boolean).length;

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
          const isCaptured = captured[slot.key];
          return (
            <button
              key={slot.key}
              type="button"
              onClick={() => toggle(slot.key)}
              aria-pressed={isCaptured}
              className={cn(
                "group relative flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-center transition-colors",
                isCaptured
                  ? "border-transparent"
                  : "border-muted-foreground/30 hover:border-primary/50 hover:bg-accent",
              )}
            >
              {isCaptured ? (
                <>
                  <span
                    className={cn(
                      "absolute inset-0 rounded-md bg-gradient-to-br",
                      slot.swatch,
                    )}
                  />
                  <span className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm">
                    <X className="h-3 w-3" />
                  </span>
                  <ImageIcon className="relative z-10 h-5 w-5 text-foreground/70" />
                  <span className="relative z-10 px-1 text-[11px] font-medium text-foreground/80">
                    {slot.label}
                  </span>
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5 text-muted-foreground" />
                  <span className="px-1 text-[11px] text-muted-foreground">
                    {slot.label}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Camera className="h-3.5 w-3.5" />
        Tap a tile to capture from the terminal camera. Mocked for Phase 2.
      </p>
    </div>
  );
}
