import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { businessDate, resolveTz } from '../common/tz.util';
import { IdentityService } from '../crm/identity.service';
import { LeadIntakeService } from '../crm/lead-intake.service';

/**
 * Inbound telephony / IVR.
 *
 * A missed call is the cheapest lead a shop ever gets and the one most reliably
 * lost: it exists for as long as somebody remembers it. This turns a verified
 * provider notification into the four records that make it survivable — the
 * customer, the enquiry, the call itself, and a follow-up task somebody is
 * asked to action.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────
 *
 * It does not make the telephony integration "available". The provider registry
 * still reports `available: false`, because availability means a tenant has an
 * account with a provider and this is only the door that account would knock
 * on. Nothing here dials, and nothing here has been exercised against a real
 * provider — the shape is provider-neutral on purpose, and the first real
 * connector will have to map its own payload onto this one.
 *
 * It does not guess a branch. A call to a number the tenant has not mapped is
 * logged with no store and no lead, and reported as unrouted. Filing an enquiry
 * against an arbitrary branch would put a customer in a queue nobody at that
 * branch recognises, and would corrupt every per-branch figure in the product.
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 *
 * The endpoint is @Public — a provider has no session — so the TOKEN is the
 * authentication and the tenant resolution at once. Only its SHA-256 is stored;
 * the plaintext is shown once at rotation and is unrecoverable afterwards, so a
 * database read cannot be replayed against the webhook. This is the same shape
 * the on-premise Connect agent uses, for the same reason.
 */

/** The provider registry code this service authenticates against. */
const PROVIDER_CODE = 'telephony';

export interface TelephonyAuth {
  organisationId: string;
  integrationId: string;
  config: Record<string, unknown>;
}

export interface TelephonyCallInput {
  fromNumber: string;
  toNumber: string;
  /** The provider's own id for this call. Required: it is what makes a replay a no-op. */
  callId: string;
  direction?: 'inbound' | 'outbound';
  durationSec?: number;
  disposition?: string;
  recordingUrl?: string;
  startedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  callerName?: string;
}

export interface TelephonyResult {
  handled: true;
  duplicate: boolean;
  callLogId: string;
  storeId: string | null;
  partyId: string | null;
  leadId: string | null;
  leadRef: string | null;
  taskId: string | null;
  /** Set when no branch owns the dialled number, so nothing downstream ran. */
  unroutedReason: string | null;
}

@Injectable()
export class TelephonyService {
  private readonly log = new Logger(TelephonyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly leadIntake: LeadIntakeService,
  ) {}

  /* ------------------------------------------------------------ the token */

  /**
   * Issue (or replace) this tenant's webhook token. Head office only.
   *
   * The plaintext is returned exactly once. Rotating invalidates the previous
   * token immediately, which is the point of rotating.
   */
  async rotateWebhookToken(user: AuthUser) {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId: user.organisationId, providerCode: PROVIDER_CODE },
      select: { id: true, name: true, config: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!integration) {
      throw new NotFoundException(
        'Connect a Telephony / IVR integration in Settings → Integrations before issuing a webhook token.',
      );
    }

    const token = `cs_tel_${randomBytes(24).toString('hex')}`;
    const config = asRecord(integration.config);
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        config: {
          ...config,
          // A HASH, not the token. `Integration.config` is readable by every
          // administration screen, so nothing that authenticates as the tenant
          // may be written here in the clear.
          //
          // NOTE: replacing the settings wholesale through the registry's
          // updateConfig drops this key, and the token then stops working until
          // it is rotated again. That is the safe direction to fail.
          webhookTokenHash: hashToken(token),
          webhookTokenPrefix: token.slice(0, 12),
          webhookTokenRotatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.record(user, {
      action: 'integration.telephony_token_rotated',
      entityType: 'Integration',
      entityId: integration.id,
      summary: `Issued a new telephony webhook token for "${integration.name}".`,
      // The prefix identifies WHICH token, and cannot be replayed as one.
      metadata: { providerCode: PROVIDER_CODE, tokenPrefix: token.slice(0, 12) },
    });

    return {
      token,
      tokenPrefix: token.slice(0, 12),
      integrationId: integration.id,
      // The path and the header, so the screen showing the token does not have
      // to hardcode either. The HOST is deliberately absent: the browser talks
      // to this API through a proxy origin and does not know the public one, so
      // guessing it here would print a URL that quietly does not resolve.
      path: '/integrations/telephony/webhook',
      header: 'x-caratos-telephony-token',
      warning:
        'This is the only time the token is shown. Store it in your telephony provider’s webhook settings now.',
    };
  }

