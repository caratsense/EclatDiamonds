"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { ROLE_RANK, type Role } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Module 3 — Audit Log. A record of approvals, role changes and other
 * sensitive actions across the business. Restricted to store_manager+ (the
 * backend enforces this too); the query is disabled for lower roles so it never
 * fires. Store-scoped + role-aware server-side: a store manager sees only their
 * own store; head office sees all and can narrow with `storeId`.
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
  /** Human store name; may be null for global/unscoped entries. */
  storeName?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditParams {
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  /** Head office only — narrow to one store. Store managers are locked server-side. */
  storeId?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditResponse {
  items: AuditEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Shared fetch — drops empty filter values so the querystring stays clean. */
async function fetchAudit(params: AuditParams): Promise<AuditResponse> {
  const query = Object.fromEntries(
    Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== "" && v !== null,
    ),
  );
  const { data } = await api.get<AuditResponse>("/audit", { params: query });
  return data;
}

export function useAuditLog(params: AuditParams) {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  return useQuery({
    queryKey: ["audit", params],
    enabled: canView,
    placeholderData: keepPreviousData,
    queryFn: () => fetchAudit(params),
  });
}

/** Cap on rows pulled for an export — one request, no paging loop. */
export const AUDIT_EXPORT_CAP = 5000;

/**
 * Fetch all rows matching the current filters (up to the cap) for an Excel
 * export — not just the visible page. Ignores paging params from the caller.
 */
export function exportAudit(params: AuditParams): Promise<AuditResponse> {
  return fetchAudit({ ...params, page: 1, pageSize: AUDIT_EXPORT_CAP });
}
