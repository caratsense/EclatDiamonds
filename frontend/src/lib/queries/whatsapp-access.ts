import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Role } from "@/lib/types";

/**
 * Who can file a daily report over WhatsApp.
 *
 * The bot answers a handset only when that number is bound to a CaratSense
 * user, and binding happens by the person sending a one-time code from the
 * phone they want to use. Everything here serves the screen where somebody
 * decides who gets one.
 */
export interface DsrRosterRow {
  userId: string;
  name: string;
  email: string;
  role: Role;
  stores: { id: string; name: string }[];
  /**
   * Null when this person has no handset bound — which is the row the
   * onboarding screen exists for, and the reason this endpoint lists people
   * rather than identities.
   */
  identity: {
    id: string;
    /** Last four digits. Enough to recognise their phone, useless to a passer-by. */
    phoneSuffix: string;
    verifiedAt: string | null;
    lastSeenAt: string | null;
  } | null;
}

export interface IssuedLinkCode {
  code: string;
  /** The number they must send it to. Null until a bot number is configured. */
  botNumber: string | null;
  expiresAt: string;
  expiresInMinutes: number;
}

/** GET /whatsapp/roster — the whole team in scope, linked or not. */
export function useDsrRoster() {
  return useQuery({
    queryKey: ["whatsapp", "roster"],
    queryFn: async () => (await api.get<DsrRosterRow[]>("/whatsapp/roster")).data,
  });
}

/**
 * POST /whatsapp/link/start/:userId — issue a code FOR somebody.
 *
 * Deliberately not invalidating the roster on success: nothing has changed
 * yet. The binding exists only once that person sends the code from their
 * handset, and refreshing the list here would suggest otherwise.
 */
export function useIssueLinkCode() {
  return useMutation({
    mutationFn: async (userId: string) =>
      (await api.post<IssuedLinkCode>(`/whatsapp/link/start/${userId}`)).data,
  });
}

/** POST /whatsapp/identities/:id/revoke — take a handset's access away. */
export function useRevokeIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (identityId: string) =>
      (await api.post(`/whatsapp/identities/${identityId}/revoke`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatsapp", "roster"] }),
  });
}
