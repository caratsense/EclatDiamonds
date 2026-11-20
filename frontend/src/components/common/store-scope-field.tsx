"use client";

import { useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/store/use-session";

/**
 * Store attribution for entry forms.
 *
 * On a concrete store, records belong to `currentStore`. On the synthetic
 * "All Stores" aggregate (broad roles only) there is no single store to write
 * to — so the form must render <StoreScopeField> and the user must pick one.
 * Until they do, `targetStoreId` is "" — guard submit with
 * `if (!targetStoreId) { … return; }` so nothing is silently misattributed.
 *
 * Replaces the old `currentStore.isAggregate ? "surat-main" : currentStore.id`
 * pattern, which wrote every aggregate-scope record to a hardcoded store.
 */
export function useStoreScope(initialStoreId?: string) {
  const { stores, currentStore } = useSession();
  // `initialStoreId` pre-seeds the aggregate picker (e.g. Bulk Transfer prefill).
  const [pickedStoreId, setPickedStoreId] = useState(initialStoreId ?? "");
  const isAggregate = currentStore.isAggregate;
  const targetStoreId = isAggregate ? pickedStoreId : currentStore.id;
  const picked = stores.find((s) => s.id === targetStoreId);
  const storeLabel = isAggregate
    ? (picked?.name ?? "the selected store")
    : currentStore.name;
  return {
    isAggregate,
    targetStoreId,
    pickedStoreId,
    setPickedStoreId,
    storeLabel,
  };
}

/**
 * The store picker — renders only on the aggregate; nothing on a concrete
 * store (the current store is used). Wire it to the hook's state:
 *   const scope = useStoreScope();
 *   <StoreScopeField value={scope.pickedStoreId} onChange={scope.setPickedStoreId} />
 */
export function StoreScopeField({
  value,
  onChange,
  label = "Store",
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const { stores, currentStore } = useSession();
  if (!currentStore.isAggregate) return null;
  const realStores = stores.filter((s) => !s.isAggregate);
  return (
    <div className="grid gap-1.5">
      <Label>
        {label} <span className="text-destructive">*</span>
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-invalid={!value}>
          <SelectValue placeholder="Select a store…" />
        </SelectTrigger>
        <SelectContent>
          {realStores.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
