"use client";

import * as React from "react";
import { toast } from "sonner";

/**
 * The `beforeinstallprompt` event is not part of the standard DOM lib types,
 * so we describe the shape we rely on (Chromium / Android / desktop Chrome).
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type PwaInstallStatus =
  /** A native install prompt is available (Chromium/Android/desktop). */
  | "native"
  /** iOS Safari — no prompt API; the user installs via the Share sheet. */
  | "ios"
  /** Already installed, running standalone, or install is unavailable. */
  | "hidden";

/**
 * Cross-platform PWA install state, shared by the standalone install button
 * and the user-menu item so the platform logic lives in exactly one place.
 *
 * SSR-safe: every `window` / `navigator` access is guarded and deferred to an
 * effect, so the first render matches the server ("hidden") and hydrates.
 */
export function usePwaInstall() {
  const [deferred, setDeferred] =
    React.useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = React.useState(false);
  const [isStandalone, setIsStandalone] = React.useState(false);
  const [isIOS, setIsIOS] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone ===
        true;
    setIsStandalone(Boolean(standalone));

    const ua = window.navigator.userAgent || "";
    const iOS = /iphone|ipad|ipod/i.test(ua);
    setIsIOS(iOS && !standalone);

    const onBeforeInstallPrompt = (e: Event) => {
      // Stop Chrome's mini-infobar; we surface our own button instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /** Show the browser's native install prompt (no-op on iOS). */
  const promptNative = React.useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    // A prompt can only be used once; drop it whatever the outcome.
    setDeferred(null);
    if (choice.outcome === "accepted") {
      setInstalled(true);
      toast.success("App installed");
    }
  }, [deferred]);

  const status: PwaInstallStatus =
    installed || isStandalone
      ? "hidden"
      : deferred
        ? "native"
        : isIOS
          ? "ios"
          : "hidden";

  return { status, isStandalone, promptNative };
}