  /**
   * Resolve the tenant from the presented token, or refuse.
   *
   * ponytail: a JSON-path lookup over Integration rows, which is unindexed. One
   * row per tenant per provider keeps that cheap at present scale; if this ever
   * runs hot, promote the hash to its own unique column and this call becomes a
   * primary-key read with no change to any caller.
   */
  async authenticate(rawToken: string | undefined): Promise<TelephonyAuth> {
    const token = (rawToken ?? '').trim();
    if (!token) throw new ForbiddenException('Missing telephony webhook token.');
    const hash = hashToken(token);

    const row = await this.prisma.integration.findFirst({
      where: {
        providerCode: PROVIDER_CODE,
        config: { path: ['webhookTokenHash'], equals: hash },
      },
      select: { id: true, organisationId: true, config: true },
    });
    // Compared again in constant time. The query already matched on equality,
    // so this is belt and braces rather than the guard — but the guard is one
    // refactor away from being a `startsWith`, and this costs nothing.
    const stored = row ? asRecord(row.config).webhookTokenHash : null;
    if (!row || typeof stored !== 'string' || !safeEqualHex(stored, hash)) {
      throw new ForbiddenException('Invalid telephony webhook token.');
    }
    return {
      organisationId: row.organisationId,
      integrationId: row.id,
      config: asRecord(row.config),
    };
  }

  /* ----------------------------------------------------------- the intake */

  async receive(auth: TelephonyAuth, input: TelephonyCallInput): Promise<TelephonyResult> {
    const { organisationId } = auth;
    const direction = input.direction ?? 'inbound';
    const providerCallId = input.callId.trim();

    /*
     * A replayed delivery returns the row it already wrote.
     *
     * Providers retry, and a retried missed call must not become a second
     * enquiry, a second task and a second entry in the day's call report. The
     * unique index on (organisationId, provider, providerCallId) is the guard;
     * this read is only the fast path.
     */
    const seen = await this.prisma.callLog.findFirst({
      where: { organisationId, provider: PROVIDER_CODE, providerCallId },
      select: { id: true, storeId: true, partyId: true, leadId: true, taskId: true },
    });
    if (seen) {
      return {
        handled: true,
        duplicate: true,
        callLogId: seen.id,
        storeId: seen.storeId,
        partyId: seen.partyId,
        leadId: seen.leadId,
        leadRef: null,
        taskId: seen.taskId,
        unroutedReason: seen.storeId ? null : 'The dialled number is not mapped to a branch.',
      };
    }

    const store = await this.resolveStore(organisationId, auth.config, input.toNumber);

    /*
     * The call is recorded FIRST, and unconditionally.
     *
     * Whatever happens to the enquiry afterwards, the fact that this person rang
     * is evidence and must survive. An unrouted call with no store still lands
     * here, where somebody can see it and map the number.
     */
    const callLog = await this.prisma.callLog.create({
      data: {
        organisationId,
        storeId: store?.id ?? null,
        direction,
        provider: PROVIDER_CODE,
        providerCallId,
        fromNumber: input.fromNumber.trim(),
        toNumber: input.toNumber.trim(),
        startedAt: parseInstant(input.startedAt) ?? new Date(),
        answeredAt: parseInstant(input.answeredAt),
        endedAt: parseInstant(input.endedAt),
        durationSec: Number.isFinite(input.durationSec) ? input.durationSec : null,
        disposition: input.disposition?.trim() || null,
        // A reference, never a copy. See the CallLog model header: this system
        // does not hold customer call audio.
        recordingUrl: input.recordingUrl?.trim() || null,
      },
      select: { id: true },
    });

    if (!store) {
      this.log.warn(
        `Telephony call for organisation ${organisationId} arrived on an unmapped number; logged without a branch.`,
      );
      return {
        handled: true,
        duplicate: false,
        callLogId: callLog.id,
        storeId: null,
        partyId: null,
        leadId: null,
        leadRef: null,
        taskId: null,
        unroutedReason:
          'The dialled number is not mapped to a branch. Add it to the integration’s number routing, or set it as the branch phone number, and future calls will open an enquiry.',
      };
    }

    /*
     * Identity through the CRM's own contract, so a caller who already has a
     * WhatsApp thread, an imported record or a lead form submission resolves to
     * THAT customer rather than a second one holding the same number.
     */
    const identity = await this.identity.resolveInbound(organisationId, {
      kind: 'phone',
      value: input.fromNumber,
      name: input.callerName ?? null,
      storeId: store.id,
      source: 'telephony',
    });

    /*
     * One enquiry per call, and exactly once.
     *
     * `LeadIntakeService` is the single door every automatic lead comes through
     * — it resolves the customer, opens the lead, schedules the two SOP
     * follow-ups, writes the activity and the audit row, and puts the lead into
     * the round-robin. Reproducing that here is how the Meta path and the web
     * form path drifted apart in the first place.
     *
     * `source` is `phone`, not a new `ivr` enum value: the fact this records is
     * that the enquiry arrived by telephone, which is exactly what `phone`
     * already means, and every filter, report and label in the product already
     * understands it. WHICH system delivered it is provenance, and provenance
     * lives on `originKey` and on the CallLog beside it.
     */
    const lead = await this.leadIntake.capture({
      organisationId,
      storeId: store.id,
      originKey: `ivr:${PROVIDER_CODE}:${providerCallId}`,
      customerName: input.callerName?.trim() || input.fromNumber.trim(),
      phone: input.fromNumber,
      interest: 'Phone enquiry',
      source: 'phone',
      identitySource: 'telephony',
      summary: 'Inbound call opened an enquiry.',
      auditAction: 'crm.lead_captured_from_call',
      systemActor: 'telephony_webhook',
      followUpNote: 'Follow up on the inbound call.',
      // No number, no name, no recording link. An audit row is read by people
      // who are not entitled to the customer's contact details.
      metadata: { provider: PROVIDER_CODE, direction, callLogId: callLog.id },
    });

    /*
     * The follow-up somebody is actually asked to make.
     *
     * The lead's own SOP follow-ups are +7 and +30 days — right for a walk-in,
     * useless for a call that rang out four minutes ago. This is the one due
     * TODAY, in the branch's timezone, and it is what appears in the calling
     * queue.
     */
    const task = lead.duplicate
      ? null
      : await this.prisma.task.create({
          data: {
            organisationId,
            storeId: store.id,
            title: `Call back — inbound call to ${store.name}`,
            detail:
              input.disposition?.trim()
                ? `Inbound call, disposition "${input.disposition.trim()}".`
                : 'Inbound call.',
            priority: 'high',
            status: 'open',
            partyId: identity.partyId,
            leadId: lead.leadId,
            assigneeId: lead.assigned?.userId ?? null,
            dueDate: businessDate(new Date(), resolveTz(store.timezone)),
          },
          select: { id: true },
        });

    await this.prisma.callLog.update({
      where: { id: callLog.id },
      data: { partyId: identity.partyId, leadId: lead.leadId, taskId: task?.id ?? null },
    });

    return {
      handled: true,
      duplicate: lead.duplicate,
      callLogId: callLog.id,
      storeId: store.id,
      partyId: identity.partyId,
      leadId: lead.leadId,
      leadRef: lead.reference,
      taskId: task?.id ?? null,
      unroutedReason: null,
    };
  }

