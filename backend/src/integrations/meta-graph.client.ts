import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IntegrationsRegistryService } from '../integration/framework/integrations-registry.service';
import { PrismaService } from '../prisma/prisma.service';
import { META_ADS_PROVIDER_CODE } from './meta-asset-ownership.service';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const ID_OR_EDGE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }
}

/** Graph client that keeps the tenant token in an Authorization header. */
@Injectable()
export class MetaGraphClient {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationsRegistryService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `providerCode` decides which of the tenant's integrations may be read
   * through, and therefore whose token is used. It defaults to Meta Ads, which
   * was the only caller when this was written; WhatsApp template sync reads the
   * same Graph host with the messaging integration's own token. It is a
   * parameter rather than a widened filter so a caller cannot reach a provider
   * it did not name.
   */
  async getForIntegration<T>(
    organisationId: string,
    integrationId: string,
    path: string,
    query: Record<string, string>,
    providerCode: string = META_ADS_PROVIDER_CODE,
  ): Promise<T> {
    if (!ID_OR_EDGE.test(path) || path.includes('..') || path.includes('://')) {
      throw new MetaGraphError('Meta Graph path is invalid.');
    }
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organisationId,
        providerCode,
        status: { not: 'disabled' },
      },
      select: { id: true },
    });
    if (!integration) throw new MetaGraphError('That Meta integration is unavailable for this tenant.');

    const token = await this.registry.credentialFor(organisationId, integrationId, 'access_token');
    if (!token) throw new MetaGraphError('The Meta access token is not configured for this connection.');

    const version = this.config.get<string>('META_GRAPH_API_VERSION')?.trim() ?? '';
    if (!/^v\d{1,3}\.\d{1,2}$/.test(version)) {
      throw new MetaGraphError('META_GRAPH_API_VERSION is not configured with an explicit version.');
    }

    const url = new URL(`/${version}/${path.replace(/^\/+/, '')}`, GRAPH_ORIGIN);
    for (const [key, value] of Object.entries(query)) {
      if (!/^[a-z_]{1,40}$/.test(key) || value.length > 2_000) {
        throw new MetaGraphError('Meta Graph query is invalid.');
      }
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      const raw = (await response.text()).slice(0, 64_000);
      const parsed = parseJson(raw);
      if (!response.ok) {
        const providerError = object(parsed)?.error;
        const provider = object(providerError);
        throw new MetaGraphError(
          boundedProviderMessage(provider?.message, response.status),
          response.status,
          scalar(provider?.code),
        );
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new MetaGraphError('Meta Graph returned an unreadable response.', response.status);
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof MetaGraphError) throw error;
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'failed';
      throw new MetaGraphError(`Meta Graph request ${reason}.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function boundedProviderMessage(value: unknown, status: number): string {
  const generic = `Meta Graph request failed with HTTP ${status}.`;
  if (typeof value !== 'string') return generic;
  // Meta errors occasionally echo query values. Never retain long opaque runs,
  // URL query strings, bearer material or control characters in JobTask errors.
  const safe = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:bearer\s+|access_token\s*[=:]\s*)\S+/gi, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[opaque]')
    .trim()
    .slice(0, 300);
  return safe ? `Meta Graph HTTP ${status}: ${safe}` : generic;
}

