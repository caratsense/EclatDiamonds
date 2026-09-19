"use client";

import { ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ROLE_LABELS } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Who is signed in: their name and the role they hold. The role is the one
 * they actually have (`baseRole`), not the level a page happens to serve them
 * at. (This used to be a "demo as role" switcher; roles come from the server.)
 */
export function RoleBadge() {
  const name = useSession((s) => s.user.name);
  const role = useSession((s) => s.baseRole);
  return (
    <Badge variant="outline" className="hidden max-w-[16rem] gap-1.5 py-1 font-medium sm:inline-flex">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground">· {ROLE_LABELS[role]}</span>
    </Badge>
  );
}
