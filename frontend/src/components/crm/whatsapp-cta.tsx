"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StartWhatsAppDialog } from "@/components/crm/start-whatsapp-dialog";
import { cn } from "@/lib/utils";

/**
 * "Message on WhatsApp", anywhere a person and a number are on screen.
 *
 * The gap this fills: the lead screens could RECORD that somebody had messaged
 * a customer — "Log WhatsApp" — without offering any way to actually do it. A
 * salesperson holding a lead's number had to leave the product, open WhatsApp
 * on their own phone, and come back to log it, which is also how the thread
 * ends up outside the CRM entirely.
 *
 * It owns its own dialog rather than taking one from a parent, because the
 * point is to drop it beside a phone number on any screen without that screen
 * having to learn about templates, the 24-hour window or the outbox.
 *
 * Renders nothing without a number. A disabled button that cannot say why is
 * worse than no button: it reads as broken rather than as "we have no number
 * for this person".
 */
export function WhatsAppCta({
  phone,
  name,
  size = "sm",
  variant = "outline",
  label = "WhatsApp",
  className,
  /** Stops the click reaching a clickable card behind it. */
  stopPropagation = false,
}: {
  phone?: string | null;
  name?: string | null;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "ghost" | "default" | "secondary";
  label?: string | null;
  className?: string;
  stopPropagation?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!phone?.trim()) return null;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={cn("shrink-0", className)}
        title={name ? `Message ${name} on WhatsApp` : "Message on WhatsApp"}
        onClick={(e) => {
          if (stopPropagation) {
            e.stopPropagation();
            e.preventDefault();
          }
          setOpen(true);
        }}
      >
        <MessageCircle className="h-3.5 w-3.5" />
        {label}
      </Button>

      {/* Mounted only once opened: a list of fifty leads would otherwise mount
          fifty dialogs, each with its own template query. */}
      {open ? (
        <div
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
          }}
        >
          <StartWhatsAppDialog open={open} onOpenChange={setOpen} phone={phone} name={name} />
        </div>
      ) : null}
    </>
  );
}
