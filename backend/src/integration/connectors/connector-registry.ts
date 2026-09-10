import { Injectable } from '@nestjs/common';
import type {
  ConnectorCapabilities,
  ConnectorStatus,
} from '../contracts/connector';
import { UNCONFIGURED_CAPABILITIES } from '../contracts/connector';
import type { SourceSystem } from '../contracts/provenance';

/**
 * CaratOS connector registry (Phase 4 boundary).
 *
 * The single place the app asks "what can this organisation connect, and which
 * entities does each source move?". Connectors plug in against the same
 * IntegrationConnector contract (src/integration/contracts). Today:
 *   - excel-csv : IMPLEMENTED for import (Customers to start; entity-agnostic pipeline).
 *   - gati      : ADAPTER over the existing on-site sync — capabilities only; the
 *                 real extraction stays in src/sync (not rewritten). Marked
 *                 source-of-truth-protected.
 *   - tally     : profile-driven Connect agent starter (customer/product masters).
 *   - busy      : verified Master1 customer + product-master starter profiles.
 *   - odbc      : generic discovery/profile runner for other read-only databases.
 *
 * A descriptor is metadata + capability advertisement; the actual pipeline lives
 * in the import service / the existing sync. This registry never fabricates a
 * mapping and never assumes a store.
 */

export interface ConnectorDescriptor {
  sourceSystem: SourceSystem;
  /** Human name for the UI. */
  name: string;
  /** One-line description of what connecting this source does. */
  description: string;
  status: ConnectorStatus;
  capabilities: ConnectorCapabilities;
  /** Entities this connector can move today (empty for placeholders). */
  entities: string[];
  /** True when this is a file-upload connector (Excel/CSV) vs a live source. */
  fileUpload: boolean;
}

const CAP = (over: Partial<ConnectorCapabilities>): ConnectorCapabilities => ({
  ...UNCONFIGURED_CAPABILITIES,
  ...over,
});

@Injectable()
export class ConnectorRegistry {
  private readonly connectors: ConnectorDescriptor[] = [
    {
      sourceSystem: 'csv',
      name: 'Excel / CSV upload',
      description:
        'Upload a spreadsheet exported from any system (or a CaratOS template). Map columns, preview, then import. CSV and XLSX both supported.',
      status: 'connected',
      capabilities: CAP({ supportsCustomers: true, supportsProducts: true }),
      // Import entities (customers/stores/products) — the file-upload modality; more
      // entities plug into the same pipeline via a field-dictionary + importer.
      entities: ['customers', 'stores', 'products'],
      fileUpload: true,
    },
    {
      sourceSystem: 'gati',
      name: 'Gati (APRS-SJEP)',
      description:
        'The on-site sync agent pushes legacy jewellery-ERP data. Adapter over the existing sync — store attribution, watermarks and source-of-truth protection preserved.',
      status: 'connected',
      capabilities: CAP({
        supportsCustomers: true,
        supportsProducts: true,
        supportsStock: true,
        supportsSales: true,
        supportsStaff: true,
        supportsManufacturing: true,
        supportsImages: true,
        supportsOrders: true,
        supportsIncremental: true,
      }),
      entities: ['customers', 'products', 'stock', 'sales', 'ledger', 'staff', 'manufacturing', 'images', 'orders'],
      fileUpload: false,
    },
    {
      sourceSystem: 'tally',
      name: 'Tally',
      description:
        'Outbound TallyPrime XML Connect agent. Customer and stock-item masters use an explicit starter profile; each company is previewed before sync.',
      status: 'connected',
      capabilities: CAP({ supportsCustomers: true, supportsProducts: true }),
      entities: ['customers', 'products'],
      fileUpload: false,
    },
    {
      sourceSystem: 'busy',
      name: 'BUSY',
      description:
        'Outbound Windows Connect agent for BUSY .bds data. Customer and product masters have starter profiles; transactions remain disabled until each installation is mapped.',
      status: 'connected',
      capabilities: CAP({ supportsCustomers: true, supportsProducts: true }),
      entities: ['customers', 'products'],
      fileUpload: false,
    },
    {
      sourceSystem: 'odbc',
      name: 'Generic database (ODBC)',
      description:
        'Read-only outbound connector for SQL Server, Access, MySQL, PostgreSQL and other ODBC sources. Requires a reviewed per-client profile before sync.',
      status: 'connected',
      capabilities: CAP({ supportsCustomers: true, supportsProducts: true }),
      entities: ['customers', 'products', 'stores'],
      fileUpload: false,
    },
  ];

  /** All connectors and their current status (for the Integrations screen). */
  list(): ConnectorDescriptor[] {
    return this.connectors;
  }

  get(sourceSystem: SourceSystem): ConnectorDescriptor | undefined {
    return this.connectors.find((c) => c.sourceSystem === sourceSystem);
  }
}
