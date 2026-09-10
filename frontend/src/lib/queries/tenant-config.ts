"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { CORE_NAVIGATION, navigationFromSettings } from "@/lib/navigation";

/**
 * Tenant configuration + integrations (CaratOS Phase A2/A5, surfaced in A11).
 *
 * `useConfigBootstrap` is the call that makes the app industry-neutral: labels,
 * option lists and which built-in fields to show all come from here rather than
 * from constants compiled into the frontend.
 */

export interface TaxonomyTerm {
  id: string;
  kind: string;
  code: string;
  label: string;
  parentId: string | null;
  sortOrder: number;
  systemValue: string | null;
  packCode: string | null;
  isActive?: boolean;
}

export interface AttributeDefinition {
  id: string;
  entity: string;
  key: string;
  label: string;
  dataType: string;
  required: boolean;
  taxonomyKind: string | null;
  options: string[] | null;
  unit: string | null;
  searchable: boolean;
  sortOrder: number;
  packCode: string | null;
}

export interface FieldPolicy {
  id: string;
  entity: string;
  field: string;
  requirement: "hidden" | "optional" | "required";
  label: string | null;
  sortOrder: number;
}

export interface ConfigBootstrap {
  organisation: {
    id: string;
    name: string;
    slug: string;
    status: string;
    country: string;
    currency: string;
    timezone: string;
    /** Only the publishable keys — `branding` and `featureProfile`. */
    settings: Record<string, unknown>;
    configVersion: number;
  };
  industry: {
    packCode: string | null;
    packName: string | null;
    appliedVersion: number | null;
    upgradeAvailable: boolean;
    packMissing: boolean;
    /**
     * Routes this industry's product includes, derived from the applied pack.
     * Null when this release has no definition for the tenant's pack, which
     * means "impose nothing" — the caller falls back to the stored profile.
     */
    enabledNavigation: string[] | null;
    aiContext: string | null;
  };
  /** Neutral label -> this industry's word. Empty when the industry uses the neutral wording. */
  labels: Record<string, string>;
  /** The nouns behind those labels, resolved against the neutral defaults. */
  lexicon: Record<string, string>;
  taxonomies: Record<
    string,
    { label: string; systemBacked: boolean; terms: TaxonomyTerm[] }
  >;
  attributes: Record<string, AttributeDefinition[]>;
  fieldPolicies: Record<string, FieldPolicy[]>;
  configurableEntities: string[];
}

/**
 * The single call a client makes to learn what this tenant is and what it calls
 * things. Cached generously — it changes only when an admin edits configuration,
 * and every such edit bumps `configVersion`.
 */
export function useConfigBootstrap() {
  return useQuery({
    queryKey: ["config", "bootstrap"],
    queryFn: async () => (await api.get<ConfigBootstrap>("/config/bootstrap")).data,
    staleTime: 5 * 60_000,
  });
}

/**
 * Resolve a display label through the tenant's vocabulary, falling back to the
 * raw code. The fallback matters: a value that has no configured term must still
 * render as itself rather than as a blank.
 */
export function useTermLabel(bootstrap: ConfigBootstrap | undefined) {
  return (kind: string, code: string | null | undefined): string => {
    if (!code) return "—";
    const vocab = bootstrap?.taxonomies?.[kind];
    const term =
      vocab?.terms.find((t) => t.code === code) ??
      vocab?.terms.find((t) => t.systemValue === code);
    return term?.label ?? code;
  };
}

/**
 * The routes that belong to this tenant's product, or `undefined` for "no
 * opinion".
 *
 * Prefers the pack-derived list, which is recomputed from the applied industry
 * on every bootstrap, over the copy frozen into `settings.featureProfile` when
 * the tenant signed up. The stored copy is only consulted when this release has
 * no definition for the tenant's pack.
 *
 * `undefined` means the bootstrap request has not produced data yet. Once it
 * has, an unresolved or missing pack falls back to the industry-neutral core.
 * This mirrors the server: universal routes stay open and known vertical
 * modules fail closed.
 */
export function useEnabledNavigation(): string[] | undefined {
  const { data, isLoading } = useConfigBootstrap();
  if (!data) return isLoading ? undefined : [...CORE_NAVIGATION];
  const fromPack = data?.industry?.enabledNavigation;
  if (fromPack?.length) return fromPack;
  return navigationFromSettings(data.organisation.settings) ?? [...CORE_NAVIGATION];
}

