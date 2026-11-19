"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

import { ExcelExportButton } from "@/components/common/excel-export-button";
import { NpsResponses, NpsUpdates } from "@/components/feedback/nps-panel";
import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getNavItem } from "@/lib/navigation";

type Screen = "updates" | "responses";

/**
 * NPS on its own URL.
 *
 * The sidebar no longer offers this screen — NPS is a tab inside Feedback
 * Requests now, which is what the client asked for. The route stays because
 * taking a URL away breaks every bookmark and every link already sent, and
 * because the access matrix can still grant this screen on its own.
 */
export default function NpsPage() {
  const nav = getNavItem("nps");
  const [screen, setScreen] = useState<Screen>("updates");

  return (
    <div className="space-y-4">
      <SectionHeader
        title={nav?.title ?? "NPS"}
        purpose={nav?.purpose ?? ""}
        actions={
          <div className="flex items-center gap-2">
            {/*
              The client asked for a hamburger inside NPS holding the two
              screens. It is a menu rather than tabs on purpose: more screens
              are coming (reconciliation, settings) and a menu grows without
              re-laying out the header.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                  <Menu className="h-3.5 w-3.5" />
                  {screen === "updates" ? "NPS Updates" : "NPS Responses"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>NPS</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setScreen("updates")}>
                  NPS Updates
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setScreen("responses")}>
                  NPS Responses
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ExcelExportButton path="/crm/nps/export" fallbackName="nps.xlsx" />
          </div>
        }
      />
      {screen === "updates" ? <NpsUpdates /> : <NpsResponses />}
    </div>
  );
}
