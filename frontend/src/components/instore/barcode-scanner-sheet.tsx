"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CameraOff, Keyboard, Loader2, ScanLine } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useScanItem, type ScannedItem } from "@/lib/queries/instore";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Scan or type an item code.
 *
 * Three things this deliberately does NOT do:
 *
 *   1. It does not ship example codes. The previous version listed four
 *      jewellery SKUs on screen, which is wrong twice over — it is a jewellery
 *      assumption in a universal product, and staff tapping a sample would file
 *      an interest in an item the customer never saw.
 *   2. It does not require a camera. `BarcodeDetector` is not available in every
 *      browser and permission is often refused, so typing is a first-class path
 *      rather than a fallback nobody finds.
 *   3. It does not decide what the code means. The API answers that, including
 *      "no such item", which is an ordinary outcome at a counter.
 */

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type CameraState = "idle" | "starting" | "running" | "denied" | "unsupported" | "error";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the resolved item, or with the raw code when nothing matched. */
  onResolved: (result: ScannedItem) => void;
}

export function BarcodeScannerSheet({ open, onOpenChange, onResolved }: Props) {
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState<CameraState>("idle");
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const scan = useScanItem();

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("idle");
  }, []);

  const submit = useCallback(
    (code: string) => {
      const value = code.trim();
      if (!value) return;
      setLookupError(null);
      setNotFound(null);
      scan.mutate(value, {
        onSuccess: (result) => {
          if (!result.found) {
            // Not an error: an uncatalogued tag is a normal thing to scan. The
            // caller may still record interest against the raw code.
            setNotFound(result.code);
            onResolved(result);
            return;
          }
          stopCamera();
          onResolved(result);
          onOpenChange(false);
        },
        onError: (e) => setLookupError(apiErrorMessage(e, "Could not look that code up.")),
      });
    },
    [onOpenChange, onResolved, scan, stopCamera],
  );

  const startCamera = useCallback(async () => {
    const Detector = (globalThis as unknown as { BarcodeDetector?: new (o?: unknown) => BarcodeDetectorLike })
      .BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setCamera("unsupported");
      setCameraMessage(
        "This browser cannot read barcodes with the camera. Type the code instead — it works the same.",
      );
      return;
    }
    setCamera("starting");
    setCameraMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamera("running");

      const detector = new Detector({
        formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "qr_code"],
      });
      const tick = async () => {
        if (!videoRef.current || !streamRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes.length && codes[0].rawValue) {
            submit(codes[0].rawValue);
            return;
          }
        } catch {
          // A frame that cannot be decoded is the normal case, not a failure.
        }
        rafRef.current = requestAnimationFrame(() => void tick());
      };
      rafRef.current = requestAnimationFrame(() => void tick());
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "SecurityError");
      setCamera(denied ? "denied" : "error");
      setCameraMessage(
        denied
          ? "Camera access was refused. You can allow it in your browser settings, or type the code."
          : "The camera would not start. Type the code instead.",
      );
    }
  }, [submit]);

  /*
   * `open` is a dependency, so React runs this cleanup when the dialog closes as
   * well as on unmount — which is exactly when the camera must be released.
   * Calling stopCamera in the effect BODY as well was redundant and set state
   * during render, so the cleanup is the whole mechanism.
   */
  useEffect(() => stopCamera, [open, stopCamera]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Scan an item</DialogTitle>
          <DialogDescription>
            Point the camera at the tag, or type the code printed on it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-md border border-border bg-muted">
            {camera === "running" ? (
              <div className="relative">
                <video ref={videoRef} playsInline muted className="h-48 w-full object-cover" />
                <div className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-foreground/70" />
              </div>
            ) : (
              <div className="flex h-48 flex-col items-center justify-center gap-3 p-4 text-center">
                {camera === "starting" ? (
                  <>
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Starting the camera…</p>
                  </>
                ) : camera === "denied" || camera === "unsupported" || camera === "error" ? (
                  <>
                    <CameraOff className="h-6 w-6 text-muted-foreground" />
                    <p className="max-w-[15rem] text-xs text-muted-foreground">{cameraMessage}</p>
                  </>
                ) : (
                  <>
                    <ScanLine className="h-6 w-6 text-muted-foreground" />
                    <Button size="sm" variant="outline" onClick={() => void startCamera()}>
                      <Camera className="mr-2 h-4 w-4" />
                      Use the camera
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-code" className="flex items-center gap-1.5">
              <Keyboard className="h-3.5 w-3.5" />
              Type the code
            </Label>
            <div className="flex gap-2">
              <Input
                id="manual-code"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  // A hardware/Bluetooth scanner types the code and presses
                  // Enter, so this input is also how those work — no extra
                  // integration needed.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit(manual);
                  }
                }}
                placeholder="Code from the tag"
                autoComplete="off"
                maxLength={120}
              />
              <Button onClick={() => submit(manual)} disabled={scan.isPending || !manual.trim()}>
                {scan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A handheld scanner works here too — it types the code and presses Enter.
            </p>
          </div>

          {notFound ? (
            <div className="flex gap-2 rounded-md border border-border bg-muted/50 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1">
                <p>
                  Nothing in your catalogue matches{" "}
                  <Badge variant="outline" className="font-[family-name:var(--font-mono-face)]">
                    {notFound}
                  </Badge>
                </p>
                <p className="text-muted-foreground">
                  You can still record the customer&apos;s interest against this code.
                </p>
              </div>
            </div>
          ) : null}

          {lookupError ? (
            <p role="alert" className="text-xs text-destructive">
              {lookupError}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
