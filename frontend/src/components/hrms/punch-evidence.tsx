"use client";

import { useState } from "react";
import { Camera, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AuthedImage } from "@/components/ui/authed-image";
import type { AttendanceRecord } from "@/lib/mock/hrms";

/**
 * The photo taken at a punch, for the manager reviewing it.
 *
 * This is the missing half of the attendance-evidence feature. The photo was
 * captured on the phone, validated, stored under the tenant's prefix and
 * returned by the API — and no screen anywhere rendered it, so the whole
 * exercise produced write-only storage of people's faces. It belongs next to
 * the distance and the mock-location flag, which are the other two things a
 * manager looks at when a punch smells wrong.
 *
 * ## What it deliberately does not say
 *
 * That the photo proves who punched. Nothing compares it to an enrolled face,
 * here or on the server. The identity on the record comes from the session that
 * made the punch; this is corroboration a human can weigh, and the caption says
 * exactly that. A badge reading "verified" would make a buddy punch MORE
 * convincing than one with no photo at all.
 */
export function PunchEvidenceButton({ record }: { record: AttendanceRecord }) {
  const [open, setOpen] = useState(false);
  const has = Boolean(record.checkInPhotoUrl || record.checkOutPhotoUrl);

  if (!has) {
    return (
      <span className="text-xs text-muted-foreground" title="No photo was taken with this punch">
        —
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={() => setOpen(true)}
        aria-label={`View the photo taken with ${record.name}'s punch`}
      >
        <Camera className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{record.name}&rsquo;s punch</DialogTitle>
            <DialogDescription>
              {record.date ? `${record.date} · ` : ""}
              {record.checkIn ? `in ${record.checkIn}` : "no check-in"}
              {record.checkOut ? ` · out ${record.checkOut}` : ""}
              {record.storeName ? ` · ${record.storeName}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Shot label="Check-in" src={record.checkInPhotoUrl} who={record.name} />
            <Shot label="Check-out" src={record.checkOutPhotoUrl} who={record.name} />
          </div>

          {/* The other two review signals, so all three are read together. */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border p-3 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Distance</dt>
              <dd className="tabular-nums">
                {record.distanceM == null ? "—" : `${record.distanceM} m`}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Inside the fence</dt>
              <dd>{record.checkIn ? (record.withinFence ? "Yes" : "No") : "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Mock location</dt>
              <dd>{record.isMockLocation ? "Reported" : "Not reported"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Closed by the system</dt>
              <dd>{record.autoClosed ? "Yes" : "No"}</dd>
            </div>
          </dl>

          {record.checkInNote ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Reason given: </span>
              {record.checkInNote}
            </p>
          ) : null}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              A camera on the device produced this image at the time of the punch. The app does
              not identify anyone from it; the attendance record belongs to the signed-in account.
            </span>
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Shot({ label, src, who }: { label: string; src?: string | null; who: string }) {
  return (
    <figure className="space-y-1.5">
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
      {src ? (
        <AuthedImage
          src={src}
          alt={`Photo taken at ${who}'s ${label.toLowerCase()}`}
          className="aspect-[4/3] w-full rounded-md border border-border object-cover"
        />
      ) : (
        <div className="grid aspect-[4/3] w-full place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
          No photo
        </div>
      )}
    </figure>
  );
}