  /**
   * Which branch owns the number that was dialled.
   *
   * Two sources, in order: the integration's own `numberRouting` map, which is
   * how a tenant with several DIDs pointing at one branch says so, and then the
   * branch's own recorded phone number, which most tenants have already filled
   * in and which needs no extra configuration at all.
   *
   * Returns null rather than a default. There is no sensible default here.
   */
  private async resolveStore(
    organisationId: string,
    config: Record<string, unknown>,
    toNumber: string,
  ) {
    const dialled = digits(toNumber);
    if (!dialled) return null;

    const routing = config.numberRouting;
    if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
      for (const [number, storeId] of Object.entries(routing as Record<string, unknown>)) {
        if (typeof storeId !== 'string' || !storeId) continue;
        if (!sameNumber(digits(number), dialled)) continue;
        const store = await this.prisma.store.findFirst({
          // Scoped to the tenant even though the id came from their own
          // settings: a mapping is data, and data is never a permission.
          where: {
            id: storeId,
            organisationId,
            isAggregate: false,
            isHolding: false,
            attendanceOnly: false,
            status: { not: 'closed' },
          },
          select: { id: true, name: true, timezone: true },
        });
        if (store) return store;
      }
    }

    const candidates = await this.prisma.store.findMany({
      where: {
        organisationId,
        isAggregate: false,
        isHolding: false,
        attendanceOnly: false,
        status: { not: 'closed' },
        phone: { not: null },
      },
      select: { id: true, name: true, timezone: true, phone: true },
    });
    return candidates.find((s) => sameNumber(digits(s.phone ?? ''), dialled)) ?? null;
  }
}

/* ------------------------------------------------------------------ helpers */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function digits(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Two numbers are the same line if one ends with the other, over at least the
 * last ten digits.
 *
 * Providers are inconsistent about country codes and trunk prefixes on the
 * DIALLED number in particular: the same DID arrives as `+919820055011`,
 * `919820055011` and `09820055011` from three of them. Comparing the tail
 * absorbs that without a country-code table nobody would maintain. Ten digits
 * is long enough that a shorter accidental match cannot happen.
 */
function sameNumber(rawA: string, rawB: string): boolean {
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;
  // The trunk prefix is dropped first, because it is a DIALLING instruction and
  // not part of the number: `02240000001` and `+912240000001` are one line, and
  // a tail comparison alone reads the leading zero as a digit and misses it.
  const a = rawA.replace(/^0+/, '');
  const b = rawB.replace(/^0+/, '');
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 10) return false;
  return a.slice(-n) === b.slice(-n);
}

function parseInstant(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
