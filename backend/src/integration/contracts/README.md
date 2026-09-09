# CaratOS integration contracts

These contracts are now consumed by the import/connector runtime. Vendor-specific
extraction remains outside the core application in `connectors/`.

These files define the source-agnostic seam that lets Eclat evolve into CaratOS
without the core app depending on Gati/Tally/BUSY structures. The contracts are
shared by the live import runtime and source agents, while persistence remains
inside the existing NestJS services.

| File | Contract |
|---|---|
| `provenance.ts` | `SourceSystem`, `SourceRef`, `FieldOwnership`, `SourceOwnershipPolicy`, `Provenance` envelope |
| `canonical.ts` | `Organisation`, `Store`, `CanonicalProduct/StockItem/Customer/Staff/Sale/Payment/Order/Manufacturing/Media` |
| `sync-result.ts` | `EntityKind`, `DiscoveryReport`, `ReconciliationReport`, `SyncCounts`, `RecordIssue`, `SyncOptions` |
| `import-profile.ts` | `ImportSource`, `FieldMapping`, `ImportProfile`, `MappingSuggestion`, `ImportPreview` |
| `connector.ts` | `IntegrationConnector` (discover→…→sync), `ConnectorCapabilities`, `ConnectorHealth` |
| `embedding-provider.ts` | `ImageEmbeddingProvider` — vendor-neutral visual search |

## Rules these encode
- **Never invent source mappings.** BUSY and Tally starters expose only universal
  customer/product masters through reviewed profiles. Other entities stay blocked
  until a real client schema is previewed and reconciled.
- **Never default store attribution.** An unattributable record is held UNASSIGNED
  for reconciliation — never assigned to a first/alphabetical/Surat/default store.
- **Never overwrite `CARATOS_OWNED` fields** during sync (generalises the existing
  Module-9 stock-transfer protection).
- **Never fake AI.** An unavailable embedding provider reports `unavailable`/`degraded`;
  the catalogue keeps working.
- **Purity is never invented** — `unspecified` is a first-class canonical value.

See `docs/CARATOS_ARCHITECTURE.md` for the full plan and the deferred, approval-gated
Organisation/tenant migration.