/**
 * Is `slug` part of this tenant's product?
 *
 * For chrome that is rendered outside the navigation — a top-bar widget, a
 * tour step — and therefore escapes `visibleNavGroups`. True while the answer
 * is still loading, so nothing flickers away from a tenant that does have it.
 */
export function useRouteEnabled(slug: string): boolean {
  const enabled = useEnabledNavigation();
  return !enabled || enabled.includes(slug);
}

/** Is a built-in field hidden for this tenant? Used to drop industry-specific inputs. */
export function useFieldVisible(bootstrap: ConfigBootstrap | undefined) {
  return (entity: string, field: string): boolean => {
    const policy = bootstrap?.fieldPolicies?.[entity]?.find((p) => p.field === field);
    return policy?.requirement !== "hidden";
  };
}

export interface PackSummary {
  code: string;
  name: string;
  version: number;
  description: string;
}

export function useIndustryPacks() {
  return useQuery({
    queryKey: ["config", "packs"],
    queryFn: async () =>
      (await api.get<{ packs: PackSummary[]; defaultPackCode: string }>("/config/packs")).data,
  });
}

export function useApplyPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (packCode: string) =>
      (
        await api.post<{ packName: string; message: string }>("/config/packs/apply", {
          packCode,
        })
      ).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

export function useCreateTerm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: string; code: string; label: string }) =>
      (await api.post<TaxonomyTerm>("/config/taxonomy", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

export function useUpdateTerm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; label?: string; isActive?: boolean }) => {
      const { id, ...body } = input;
      return (await api.patch<TaxonomyTerm>(`/config/taxonomy/${id}`, body)).data;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

export function useUpsertAttribute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      entity: string;
      key: string;
      label: string;
      dataType: string;
      required?: boolean;
      taxonomyKind?: string;
      unit?: string;
      searchable?: boolean;
    }) => (await api.post<AttributeDefinition>("/config/attributes", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

export function useDeactivateAttribute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/config/attributes/${id}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

export function useUpsertFieldPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      entity: string;
      field: string;
      requirement: string;
      label?: string;
    }) => (await api.post<FieldPolicy>("/config/field-policy", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["config"] }),
  });
}

/* --------------------------------------------------------- Integrations */

export interface ProviderRow {
  code: string;
  name: string;
  category: string;
  description: string;
  available: boolean;
  blockedReason: string | null;
  credentialScope: "tenant" | "platform_env" | "none" | "on_premise";
  credentialKinds: string[];
  entities: string[];
  webhooks: boolean;
}

export interface IntegrationRow {
  id: string;
  providerCode: string;
  providerName: string;
  credentialScope: string;
  name: string;
  status: string;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /**
   * Derived state, distinct from `status`. `status` records what the last health
   * check wrote; `state` answers "what can this tenant do right now", which also
   * depends on whether a credential exists, whether it has expired, and whether
   * the provider is blocked at the platform level.
   */
  state: "not_configured" | "configuring" | "connected" | "degraded" | "disconnected" | "blocked";
  /** Always a sentence — the UI never has to invent an explanation. */
  stateReason: string;
  /** Non-secret connection settings (account ids, options). Never a credential. */
  config: Record<string, unknown> | null;
  createdAt: string;
  /** Kind + freshness only. A secret is never returned by the API. */
  credentials: {
    kind: string;
    present: boolean;
    expiresAt: string | null;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  }[];
  assets: {
    id: string;
    kind: string;
    externalId: string;
    name: string | null;
    isActive?: boolean;
  }[];
}

export interface ProviderCatalogue {
  providers: ProviderRow[];
  encryption: { configured: boolean; note: string };
  platformScopedWarning: { providers: string[]; message: string } | null;
  organisationId: string;
}

export function useProviderCatalogue() {
  return useQuery({
    queryKey: ["integrations-registry", "providers"],
    queryFn: async () =>
      (await api.get<ProviderCatalogue>("/integrations-registry/providers")).data,
  });
}

export function useIntegrations() {
  return useQuery({
    queryKey: ["integrations-registry", "list"],
    queryFn: async () => (await api.get<IntegrationRow[]>("/integrations-registry")).data,
  });
}

