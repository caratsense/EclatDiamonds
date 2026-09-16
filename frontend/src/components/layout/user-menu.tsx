"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Download, LogOut, Settings, Sparkles } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OPEN_TOUR_EVENT } from "@/components/onboarding/welcome-tour";
import { IosInstallDialog } from "@/components/pwa/install-app-button";
import { usePwaInstall } from "@/components/pwa/use-pwa-install";
import { setStoredToken, setStoredStoreId } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useSession } from "@/store/use-session";
import { LogoutDialog } from "@/components/layout/logout-dialog";

export function UserMenu() {
  const { user, clear } = useSession();
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { status: pwaStatus, promptNative } = usePwaInstall();
  const [iosOpen, setIosOpen] = React.useState(false);
  const [logoutOpen, setLogoutOpen] = React.useState(false);

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="User menu"
        >
          <Avatar>
            <AvatarFallback>{user.initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{user.name}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <Settings className="h-4 w-4" /> {t("menu.profile", "Profile & Settings")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.dispatchEvent(new Event(OPEN_TOUR_EVENT))}
        >
          <Sparkles className="h-4 w-4" /> {t("menu.tour", "Show welcome tour")}
        </DropdownMenuItem>
        {/* Install app — only shown when installable (native prompt available)
            or on iOS Safari; hidden once installed / running standalone. */}
        {pwaStatus !== "hidden" ? (
          <DropdownMenuItem
            onSelect={() =>
              pwaStatus === "ios" ? setIosOpen(true) : promptNative()
            }
          >
            <Download className="h-4 w-4" />{" "}
            {t("menu.installApp", "Install app")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setLogoutOpen(true)}>
          <LogOut className="h-4 w-4" /> {t("action.signOut", "Sign out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <IosInstallDialog open={iosOpen} onOpenChange={setIosOpen} />
    <LogoutDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  );
}
