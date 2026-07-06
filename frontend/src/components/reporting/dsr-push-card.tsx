"use client";

import { Mail, MessageCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DSR_SUMMARY } from "@/lib/mock/reporting";

/** Evening-summary preview with mock "push to WhatsApp / email" actions. */
export function DsrPushCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Evening DSR Summary
        </CardTitle>
        <CardDescription>
          Auto-generated for {DSR_SUMMARY.date} — pushed to owner every evening
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
          {DSR_SUMMARY.highlights.map((h, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>{h}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className="flex-1"
            onClick={() => toast.success("DSR pushed to owner's WhatsApp (mock)")}
          >
            <MessageCircle className="h-4 w-4" />
            Push to WhatsApp
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => toast.success("DSR emailed to management (mock)")}
          >
            <Mail className="h-4 w-4" />
            Email Report
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
