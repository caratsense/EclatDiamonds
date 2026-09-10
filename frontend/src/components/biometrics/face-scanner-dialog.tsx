"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Check, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Camera capture for an attendance punch.
 *
 * WHAT THIS DOES: opens the device camera, lets the person frame themselves,
 * and hands back a single still. That image is stored beside the punch as
 * corroboration, next to the geofence distance and the mock-location flag that
 * are already recorded.
 *
 * WHAT IT DOES NOT DO, ANYWHERE: recognise a face. Nothing here — and nothing on
 * the server — compares the image to an enrolled template, so this never
 * establishes WHO is standing in front of the camera. The overlay is a framing
 * guide, and it says so on screen. The temptation with a scanner like this is to
 * animate a match and print a confidence score; that would make a buddy punch
 * MORE convincing than one with no photo at all, because the record would carry
 * a badge saying it had been checked. A photo a manager can look at is worth
 * something. A number nobody computed is worth less than nothing.
 *
 * Every failure path leaves the punch available: no camera, denied permission,
 * no secure context, a stream that never starts. The caller is expected to keep
 * its ordinary check-in button working — this is an addition to the punch, never
 * a gate in front of it.
 */

/** Small enough to upload on a shop's connection, big enough to recognise a face. */
const CAPTURE_WIDTH = 640;
const JPEG_QUALITY = 0.72;

type Phase = "idle" | "starting" | "live" | "captured" | "denied" | "unsupported" | "failed";

export function FaceScannerDialog({
  open,
  onOpenChange,
  onCapture,
  busy,
  title = "Photo check-in",
  confirmLabel = "Use this photo",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives a `data:image/jpeg;base64,…` still. */
  onCapture: (photo: string) => void;
  busy?: boolean;
  title?: string;
  confirmLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shot, setShot] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    setDetail(null);
    setShot(null);

    // getUserMedia only exists in a secure context. Saying so beats a generic
    // failure, because the fix is "open this over https", not "try again".
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unsupported");
      setDetail(
        typeof window !== "undefined" && !window.isSecureContext
          ? "The camera is only available over a secure (https) connection."
          : "This device or browser does not offer camera access.",
      );
      return;
    }

    setPhase("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setPhase("live");
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPhase("denied");
        setDetail("Camera permission was refused. You can still check in without a photo.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setPhase("unsupported");
        setDetail("No camera was found on this device.");
      } else {
        setPhase("failed");
        setDetail("The camera could not be started. You can still check in without a photo.");
      }
    }
  }, []);

  // The camera is started by a tap, never by opening the dialog. Two reasons:
  // a getUserMedia call that follows a real user gesture is the one browsers
  // treat most kindly, and a permission prompt that appears because a sheet
  // slid up is startling. The effect here only releases the device.
  useEffect(() => stop, [stop]);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    const scale = CAPTURE_WIDTH / video.videoWidth;
    canvas.width = CAPTURE_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Mirrored on screen so it reads like a mirror; captured unmirrored so the
    // stored image matches what a person reviewing it would see in the room.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setShot(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    setPhase("captured");
    stop();
  }

  function confirm() {
    if (shot) onCapture(shot);
  }

  const cameraUnavailable = phase === "denied" || phase === "unsupported" || phase === "failed";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          stop();
          setPhase("idle");
          setShot(null);
          setDetail(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            The photo is stored with your punch so a manager can see who checked in. It is not
            matched against anything — your identity comes from your login.
          </DialogDescription>
        </DialogHeader>

        <div className="relative overflow-hidden rounded-lg border border-border bg-black">
          <div className="aspect-[4/3] w-full">
            {shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shot} alt="The photo about to be saved with your punch" className="h-full w-full object-cover" />
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                className="h-full w-full -scale-x-100 object-cover"
                aria-label="Camera preview"
              />
            )}
          </div>

          {phase === "live" ? <FramingGuide /> : null}

          {phase === "idle" ? (
            <div className="absolute inset-0 grid place-items-center bg-background/95 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                The camera is off. Turn it on to take the photo.
              </p>
            </div>
          ) : null}

          {phase === "starting" ? (
            <div className="absolute inset-0 grid place-items-center text-sm text-white/80">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Starting the camera…
              </span>
            </div>
          ) : null}

          {cameraUnavailable ? (
            <div className="absolute inset-0 grid place-items-center bg-background/95 p-6 text-center">
              <div className="space-y-2">
                <CameraOff className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="text-sm text-muted-foreground">{detail}</p>
              </div>
            </div>
          ) : null}
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            The outline is a framing guide only. No face recognition runs here or on the server.
          </span>
        </p>

        <canvas ref={canvasRef} className="hidden" />

        <DialogFooter className="gap-2 sm:gap-2">
          {phase === "captured" ? (
            <>
              <Button type="button" variant="outline" onClick={() => void start()} disabled={busy}>
                Retake
              </Button>
              <Button type="button" onClick={confirm} disabled={busy || !shot}>
                {busy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="mr-1.5 h-4 w-4" aria-hidden />
                )}
                {confirmLabel}
              </Button>
            </>
          ) : cameraUnavailable ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" onClick={() => void start()}>
                Try again
              </Button>
            </>
          ) : phase === "live" ? (
            <Button type="button" onClick={capture}>
              <Camera className="mr-1.5 h-4 w-4" aria-hidden />
              Take photo
            </Button>
          ) : (
            <Button type="button" onClick={() => void start()} disabled={phase === "starting"}>
              {phase === "starting" ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Camera className="mr-1.5 h-4 w-4" aria-hidden />
              )}
              Turn on camera
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Corner marks and an oval, so a person knows roughly where to put their face.
 *
 * Deliberately static. A sweeping laser line and a ticking percentage would read
 * as detection in progress, and nothing is being detected — the animation would
 * be the claim, even with the caption underneath.
 */
function FramingGuide() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <svg viewBox="0 0 100 75" className="h-full w-full" preserveAspectRatio="none">
        <ellipse
          cx="50"
          cy="36"
          rx="21"
          ry="28"
          fill="none"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="0.4"
          strokeDasharray="2 2"
        />
        {[
          "M6,16 L6,7 L16,7",
          "M84,7 L94,7 L94,16",
          "M94,59 L94,68 L84,68",
          "M16,68 L6,68 L6,59",
        ].map((d) => (
          <path key={d} d={d} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="0.7" />
        ))}
      </svg>
    </div>
  );
}
