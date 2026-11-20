"use client";

import { useState } from "react";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Head office speaks to everyone at once.
 *
 * The announcement lands in every active person's notification bell, which
 * already streams — so an open dashboard shows it the moment Send is pressed.
 * Deliberately the bell and not a new banner system: one notification surface
 * that is already on every screen, with read/dismiss people already know.
 */
export function AnnounceDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const heading = title.trim();
    if (heading.length < 3) {
      toast.error("Give the announcement a short heading.");
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post<{ recipients: number }>("/notifications/announce", {
        title: heading,
        body: body.trim() || undefined,
      });
      toast.success(`Announced to ${data.recipients} people.`, {
        description: "It is in everyone's notification bell now.",
      });
      setTitle("");
      setBody("");
      setOpen(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not send the announcement."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Megaphone className="h-3.5 w-3.5" /> Announce
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Announcement to every store</DialogTitle>
          <DialogDescription>
            Lands in the notification bell of every active person in the
            organisation, immediately. Audited under your name.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="announce-title">Heading</Label>
            <Input
              id="announce-title"
              maxLength={120}
              placeholder="e.g. Diwali hours: all stores open till 10 PM"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="announce-body">Detail (optional)</Label>
            <Textarea
              id="announce-body"
              rows={4}
              maxLength={1000}
              placeholder="Anything the heading does not say."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || title.trim().length < 3}>
            {sending ? "Sending…" : "Send to everyone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
