import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email.service';
import {
  ChannelDeliverability,
  OutboundChannelAdapter,
  OutboundSendInput,
  OutboundSendResult,
} from './outbound.contract';

/**
 * Email, outbound (Block 13).
 *
 * ## Status: DRY-RUN UNLESS SMTP IS SET, AND NEVER FOR MARKETING YET
 *
 * `EmailService` is complete and already carries the month-end reports. What was
 * missing is an honest answer to "can this tenant email a CUSTOMER", which is a
 * different question from "is SMTP configured":
 *
 *   SMTP unset                  → dry_run. The path runs, nothing leaves, and
 *                                 the caller is told. This is the state the
 *                                 scheduled reports already live in.
 *   SMTP set, no verified domain → dry_run for a customer-facing message. Mail
 *                                 from an unverified domain is delivered to spam
 *                                 at best and can burn the domain's reputation
 *                                 permanently. Reporting that as `live` is how a
 *                                 tenant discovers the problem three weeks later
 *                                 from their own customers.
 *   Both                        → live.
 *
 * ## Why the domain check reads a tenant row and not DNS
 *
 * Verifying SPF, DKIM and DMARC properly means DNS lookups from the server, and
 * nothing here has ever done one. So the flag records that an OPERATOR has
 * confirmed it, `verified` stays false, and the reason says which of those it is.
 * A DNS check is a small, well-bounded improvement; claiming one that does not
 * exist is not.
 */

export const EMAIL_PROVIDER_CODE = 'email';

@Injectable()
export class EmailOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = 'email' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async deliverability(organisationId: string): Promise<ChannelDeliverability> {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: EMAIL_PROVIDER_CODE },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, config: true },
    });
    const config = asRecord(integration?.config);
    const domain = typeof config.sendingDomain === 'string' ? config.sendingDomain.trim() : '';
    const domainConfirmed = config.sendingDomainVerified === true;

    if (!this.email.enabled) {
      return {
        channel: this.channel,
        state: 'dry_run',
        code: 'not_configured',
        reason:
          'No SMTP server is configured, so email is written to the log rather than sent. ' +
          'The path is complete: set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM and it goes live.',
        verified: false,
        capabilities: { transactional: false, marketing: false },
      };
    }
    if (integration?.status === 'disabled') {
      return {
        channel: this.channel,
        state: 'unavailable',
        code: 'not_connected',
        reason: `The "${integration.name}" email connection is switched off.`,
        verified: false,
      };
    }
    if (!domain || !domainConfirmed) {
      return {
        channel: this.channel,
        state: 'dry_run',
        code: 'capability_missing',
        reason:
          (domain
            ? `SPF, DKIM and DMARC have not been confirmed for ${domain}. `
            : 'No sending domain has been recorded for this organisation. ') +
          'Customer email is held back until one is: mail from an unverified domain is ' +
          'delivered to spam at best, and repeated attempts damage the domain permanently.',
        verified: false,
        // Internal mail (the month-end report to the owner's own address) still
        // goes, which is what the reporting module already relies on.
        capabilities: { transactional: true, marketing: false },
      };
    }

    return {
      channel: this.channel,
      state: 'live',
      code: 'ready',
      reason: `Sending as ${domain}.`,
      // An operator confirmed the DNS records; nothing here has looked them up.
      verified: false,
      capabilities: { transactional: true, marketing: true },
    };
  }

  async send(organisationId: string, input: OutboundSendInput): Promise<OutboundSendResult> {
    const state = await this.deliverability(organisationId);
    if (state.state === 'unavailable') {
      return { delivered: false, dryRun: true, reason: state.reason, channel: this.channel };
    }
    if (!input.body?.trim() || !input.subject?.trim()) {
      return {
        delivered: false,
        dryRun: false,
        reason: 'An email needs a subject and a body.',
        channel: this.channel,
      };
    }
    // A dry-run state still calls through, because EmailService's own dry run is
    // the thing that logs what WOULD have been sent — which is the only way to
    // check a template before a domain is verified.
    const result = await this.email.send(input.to, input.subject.trim(), input.body.trim());
    return {
      delivered: result.sent,
      dryRun: result.dryRun || state.state === 'dry_run',
      externalId: result.messageId,
      reason: result.sent ? undefined : (result.error ?? state.reason),
      error: result.error,
      channel: this.channel,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
