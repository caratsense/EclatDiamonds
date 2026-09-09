/**
 * CaratOS integration contracts — barrel.
 *
 * Contracts ONLY. Nothing here is a Nest provider, controller, or wired into the
 * request path. These are the source-agnostic types the core app will depend on
 * so it never imports Gati/Tally/BUSY-specific code. Implementations (GatiConnector,
 * Excel/CSV connectors, embedding-provider adapters) land in later, approved phases.
 *
 * See docs/CARATOS_ARCHITECTURE.md.
 */

export * from './provenance';
export * from './canonical';
export * from './sync-result';
export * from './import-profile';
export * from './connector';
export * from './embedding-provider';
