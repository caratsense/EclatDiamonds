"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Delete a customer (client, 9 Oct) — only one with NO history. The server is
 * the authority: a customer with sales, money, visits or conversations is
 * refused with the counts and pointed at Archive, and this button simply
 * surfaces that sentence. Head office only; first tap arms, second deletes.
 */
export function DeleteContactButton({ partyId, name }: { partyId: string; name: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const role = useSession((s) => s.baseRole);
  const [armed, setArmed] = useState(false);
  const del = useMutation({
    mutationFn: async () => (await api.delete<{ deleted: boolean }>(`/parties/${partyId}`)).data,
    onSuccess: () => {
      toast.success(`${name} deleted.`);
      void qc.invalidateQueries({ queryKey: ["customers"] });
      router.push("/customers");
    },
    onError: (e) => {
      setArmed(false);
      toast.error(apiErrorMessage(e, "Could not delete."), { duration: 8000 });
    },
  });

  if (ROLE_RANK[role] < ROLE_RANK.head_office) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:text-destructive"
      disabled={del.isPending}
      title="Only a customer with no history can be deleted; others are archived."
      onClick={() => (armed ? del.mutate() : setArmed(true))}
    >
      <Trash2 className="h-3.5 w-3.5" />
      {del.isPending ? "Deleting…" : armed ? "Tap again to delete" : "Delete"}
    </Button>
  );
}
