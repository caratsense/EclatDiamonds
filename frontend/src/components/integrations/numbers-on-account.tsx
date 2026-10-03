"use client";

import { Bot, Phone, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessagingRoutes } from "@/lib/queries/messaging-routes";

/**
 * Which numbers this WhatsApp account runs, and who each one answers.
 *
 * ## Templates belong to the ACCOUNT, not to a number
 *
 * This panel exists because that is counter-intuitive and the opposite
 * assumption is expensive. Asked whether templates are bound to numbers, the
 * Graph API is unambiguous:
 *
 *   GET /{phone-number-id}/message_templates   ->  error 100, no such edge
 *   GET /{waba-id}/message_templates           ->  the templates
 *
 * So every number on an account can send every approved template on it. A
 * business running a shopfront line and an operations line does NOT need two
 * sets, and building a per-number view would have taught somebody a rule that
 * is not true — then left them wondering why a template they wrote "for" one
 * number worked on the other.
 *
 * What DOES differ per number is who the bot answers, which is the thing this
 * panel actually shows.
 */
export function NumbersOnAccount() {
  const routes = useMessagingRoutes("whatsapp");
  const numbers = routes.data?.numbers ?? [];

  if (routes.isLoading) return <Skeleton className="h-36 w-full rounded-xl" />;
  if (!numbers.length) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Phone className="size-4 text-muted-foreground" />
          Numbers on this account
        </CardTitle>
        <CardDescription>
          Every template below can be sent from any of these. WhatsApp holds
          templates against the account, not against a single number.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {numbers.map((n) => {
          const internal = n.purpose === "internal";
          return (
            <div
              key={n.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                    internal
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : "bg-[#25D366]/15 text-[#128C7E] dark:text-[#25D366]"
                  }`}
                >
                  {internal ? <Users className="size-4" /> : <Bot className="size-4" />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {n.name ?? "WhatsApp sender"}
                  </p>
                  {/*
                    Who it answers, not what it is called. A name is whatever
                    somebody typed; this is the behaviour.
                  */}
                  <p className="text-xs text-muted-foreground">
                    {internal
                      ? "Staff only. Says nothing to a number that is not linked to a person here."
                      : "Customers. Ad clicks and anyone who writes in land on this one."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  {n.phoneNumberIdSuffix}
                </Badge>
                <Badge variant={internal ? "secondary" : "default"} className="text-[10px]">
                  {internal ? "Internal" : "Customer-facing"}
                </Badge>
                {!n.isActive && (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    Switched off
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
