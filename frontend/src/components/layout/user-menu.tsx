"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  Languages,
  LogOut,
  Settings,
  Sparkles,
} from "lucide-react";

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
import { cn } from "@/lib/utils";
import { useLang, useT } from "@/lib/i18n";
import { useSession } from "@/store/use-session";

export function UserMenu() {
  const { user, clear } = useSession();
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { status: pwaStatus, promptNative } = usePwaInstall();
  const [iosOpen, setIosOpen] = React.useState(false);

  function signOut() {
    setStoredToken(null);
    setStoredStoreId(null);
    clear();
    queryClient.clear();
    router.replace("/login");
  }

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
        {/* Language toggle. Selecting keeps the menu open (preventDefault) so
            the moved check is visible immediately. English is the default. */}
        <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
          <Languages className="h-3.5 w-3.5" />
          {t("action.language", "Language / भाषा")}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setLang("en");
          }}
        >
          <Check
            className={cn("h-4 w-4", lang === "en" ? "opacity-100" : "opacity-0")}
          />
          English
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setLang("hi");
          }}
        >
          <Check
            className={cn("h-4 w-4", lang === "hi" ? "opacity-100" : "opacity-0")}
          />
          हिंदी
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOut className="h-4 w-4" /> {t("action.signOut", "Sign out")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <IosInstallDialog open={iosOpen} onOpenChange={setIosOpen} />
    </>
  );
}
