"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { ROLE_RANK, type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Module 3 — Audit Log. A record of approvals, role changes and other
 * sensitive actions across the business. Restricted to area_manager+ (the
 * backend enforces this too); the query is disabled for lower roles so it never
 * fires. Store-scoped + role-aware server-side via the X-Store-Id header.
 */

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorName: string;
  actorRole: Role;
  /** Dotted action code, e.g. "discount.approve". */
  action: string;
  entityType: string;
  entityId: string;
  storeId: string;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditParams {
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditResponse {
  items: AuditEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export function useAuditLog(params: AuditParams) {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.area_manager;
  return useQuery({
    queryKey: ["audit", params],
    enabled: canView,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<AuditResponse> => {
      // Drop empty filter values so the querystring stays clean.
      const query = Object.fromEntries(
        Object.entries(params).filter(
          ([, v]) => v !== undefined && v !== "" && v !== null,
        ),
      );
      const { data } = await api.get<AuditResponse>("/audit", { params: query });
      return data;
    },
  });
}
