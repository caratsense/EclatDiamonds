"use client";

import { Store as StoreIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/store/use-session";

/**
 * Multi-store context is always present. Multi-store roles can switch the
 * active store (or pick the "All Stores" aggregate). Phase 2 gates which
 * stores appear by the user's role + assignments.
 */
export function StoreSwitcher() {
  const { currentStore, stores, setCurrentStoreById } = useSession();

  return (
    <Select value={currentStore.id} onValueChange={setCurrentStoreById}>
      <SelectTrigger className="h-9 w-[200px] gap-2 font-medium">
        <StoreIcon className="h-4 w-4 text-muted-foreground" />
        <SelectValue placeholder="Select store" />
      </SelectTrigger>
      <SelectContent>
        {stores.map((store) => (
          <SelectItem key={store.id} value={store.id}>
            {store.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
