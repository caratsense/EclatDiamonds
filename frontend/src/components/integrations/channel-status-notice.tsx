"use client";

import { AlertTriangle } from "lucide-react";

import {
  CHANNEL_LABEL,
  useIntegrationStatus,
  type IntegrationChannel,
} from "@/lib/queries/integrations";
import { cn } from "@/lib/utils";

/**
 * Warns, up front, that a channel is not connected on this deployment.
 *
 * Placed next to the send controls rather than shown after the attempt: the
 * damage from a silent no-op is done at the counter, when someone tells a
 * customer the price is on its way. Renders nothing when the channel is live, so
 * it disappears by itself the day credentials are added — no follow-up cleanup.
 */
export function ChannelStatusNotice({
  channel,
  className,
}: {
  channel: IntegrationChannel;
  className?: string;
}) {
  const { data } = useIntegrationStatus();
  // Say nothing until we know. Guessing "not connected" while the request is in
  // flight would flash a false alarm on every open.
  if (!data || data[channel]) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <strong className="font-semibold">
          {CHANNEL_LABEL[channel]} is not connected yet.
        </strong>{" "}
        Anything you send from here will be prepared but <strong>not</strong>{" "}
        delivered. Copy the text and send it by hand for now, and ask your
        administrator to finish the setup.
      </span>
    </div>
  );
}
