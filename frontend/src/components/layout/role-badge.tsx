"use client";

import { ChevronDown, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS, type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";

const ROLES: Role[] = [
  "salesperson",
  "storeperson",
  "store_manager",
  "area_manager",
  "head_office",
];

/**
 * Role badge doubles as a role switcher so we can demo role-based views.
 * Phase 2: role comes from auth and is read-only for most users.
 */
export function RoleBadge() {
  const { role, setRole } = useSession();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge
            variant="outline"
            className="hidden gap-1.5 py-1 font-medium transition-colors hover:bg-accent sm:inline-flex"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            {ROLE_LABELS[role]}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Demo as role</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ROLES.map((r) => (
          <DropdownMenuItem key={r} onSelect={() => setRole(r)}>
            {ROLE_LABELS[r]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
