import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Shared persist-before-process webhook boundary.
 *
 * A provider delivery is durably stored before business logic runs. A unique
 * `(providerCode, externalId)` receipt prevents concurrent duplicate work,
 * while a failed or abandoned attempt can be reclaimed on a later delivery.
 */
export type WebhookOutcome = {
  handled: boolean;
  reason?: string;
  organisationId?: string | null;
  integrationId?: string | null;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

@Injectable()
export class WebhookIntakeService {
  private readonly log = new Logger(WebhookIntakeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async intake(
    input: {
      providerCode: string;
      externalId: string | null;
      signatureVerified: boolean;
      payload: unknown;
      /** Only non-sensitive headers. Authorization/signature headers never enter. */
      headers?: Record<string, string>;
      maxAttempts?: number;
    },
    process: () => Promise<WebhookOutcome>,
  ): Promise<WebhookOutcome & { duplicate?: boolean }> {
    const maxAttempts = Math.min(Math.max(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1), 10);
    let eventId: string;
    let existing = false;

    try {
      const row = await this.prisma.webhookEvent.create({
        data: {
          providerCode: input.providerCode,
          externalId: input.externalId,
          signatureVerified: input.signatureVerified,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          headers: (input.headers ?? {}) as Prisma.InputJsonValue,
          status: 'received',
        },
        select: { id: true },
      });
      eventId = row.id;
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002' ||
        !input.externalId
      ) {
        throw error;
      }
      const prior = await this.prisma.webhookEvent.findUnique({
        where: {
          providerCode_externalId: {
            providerCode: input.providerCode,
            externalId: input.externalId,
          },
        },
        select: { id: true, status: true, attempts: true, processedAt: true },
      });
      if (!prior) throw error;
      if (prior.status === 'processed' || prior.status === 'ignored') {
        this.log.debug(`${input.providerCode} webhook redelivered after completion.`);
        return { handled: true, duplicate: true, reason: 'already processed' };
      }
      if (prior.attempts >= maxAttempts) {
        return { handled: false, duplicate: true, reason: 'processing attempts exhausted' };
      }
      if (
        prior.status === 'processing' &&
        prior.processedAt &&
        prior.processedAt.getTime() > Date.now() - PROCESSING_LEASE_MS
      ) {
        return { handled: true, duplicate: true, reason: 'processing already in progress' };
      }
      eventId = prior.id;
      existing = true;
    }

    // Callers normally reject invalid signatures before intake. This remains a
    // defence-in-depth path for any future controller that forgets to.
    if (!input.signatureVerified) {
      await this.finish(eventId, 'ignored', 'signature not verified', null, null);
      return { handled: false, reason: 'signature not verified' };
    }

    // `processedAt` doubles as the attempt lease while status=processing; the
    // model has no updatedAt/lockedAt field. Terminal rows still carry its
    // documented meaning: when processing finished.
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        id: eventId,
        attempts: { lt: maxAttempts },
        OR: [
          { status: 'received' },
          { status: 'failed' },
          {
            status: 'processing',
            processedAt: { lte: new Date(Date.now() - PROCESSING_LEASE_MS) },
          },
        ],
      },
      data: {
        status: 'processing',
        error: null,
        processedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claim.count === 0) {
      return {
        handled: true,
        duplicate: existing || undefined,
        reason: 'processing already claimed',
      };
    }

    try {
      const outcome = await process();
      await this.finish(
        eventId,
        outcome.handled ? 'processed' : 'ignored',
        outcome.reason ?? null,
        outcome.organisationId ?? null,
        outcome.integrationId ?? null,
      );
      return outcome;
    } catch (error) {
      await this.finish(eventId, 'failed', redactedFailure(error), null, null);
      // A 5xx asks the provider to retry. The durable failed row means its next
      // delivery resumes this same receipt instead of creating a second one.
      throw error;
    }
  }

  private async finish(
    id: string,
    status: string,
    error: string | null,
    organisationId: string | null,
    integrationId: string | null,
  ): Promise<void> {
    // Finalisation is part of the contract. If it fails, propagate so the
    // provider retries rather than acknowledging an event whose state was lost.
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status,
        error: error?.slice(0, 1000) ?? null,
        organisationId,
        integrationId,
        processedAt: new Date(),
      },
    });
  }
}

/** Bounded and credential-safe before text can reach a row or an operator log. */
export function redactedFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return (
    value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/(?:bearer\s+|access_token\s*[=:]\s*|token\s*[=:]\s*)\S+/gi, '[redacted]')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Za-z0-9_-]{80,}/g, '[opaque]')
      .trim()
      .slice(0, 500) || 'Webhook processing failed.'
  );
}