export function useCreateIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerCode: string; name: string }) =>
      (await api.post<IntegrationRow>("/integrations-registry", input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["integrations-registry"] }),
  });
}

export function useSetCredential(integrationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: string; secret: string }) =>
      (await api.post(`/integrations-registry/${integrationId}/credentials`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["integrations-registry"] }),
  });
}

export function useSetIntegrationAsset(integrationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      kind: "phone_number";
      externalId: string;
      name?: string;
    }) =>
      (await api.post(`/integrations-registry/${integrationId}/assets`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["integrations-registry"] }),
  });
}

/**
 * Issue this tenant's telephony webhook token. Head office only.
 *
 * The plaintext comes back ONCE and is never stored in the query cache: the
 * caller holds it in component state for as long as the panel is open and it is
 * gone on the next render of the page. Only its hash exists server-side.
 */
export function useRotateTelephonyToken() {
  return useMutation({
    mutationFn: async () =>
      (
        await api.post<{
          token: string;
          tokenPrefix: string;
          integrationId: string;
          path: string;
          header: string;
          warning: string;
        }>("/integrations/telephony/webhook-token")
      ).data,
  });
}

export function useRemoveIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/integrations-registry/${id}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["integrations-registry"] }),
  });
}

/* ---------------------------------------------------------------- Jobs */

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  createdAt: string;
}

export function useJobs(status?: string) {
  return useQuery({
    queryKey: ["jobs", status],
    queryFn: async () => (await api.get<JobRow[]>("/jobs", { params: { status } })).data,
    refetchInterval: 30_000,
  });
}

export function useJobSummary() {
  return useQuery({
    queryKey: ["jobs", "summary"],
    queryFn: async () =>
      (
        await api.get<{
          counts: Record<string, number>;
          needsAttention: number;
          registeredKinds: string[];
        }>("/jobs/summary")
      ).data,
    refetchInterval: 30_000,
  });
}

/* ------------------------------------------------- Connector runtime (A7) */

export interface ConnectorRuntimeRow {
  sourceSystem: string;
  name: string;
  description: string;
  status: string;
  /**
   * How data actually gets in. The UI must read this before offering a "Sync
   * now" action: a push-based source (the on-site agent) cannot be triggered
   * from the server, so a button for it could only ever fail.
   */
  intakeMode: "pull" | "push" | "file_upload";
  entities: string[];
  runnable: boolean;
  notRunnableReason?: string;
  fileImportFallback?: {
    /** Mirrors the backend union exactly — gati and odbc were missing. */
    sourceSystem: "tally" | "busy" | "gati" | "odbc";
    acceptedFormats: string[];
    note: string;
  };
}

export function useConnectorRuntime() {
  return useQuery({
    queryKey: ["connectors", "runtime"],
    queryFn: async () =>
      (await api.get<ConnectorRuntimeRow[]>("/integration/connectors/runtime")).data,
  });
}

export interface OriginReconciliation {
  /** Per model: how many rows came from the customer vs were created here. */
  byOrigin: Record<string, { fromCustomer: number; local: number }>;
  imports: {
    batches: number;
    discovered: number;
    imported: number;
    updated: number;
    failed: number;
    duplicate: number;
  };
  /** Provenance work still outstanding. Surfaced rather than hidden. */
  remainingMigration: string;
}

/** Where did this organisation's data come from? The go-live question. */
export function useOriginReconciliation() {
  return useQuery({
    queryKey: ["connectors", "reconcile"],
    queryFn: async () =>
      (await api.get<OriginReconciliation>("/integration/connectors/reconcile")).data,
  });
}

export interface RecordProvenance {
  hasProvenance: boolean;
  sourceSystem: string | null;
  externalId: string | null;
  importBatchId: string | null;
  /** Always a sentence — "Entered in CaratOS" is a real answer, not a blank. */
  description: string;
  batch?: { id: string; fileName: string | null; createdAt: string } | null;
}

/** Origin of one record, for a detail panel or a support question. */
export function useRecordProvenance(model: "party" | "product" | "store", id: string | null) {
  return useQuery({
    queryKey: ["connectors", "provenance", model, id],
    enabled: !!id,
    queryFn: async () =>
      (await api.get<RecordProvenance>(`/integration/connectors/provenance/${model}/${id}`)).data,
  });
}
