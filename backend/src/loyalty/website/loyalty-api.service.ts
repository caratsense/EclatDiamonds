import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth-user';
import { StoreScopeService } from '../../common/store-scope.service';
import { CredentialCrypto } from '../../integration/framework/credential-crypto';
import { normalizeIndianMobile } from '../../common/contact.util';
import { fetchJson } from '../../integrations/integrations.util';
import { SIGNATURE_HEADER, signWebhook } from './webhook-signature';

/**
 * The loyalty API a tenant's own website calls (Block 11).
 *
 * ## Who the caller is, and why it is not a user
 *
 * A jewellery retailer's website has a "my rewards" page. To draw it, the site's
 * server needs a customer's points balance; to honour a discount at checkout it
 * needs to spend some. Neither is a person signing in, so neither may hold a
 * user JWT: a token minted for a browser-facing web server is a token that will
 * eventually be read out of a JavaScript bundle, and a head-office JWT read out
 * of a bundle is the whole tenant.
 *
 * The website therefore presents its own API key. The key resolves to ONE
 * organisation, and reaches exactly the five operations below and nothing else
 * in the product. The tenant comes from the key, never from the request — the
 * same rule the human guard and the Connect agent follow.
 *
 * ## What the server decides and what the caller decides
 *
 * The caller decides WHAT HAPPENED: this customer spent this much, this customer
 * wants to spend this many points, this sale was cancelled.
 *
 * The server decides WHAT IT IS WORTH. An earn is computed from the tenant's own
 * configured rate; the website cannot post a points figure for an earn, because
 * a website that can choose how many points a purchase earns has taken over the
 * business rule and nobody at head office can see or change it any more. With no
 * rate configured, earning is refused with a sentence saying so — not silently
 * awarded at 1:1.
 *
 * ## Money safety
 *
 * Points are money. Three properties are enforced by the database rather than by
 * reading before writing:
 *
 *   1. A redeem cannot overdraw. The balance moves in a single conditional
 *      `UPDATE … WHERE pointsBalance + delta >= 0 RETURNING`, so two concurrent
 *      redeems of a 100-point balance cannot both see 100.
 *   2. A replayed call cannot move points twice — `(organisationId,
 *      idempotencyKey)` is unique, and a collision returns the ORIGINAL entry.
 *   3. A sale cannot be reversed twice — `reversesId` is unique.
 *
 * All three would be races if they were `if (balance >= points)` checks.
 */

export const LOYALTY_API_PROVIDER_CODE = 'loyalty_website';

/** So a key is identifiable in a log or a support ticket without being usable. */
const KEY_PREFIX = 'cs_loy_';

/** Failed webhook announcements are retried this many times, then left alone. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

export interface LoyaltyApiAuth {
  organisationId: string;
  integrationId: string;
  config: Record<string, unknown>;
}

/**
 * The tenant's programme rules, as configured. Every field is optional because
 * an unconfigured programme must report itself unconfigured rather than fall
 * back to invented numbers.
 */
export interface ProgrammeSettings {
  /** Points awarded per `earnPerAmount` of spend. */
  earnPoints: number | null;
  /** The spend that earns `earnPoints`. "1 point per ₹100" is (1, 100). */
  earnPerAmount: number | null;
  /** What one point is worth in currency when redeemed. */
  redeemValuePerPoint: number | null;
  minRedeemPoints: number;
  maxRedeemPointsPerTransaction: number | null;
  /** Where ledger movements are announced. Null means announcements are off. */
  webhookUrl: string | null;
}

@Injectable()
export class LoyaltyApiService {
  private readonly log = new Logger(LoyaltyApiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: StoreScopeService,
    private readonly crypto: CredentialCrypto,
  ) {}

  /* ======================================================== the credential */

  /**
   * Issue (or replace) this tenant's website API key. Head office only.
   *
   * The plaintext is returned exactly once. Rotating invalidates the previous
   * key immediately, which is the entire point of rotating.
   */
  async rotateApiKey(user: AuthUser) {
    const integration = await this.requireIntegration(user.organisationId);

    const key = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const config = asRecord(integration.config);
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        config: {
          ...config,
          // A HASH. `Integration.config` is readable by every administration
          // screen, so nothing that authenticates as the tenant may be written
          // here in the clear.
          apiKeyHash: hashKey(key),
          apiKeyPrefix: key.slice(0, 14),
          apiKeyRotatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.record(user, {
      action: 'loyalty.api_key_rotated',
      entityType: 'Integration',
      entityId: integration.id,
      summary: `Issued a new loyalty website API key for "${integration.name}".`,
      // The prefix identifies WHICH key and cannot be replayed as one.
      metadata: { providerCode: LOYALTY_API_PROVIDER_CODE, keyPrefix: key.slice(0, 14) },
    });

    return {
      key,
      keyPrefix: key.slice(0, 14),
      integrationId: integration.id,
      header: 'x-caratos-loyalty-key',
      basePath: '/public/loyalty',
      warning:
        'This is the only time the key is shown. Put it in your website’s server-side ' +
        'configuration now — never in browser JavaScript, where any visitor can read it.',
    };
  }

  /**
   * Issue (or replace) the secret we sign outbound announcements with.
   *
   * Encrypted at rest like every other tenant secret, and returned once so the
   * website can be configured to verify. A tenant that never reads it is a
   * tenant whose website trusts an unverified POST from the internet.
   */
  async rotateSigningSecret(user: AuthUser) {
    const integration = await this.requireIntegration(user.organisationId);
    this.crypto.assertConfigured();

    const secret = randomBytes(32).toString('base64url');
    const context = {
      organisationId: user.organisationId,
      integrationId: integration.id,
      kind: 'shared_secret',
    };
    const enc = this.crypto.encrypt(secret, context);
    await this.prisma.integrationCredential.upsert({
      where: { integrationId_kind: { integrationId: integration.id, kind: 'shared_secret' } },
      create: {
        organisationId: user.organisationId,
        integrationId: integration.id,
        kind: 'shared_secret',
        ...enc,
        rotatedAt: new Date(),
      },
      update: { ...enc, rotatedAt: new Date() },
    });

    await this.audit.record(user, {
      action: 'loyalty.signing_secret_rotated',
      entityType: 'Integration',
      entityId: integration.id,
      summary: 'Issued a new signing secret for loyalty webhooks.',
    });

    return {
      secret,
      header: SIGNATURE_HEADER,
      scheme: 't=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">',
      warning:
        'Shown once. Store it where your website can read it, and verify every ' +
        'announcement against it — an unsigned POST from the internet is not us.',
    };
  }

  /**
   * Resolve the tenant from the presented key, or refuse.
   *
   * ponytail: a JSON-path lookup over Integration rows, which is unindexed. One
   * row per tenant per provider keeps that cheap at present scale; promote the
   * hash to its own unique column if it ever runs hot — no caller changes.
   */
  async authenticate(rawKey: string | undefined): Promise<LoyaltyApiAuth> {
    const key = (rawKey ?? '').trim();
    if (!key) throw new ForbiddenException('Missing loyalty API key.');
    const hash = hashKey(key);

    const row = await this.prisma.integration.findFirst({
      where: {
        providerCode: LOYALTY_API_PROVIDER_CODE,
        status: { notIn: ['disabled'] },
        config: { path: ['apiKeyHash'], equals: hash },
      },
      select: { id: true, organisationId: true, config: true },
    });
    const stored = row ? asRecord(row.config).apiKeyHash : null;
    // Compared again in constant time. The query already matched on equality, so
    // this is belt and braces — but the guard is one refactor away from being a
    // `startsWith`, and this costs nothing.
    if (!row || typeof stored !== 'string' || !safeEqualHex(stored, hash)) {
      throw new ForbiddenException('Invalid loyalty API key.');
    }

    // The same tenant-lifecycle gate a person gets. A cancelled account's
    // website must stop moving points.
    const org = await this.prisma.organisation.findUnique({
      where: { id: row.organisationId },
      select: { status: true },
    });
    if (org?.status === 'suspended' || org?.status === 'cancelled') {
      throw new ForbiddenException('This organisation is not active.');
    }

    return {
      organisationId: row.organisationId,
      integrationId: row.id,
      config: asRecord(row.config),
    };
  }

  /* ========================================================== the settings */

  /** Head office reads and writes the programme rules. */
  async settingsFor(organisationId: string): Promise<ProgrammeSettings & { configured: boolean }> {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: LOYALTY_API_PROVIDER_CODE },
      select: { config: true },
      orderBy: { createdAt: 'asc' },
    });
    const settings = readSettings(asRecord(integration?.config));
    return { ...settings, configured: canEarn(settings) };
  }

  async updateSettings(
    user: AuthUser,
    input: Partial<{
      earnPoints: number | null;
      earnPerAmount: number | null;
      redeemValuePerPoint: number | null;
      minRedeemPoints: number;
      maxRedeemPointsPerTransaction: number | null;
      webhookUrl: string | null;
    }>,
  ) {
    const integration = await this.requireIntegration(user.organisationId);
    const config = asRecord(integration.config);

    // A field the caller did not send is a field they did not want to change.
    //
    // `{ ...current, ...input }` looked equivalent and was not: class-transformer
    // materialises every declared optional property, so a body carrying only
    // `webhookUrl` arrives with `earnPoints: undefined` alongside it, and the
    // spread then overwrites a configured rate with undefined — which JSON drops,
    // silently switching earning off for the whole tenant. Setting a webhook URL
    // must not clear the earn rate. UNDEFINED MEANS LEAVE ALONE; an explicit
    // `null` is how a field is cleared, which is why the DTO permits it.
    const next = { ...readSettings(config) };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }

    // An earn rate is two numbers that only mean something together. Accepting
    // one without the other would store a rate that silently never applies.
    if ((next.earnPoints == null) !== (next.earnPerAmount == null)) {
      throw new BadRequestException(
        'An earn rate needs both halves: how many points, and per how much spend. ' +
          'Set both, or clear both to switch earning off.',
      );
    }
    if (next.earnPerAmount != null && next.earnPerAmount <= 0) {
      throw new BadRequestException('The spend that earns a point must be more than zero.');
    }
    if (next.webhookUrl && !/^https:\/\/[^\s]+$/i.test(next.webhookUrl)) {
      throw new BadRequestException(
        'The announcement URL must be https. Points movements are customer data and ' +
          'will not be posted over plain http.',
      );
    }

    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        config: {
          ...config,
          earnPoints: next.earnPoints,
          earnPerAmount: next.earnPerAmount,
          redeemValuePerPoint: next.redeemValuePerPoint,
          minRedeemPoints: next.minRedeemPoints,
          maxRedeemPointsPerTransaction: next.maxRedeemPointsPerTransaction,
          webhookUrl: next.webhookUrl,
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.record(user, {
      action: 'loyalty.programme_settings_changed',
      entityType: 'Integration',
      entityId: integration.id,
      summary: canEarn(next)
        ? `Loyalty earn rate set to ${next.earnPoints} point(s) per ${next.earnPerAmount}.`
        : 'Loyalty earning switched off.',
      metadata: { ...next },
    });

    return this.settingsFor(user.organisationId);
  }

  /* ============================================================ the reads */

  /**
   * Look a member up by phone.
   *
   * Returns `enrolled: false` rather than a 404, because "this visitor is not a
   * member" is a normal answer the website renders a join button for, not an
   * error. It reveals nothing about a number that is not a member — the response
   * shape is identical whoever asks.
   */
  async lookup(auth: LoyaltyApiAuth, rawPhone: string) {
    const phone = this.requirePhone(rawPhone);
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { organisationId_phone: { organisationId: auth.organisationId, phone } },
      select: {
        id: true,
        name: true,
        phone: true,
        tier: true,
        status: true,
        pointsBalance: true,
        lifetimeEarned: true,
        lifetimeRedeemed: true,
        enrolledAt: true,
        storeId: true,
      },
    });
    if (!account) return { enrolled: false as const, phone };

    const settings = readSettings(auth.config);
    /*
     * A NEGATIVE BALANCE IS A DEBT, NOT SPENDABLE POINTS.
     *
     * It can only arise from a reversal — a sale cancelled after the customer
     * had already spent what it earned — and the caller cannot choose that
     * figure. Reporting it as `redeemableValue: -250` would put a negative
     * discount in front of a checkout, and any total that summed redeemable
     * value across members would quietly net one customer's debt against
     * another's balance.
     *
     * So the two are reported as separate, non-overlapping fields: what can
     * actually be spent (floored at zero) and what is owed back. A website that
     * renders only the first is correct; one that renders both can say why.
     */
    const spendable = Math.max(0, account.pointsBalance);
    const adjustmentDebt = Math.max(0, -account.pointsBalance);
    return {
      enrolled: true as const,
      member: {
        ...account,
        /** Never negative. Zero when the member is in debt. */
        spendablePoints: spendable,
        /** Points owed back after a reversal. Zero for almost every member. */
        adjustmentDebt,
        // What the SPENDABLE balance is worth, so the website does not
        // reimplement the tenant's redemption rate and drift from it.
        redeemableValue:
          settings.redeemValuePerPoint != null
            ? round2(spendable * settings.redeemValuePerPoint)
            : null,
        minRedeemPoints: settings.minRedeemPoints,
      },
    };
  }

  /**
   * The statement. Newest first, cursor-paginated.
   *
   * This is also the RECONCILIATION surface: a website that missed an
   * announcement catches up by reading forward from the last entry it holds,
   * which is why the cursor is an entry id and not an offset.
   */
  async ledger(
    auth: LoyaltyApiAuth,
    rawPhone: string,
    opts: { limit?: number; cursor?: string } = {},
  ) {
    const phone = this.requirePhone(rawPhone);
    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { organisationId_phone: { organisationId: auth.organisationId, phone } },
      select: { id: true, pointsBalance: true },
    });
    if (!account) throw new NotFoundException('No loyalty member with that number.');

    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const entries = await this.prisma.loyaltyLedgerEntry.findMany({
      where: { organisationId: auth.organisationId, accountId: account.id },
      // id breaks the tie: two entries in the same millisecond would otherwise
      // page unstably and a reconciling caller could skip one.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        kind: true,
        points: true,
        balanceAfter: true,
        amount: true,
        reason: true,
        reference: true,
        source: true,
        storeId: true,
        reversesId: true,
        createdAt: true,
      },
    });

    const page = entries.slice(0, limit);
    return {
      balance: account.pointsBalance,
      entries: page.map((e) => ({ ...e, amount: e.amount == null ? null : Number(e.amount) })),
      nextCursor: entries.length > limit ? page[page.length - 1]?.id ?? null : null,
    };
  }

  /* =========================================================== the writes */

  /**
   * Enrol a member, or return the one that already exists.
   *
   * Idempotent by nature rather than by key: joining twice from a website form
   * is a double-click, not a second membership.
   */
  async enroll(
    auth: LoyaltyApiAuth,
    input: { phone: string; name?: string; storeId?: string; tier?: string },
  ) {
    const phone = this.requirePhone(input.phone);
    if (input.storeId) await this.assertStoreInOrg(auth.organisationId, input.storeId);

    const existing = await this.prisma.loyaltyAccount.findUnique({
      where: { organisationId_phone: { organisationId: auth.organisationId, phone } },
    });
    if (existing) {
      return { created: false as const, member: this.accountView(existing) };
    }

    // Attach to the CRM customer if one is already on file. Best effort: a
    // member with no matched party is perfectly usable, and guessing between two
    // customers with the same number would be worse than leaving it null.
    const party = await this.prisma.party.findFirst({
      where: { organisationId: auth.organisationId, phone },
      select: { id: true, storeId: true },
      orderBy: { createdAt: 'asc' },
    });

    const account = await this.prisma.loyaltyAccount.create({
      data: {
        organisationId: auth.organisationId,
        phone,
        name: input.name?.trim() || null,
        partyId: party?.id ?? null,
        storeId: input.storeId ?? party?.storeId ?? null,
        tier: input.tier?.trim() || null,
      },
    });
    await this.audit.recordSystem(auth.organisationId, 'loyalty_website', {
      action: 'loyalty.member_enrolled',
      entityType: 'LoyaltyAccount',
      entityId: account.id,
      storeId: account.storeId,
      summary: `${account.name ?? 'A customer'} joined the loyalty programme from the website.`,
    });
    return { created: true as const, member: this.accountView(account) };
  }

  /**
   * Award points for a purchase.
   *
   * The POINTS ARE COMPUTED HERE, from the tenant's configured rate and the
   * amount the caller reports. See the class comment: a website that can name
   * its own points figure owns a business rule nobody at head office can see.
   */
  async earn(
    auth: LoyaltyApiAuth,
    input: {
      phone: string;
      amount: number;
      idempotencyKey: string;
      reference?: string;
      reason?: string;
      storeId?: string;
    },
  ) {
    const settings = readSettings(auth.config);
    if (!canEarn(settings)) {
      throw new BadRequestException(
        'No earn rate is configured for this loyalty programme, so a purchase cannot ' +
          'award points yet. Set one in CaratOS under Settings → Loyalty.',
      );
    }
    // FLOOR, not round. Rounding up awards points for money nobody spent, and
    // does it on every transaction for ever.
    const points = Math.floor(input.amount / settings.earnPerAmount!) * settings.earnPoints!;
    if (points <= 0) {
      throw new BadRequestException(
        `A spend of ${input.amount} earns no points at the configured rate ` +
          `(${settings.earnPoints} per ${settings.earnPerAmount}).`,
      );
    }

    return this.move(auth, {
      phone: input.phone,
      kind: 'earn',
      points,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
      reason: input.reason,
      storeId: input.storeId,
    });
  }

  /** Spend points. The caller chooses how many; the server decides if it can. */
  async redeem(
    auth: LoyaltyApiAuth,
    input: {
      phone: string;
      points: number;
      idempotencyKey: string;
      reference?: string;
      reason?: string;
      storeId?: string;
    },
  ) {
    const settings = readSettings(auth.config);
    if (input.points < settings.minRedeemPoints) {
      throw new BadRequestException(
        `This programme redeems from ${settings.minRedeemPoints} points upwards.`,
      );
    }
    const cap = settings.maxRedeemPointsPerTransaction;
    if (cap != null && input.points > cap) {
      throw new BadRequestException(`At most ${cap} points may be redeemed in one transaction.`);
    }

    const value =
      settings.redeemValuePerPoint != null
        ? round2(input.points * settings.redeemValuePerPoint)
        : null;

    const result = await this.move(auth, {
      phone: input.phone,
      kind: 'redeem',
      points: -input.points,
      amount: value ?? undefined,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
      reason: input.reason,
      storeId: input.storeId,
    });
    // The money the customer is owed off their bill. Null when the tenant has
    // not said what a point is worth — better an explicit null the checkout can
    // refuse than a silent zero it applies.
    return { ...result, discountValue: value };
  }

  /**
   * Undo one movement, exactly once.
   *
   * A cancelled sale must take back the points it gave. Identified by the
   * caller's OWN idempotency key or reference rather than our entry id, because
   * the website's cancellation handler holds its order id, not ours.
   */
  async reverse(
    auth: LoyaltyApiAuth,
    input: {
      idempotencyKey: string;
      /** Which movement to undo — the key the original call used. */
      originalIdempotencyKey?: string;
      entryId?: string;
      reason?: string;
    },
  ) {
    if (!input.originalIdempotencyKey && !input.entryId) {
      throw new BadRequestException(
        'Say which movement to reverse: either its original idempotency key or its entry id.',
      );
    }

    const original = await this.prisma.loyaltyLedgerEntry.findFirst({
      where: {
        organisationId: auth.organisationId,
        ...(input.entryId
          ? { id: input.entryId }
          : { idempotencyKey: input.originalIdempotencyKey }),
      },
      select: {
        id: true,
        accountId: true,
        kind: true,
        points: true,
        amount: true,
        reference: true,
        storeId: true,
        account: { select: { phone: true } },
      },
    });
    if (!original) throw new NotFoundException('No such loyalty movement to reverse.');
    // Checked here so the refusal says what actually happened. The unique index
    // on `reversesId` is still the guard — it is what stops two SIMULTANEOUS
    // reversals — but it fires after the balance has been evaluated, and a
    // customer who has since spent the points would be told "not enough points",
    // which suggests topping up rather than "this was already reversed".
    const alreadyReversed = await this.prisma.loyaltyLedgerEntry.findUnique({
      where: { reversesId: original.id },
      select: { id: true },
    });
    if (alreadyReversed) {
      throw new BadRequestException('That movement has already been reversed.');
    }
    if (original.kind === 'reversal') {
      throw new BadRequestException(
        'A reversal cannot itself be reversed. Record the correcting movement instead, ' +
          'so the statement shows what actually happened.',
      );
    }

    return this.move(auth, {
      phone: original.account.phone,
      kind: 'reversal',
      // The exact negation. Not "refund the bill at today's rate" — the points
      // this sale gave are the points it takes back, whatever the rate is now.
      points: -original.points,
      amount: original.amount == null ? undefined : Number(original.amount),
      idempotencyKey: input.idempotencyKey,
      reference: original.reference ?? undefined,
      reason: input.reason ?? 'Reversed',
      storeId: original.storeId ?? undefined,
      reversesId: original.id,
      // A reversal is allowed to overdraw, and this is a deliberate product
      // decision rather than an oversight.
      //
      // The case: a customer earns 30 points on a purchase, spends them, and the
      // purchase is then cancelled. Refusing the reversal keeps the balance
      // tidy and leaves a ledger that cannot show the sale was cancelled — the
      // business silently absorbs it and nobody can reconstruct why. Allowing it
      // records the truth and leaves the customer 30 points in debit, which is
      // what a clawback IS, and which the ordinary guard then enforces: with a
      // negative balance no further redemption can pass.
      //
      // Safe precisely because the caller cannot choose the figure — it is the
      // exact negation of the entry being reversed. Nothing else in this service
      // may overdraw.
      allowNegative: true,
    });
  }

  /* ==================================================== the shared write */

  /**
   * Every points movement goes through here.
   *
   * Two things happen atomically: the account balance moves under a condition
   * the database evaluates, and the entry is appended carrying the balance that
   * resulted. Doing them in either order without a transaction produces a
   * balance nobody can explain from the statement.
   */
  private async move(
    auth: LoyaltyApiAuth,
    input: {
      phone: string;
      kind: string;
      points: number;
      amount?: number;
      idempotencyKey?: string;
      reference?: string;
      reason?: string;
      storeId?: string;
      reversesId?: string;
      /** Only a reversal may drive the balance below zero. See `reverse`. */
      allowNegative?: boolean;
      /** Set when a person inside CaratOS is doing this, not the website. */
      actor?: { type: 'user'; id: string };
    },
  ) {
    const phone = this.requirePhone(input.phone);
    if (input.storeId) await this.assertStoreInOrg(auth.organisationId, input.storeId);

    // A replay is answered BEFORE anything moves, so the common retry costs one
    // indexed read rather than a rolled-back transaction.
    if (input.idempotencyKey) {
      const replay = await this.findByKey(auth.organisationId, input.idempotencyKey);
      if (replay) return { idempotent: true as const, ...replay };
    }

    const account = await this.prisma.loyaltyAccount.findUnique({
      where: { organisationId_phone: { organisationId: auth.organisationId, phone } },
      select: { id: true, status: true },
    });
    if (!account) {
      throw new NotFoundException(
        'No loyalty member with that number. Enrol them before moving points.',
      );
    }
    if (account.status !== 'active') {
      throw new BadRequestException(
        `This membership is ${account.status}, so its points cannot move.`,
      );
    }

    const earned = input.points > 0 && input.kind !== 'reversal' ? input.points : 0;
    const redeemed = input.points < 0 && input.kind !== 'reversal' ? -input.points : 0;

    let created: { id: string; balanceAfter: number; createdAt: Date };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // The overdraft guard, evaluated by Postgres inside the row lock this
        // UPDATE takes. Two concurrent redeems of a 100-point balance cannot
        // both read 100, which an application-level `if` could not prevent.
        const moved = await tx.$queryRaw<{ pointsBalance: number }[]>(Prisma.sql`
          UPDATE "LoyaltyAccount"
             SET "pointsBalance"    = "pointsBalance" + ${input.points},
                 "lifetimeEarned"   = "lifetimeEarned" + ${earned},
                 "lifetimeRedeemed" = "lifetimeRedeemed" + ${redeemed},
                 "updatedAt"        = now()
           WHERE "id" = ${account.id}
             AND "organisationId" = ${auth.organisationId}
             AND "status" = 'active'
             ${
               input.allowNegative
                 ? Prisma.empty
                 : Prisma.sql`AND "pointsBalance" + ${input.points} >= 0`
             }
        RETURNING "pointsBalance"
        `);
        if (!moved.length) {
          // The only remaining reason, the status having been checked above.
          throw new BadRequestException('INSUFFICIENT_POINTS');
        }
        const balanceAfter = Number(moved[0].pointsBalance);

        const entry = await tx.loyaltyLedgerEntry.create({
          data: {
            organisationId: auth.organisationId,
            accountId: account.id,
            kind: input.kind,
            points: input.points,
            balanceAfter,
            amount: input.amount == null ? null : new Prisma.Decimal(input.amount),
            idempotencyKey: input.idempotencyKey ?? null,
            reversesId: input.reversesId ?? null,
            reason: input.reason?.slice(0, 500) ?? null,
            reference: input.reference?.slice(0, 120) ?? null,
            storeId: input.storeId ?? null,
            source: input.actor ? 'store' : 'website',
            actorType: input.actor ? 'user' : 'api_client',
            actorId: input.actor?.id ?? auth.integrationId,
          },
          select: { id: true, balanceAfter: true, createdAt: true },
        });
        return entry;
      });
    } catch (e) {
      if (e instanceof BadRequestException && e.message === 'INSUFFICIENT_POINTS') {
        const fresh = await this.prisma.loyaltyAccount.findUnique({
          where: { id: account.id },
          select: { pointsBalance: true },
        });
        throw new BadRequestException(
          `Not enough points: ${-input.points} requested, ${fresh?.pointsBalance ?? 0} available.`,
        );
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        // Two races land here, and they are different answers.
        //
        // The idempotency key: somebody else's identical retry won. The correct
        // response is THEIR entry — the caller asked for one movement and there
        // is exactly one.
        if (input.idempotencyKey && !target.includes('reverses')) {
          const winner = await this.findByKey(auth.organisationId, input.idempotencyKey);
          if (winner) return { idempotent: true as const, ...winner };
        }
        // The reversal key: this sale has already been undone. Not the same
        // request, so not idempotent — a refusal.
        throw new BadRequestException('That movement has already been reversed.');
      }
      throw e;
    }

    // Announced AFTER the transaction commits, deliberately. Posting inside it
    // would hold a row lock open for the length of somebody else's HTTP request,
    // and would announce a movement that a later rollback un-did.
    void this.announce(auth.organisationId, created.id).catch(() => undefined);

    return {
      idempotent: false as const,
      entryId: created.id,
      points: input.points,
      balance: created.balanceAfter,
      at: created.createdAt,
    };
  }

  /* ================================================ in-store counterparts */

  /**
   * The same movements, made by a person inside CaratOS.
   *
   * Kept on the same path as the website's so the ledger cannot diverge: one
   * place computes a balance, one place writes an entry, and the statement reads
   * the same whichever door the points came through. What differs is the actor
   * and, for an adjustment, that a human may name the figure — audited, and
   * head-office only.
   */
  async manualMovement(
    user: AuthUser,
    input: {
      phone: string;
      kind: 'earn' | 'redeem' | 'adjustment';
      points?: number;
      amount?: number;
      reason?: string;
      reference?: string;
      storeId?: string;
    },
  ) {
    if (input.storeId) this.scope.assertStoreAllowed(user, input.storeId);
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId: user.organisationId, providerCode: LOYALTY_API_PROVIDER_CODE },
      select: { id: true, config: true },
      orderBy: { createdAt: 'asc' },
    });
    const auth: LoyaltyApiAuth = {
      organisationId: user.organisationId,
      integrationId: integration?.id ?? 'internal',
      config: asRecord(integration?.config),
    };
    const settings = readSettings(auth.config);

    let points: number;
    if (input.kind === 'adjustment') {
      if (user.role !== 'head_office') {
        throw new ForbiddenException(
          'Only head office can adjust a points balance by hand. A sale earns or redeems.',
        );
      }
      if (!input.points || !Number.isInteger(input.points)) {
        throw new BadRequestException('An adjustment needs a whole number of points.');
      }
      if (!input.reason?.trim()) {
        throw new BadRequestException(
          'An adjustment needs a reason. A balance that changed for no recorded reason ' +
            'cannot be defended to the customer.',
        );
      }
      points = input.points;
    } else if (input.kind === 'earn') {
      if (!canEarn(settings)) {
        throw new BadRequestException(
          'No earn rate is configured, so a purchase cannot award points yet.',
        );
      }
      if (input.amount == null || input.amount <= 0) {
        throw new BadRequestException('An earn needs the bill amount.');
      }
      points = Math.floor(input.amount / settings.earnPerAmount!) * settings.earnPoints!;
      if (points <= 0) {
        throw new BadRequestException('That bill earns no points at the configured rate.');
      }
    } else {
      if (!input.points || input.points <= 0) {
        throw new BadRequestException('A redemption needs the number of points to spend.');
      }
      if (input.points < settings.minRedeemPoints) {
        throw new BadRequestException(
          `This programme redeems from ${settings.minRedeemPoints} points upwards.`,
        );
      }
      points = -input.points;
    }

    const result = await this.move(auth, {
      phone: input.phone,
      kind: input.kind,
      points,
      amount: input.amount,
      reason: input.reason,
      reference: input.reference,
      storeId: input.storeId ?? user.storeIds[0],
      actor: { type: 'user', id: user.id },
    });

    await this.audit.record(user, {
      action: `loyalty.points_${input.kind}`,
      entityType: 'LoyaltyLedgerEntry',
      entityId: result.entryId,
      storeId: input.storeId ?? null,
      summary: `${points > 0 ? '+' : ''}${points} points for ${input.phone}${
        input.reason ? ` — ${input.reason}` : ''
      }`,
      metadata: { kind: input.kind, points, balance: result.balance },
    });
    return result;
  }

  /** The member list a counter screen shows. Store-scoped like everything else. */
  async members(user: AuthUser, opts: { q?: string; storeId?: string } = {}) {
    const storeIds = this.scope.effectiveStoreIds(user, opts.storeId);
    const q = opts.q?.trim();
    const accounts = await this.prisma.loyaltyAccount.findMany({
      where: {
        organisationId: user.organisationId,
        // AND of two ORs, not two `OR` keys on one object — the second would
        // silently replace the first and the store filter would vanish.
        AND: [
          // A website signup has no branch, and hiding those from every branch
          // screen would make them invisible to the whole business.
          { OR: [{ storeId: { in: storeIds } }, { storeId: null }] },
          ...(q
            ? [
                {
                  OR: [
                    { phone: { contains: q.replace(/\D/g, '') || q } },
                    { name: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return accounts.map((a) => this.accountView(a));
  }

  /* =========================================================== the webhook */

  /**
   * Announce one entry to the tenant's endpoint, signed.
   *
   * Never throws to its caller: a points movement that succeeded must not be
   * reported as failed because somebody else's web server was down. The outcome
   * is written onto the entry instead, and the sweep below retries it.
   */
  async announce(organisationId: string, entryId: string): Promise<'sent' | 'skipped' | 'failed'> {
    const entry = await this.prisma.loyaltyLedgerEntry.findFirst({
      where: { id: entryId, organisationId },
      select: {
        id: true,
        kind: true,
        points: true,
        balanceAfter: true,
        amount: true,
        reference: true,
        reason: true,
        source: true,
        storeId: true,
        createdAt: true,
        webhookAttempts: true,
        account: { select: { phone: true, tier: true } },
      },
    });
    if (!entry) return 'skipped';

    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: LOYALTY_API_PROVIDER_CODE },
      select: { id: true, config: true, credentials: { where: { kind: 'shared_secret' } } },
      orderBy: { createdAt: 'asc' },
    });
    const url = readSettings(asRecord(integration?.config)).webhookUrl;
    if (!integration || !url) {
      // Announcements are off. Marked sent-with-no-destination so the sweep does
      // not retry for ever; the ledger endpoint remains the tenant's way to read
      // movements, and a tenant with no URL has chosen to pull rather than be
      // pushed to.
      await this.prisma.loyaltyLedgerEntry.update({
        where: { id: entry.id },
        data: { webhookedAt: new Date(), webhookError: null },
      });
      return 'skipped';
    }

    const credential = integration.credentials[0];
    if (!credential) {
      await this.markWebhookFailure(
        entry.id,
        'No signing secret is configured, so this movement cannot be announced. Issue one under Settings → Loyalty.',
      );
      return 'failed';
    }

    let secret: string;
    try {
      secret = this.crypto.decrypt(
        {
          ciphertext: credential.ciphertext,
          iv: credential.iv,
          authTag: credential.authTag,
          keyVersion: credential.keyVersion,
        },
        { organisationId, integrationId: integration.id, kind: 'shared_secret' },
      );
    } catch {
      await this.markWebhookFailure(
        entry.id,
        'The stored signing secret could not be decrypted. It must be re-issued.',
      );
      return 'failed';
    }

    const body = JSON.stringify({
      event: 'loyalty.movement',
      entryId: entry.id,
      member: { phone: entry.account.phone, tier: entry.account.tier },
      kind: entry.kind,
      points: entry.points,
      balance: entry.balanceAfter,
      amount: entry.amount == null ? null : Number(entry.amount),
      reference: entry.reference,
      reason: entry.reason,
      source: entry.source,
      storeId: entry.storeId,
      at: entry.createdAt.toISOString(),
    });
    // Sign the EXACT string that goes on the wire. Re-serialising a parsed
    // object produces bytes the receiver cannot reproduce, and the signature
    // then fails for reasons nobody can find.
    const signed = signWebhook(secret, body);

    try {
      await fetchJson(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signed.signature,
          'x-caratos-event': 'loyalty.movement',
        },
        body,
        timeoutMs: 8000,
      });
      await this.prisma.loyaltyLedgerEntry.update({
        where: { id: entry.id },
        data: {
          webhookedAt: new Date(),
          webhookError: null,
          webhookAttempts: { increment: 1 },
        },
      });
      return 'sent';
    } catch (err) {
      await this.markWebhookFailure(
        entry.id,
        err instanceof Error ? err.message : String(err),
      );
      return 'failed';
    }
  }

  /**
   * Retry announcements that have not landed.
   *
   * Bounded at {@link WEBHOOK_MAX_ATTEMPTS}: an endpoint that has refused five
   * times is misconfigured, not busy, and a webhook queue that retries for ever
   * becomes a slow denial of service against the tenant's own website. The error
   * stays on the entry so a screen can say which movements the website never
   * heard about, and the ledger endpoint can still be read to catch up.
   */
  async retryAnnouncements(organisationId: string, limit = 50) {
    const pending = await this.prisma.loyaltyLedgerEntry.findMany({
      where: {
        organisationId,
        webhookedAt: null,
        webhookAttempts: { lt: WEBHOOK_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let sent = 0;
    let failed = 0;
    for (const { id } of pending) {
      const outcome = await this.announce(organisationId, id);
      if (outcome === 'sent') sent++;
      else if (outcome === 'failed') failed++;
    }
    return { considered: pending.length, sent, failed };
  }

  /**
   * Every tenant with movements the website has not heard about.
   *
   * Driven by the scheduler. Not wrapped in `runOnce`: the work is idempotent by
   * construction — `webhookedAt` is set on success, so a second replica sweeping
   * the same minute finds nothing left to send, and at worst a movement is
   * announced twice. A receiver already has to tolerate that (it is keyed by
   * `entryId`), whereas a movement announced ZERO times is a stale balance on a
   * customer-facing page.
   */
  async sweepAnnouncements(): Promise<{ organisations: number; sent: number; failed: number }> {
    const pending = await this.prisma.loyaltyLedgerEntry.groupBy({
      by: ['organisationId'],
      where: { webhookedAt: null, webhookAttempts: { lt: WEBHOOK_MAX_ATTEMPTS } },
      _count: { _all: true },
    });
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      // One tenant's unreachable website must not stop another's.
      try {
        const res = await this.retryAnnouncements(row.organisationId);
        sent += res.sent;
        failed += res.failed;
      } catch (e) {
        this.log.error(
          `Loyalty announcement sweep failed for one organisation: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return { organisations: pending.length, sent, failed };
  }

  /* ============================================================== helpers */

  private async markWebhookFailure(entryId: string, error: string) {
    await this.prisma.loyaltyLedgerEntry.update({
      where: { id: entryId },
      data: { webhookError: error.slice(0, 500), webhookAttempts: { increment: 1 } },
    });
  }

  private async findByKey(organisationId: string, idempotencyKey: string) {
    const existing = await this.prisma.loyaltyLedgerEntry.findUnique({
      where: { organisationId_idempotencyKey: { organisationId, idempotencyKey } },
      select: { id: true, points: true, balanceAfter: true, createdAt: true },
    });
    if (!existing) return null;
    return {
      entryId: existing.id,
      points: existing.points,
      balance: existing.balanceAfter,
      at: existing.createdAt,
    };
  }

  private requirePhone(raw: string): string {
    const phone = normalizeIndianMobile(raw ?? '');
    if (!phone) {
      throw new BadRequestException('A valid mobile number is required to identify a member.');
    }
    return phone;
  }

  /**
   * The store id came from the request, so it is checked against the TOKEN's
   * organisation. Without this a website key could file a movement against
   * another tenant's branch.
   */
  private async assertStoreInOrg(organisationId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, organisationId },
      select: { id: true },
    });
    if (!store) throw new BadRequestException('That branch does not belong to this organisation.');
  }

  private async requireIntegration(organisationId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: LOYALTY_API_PROVIDER_CODE },
      select: { id: true, name: true, config: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!integration) {
      throw new NotFoundException(
        'Connect the "Loyalty website API" integration in Settings → Integrations first.',
      );
    }
    return integration;
  }

  private accountView(a: {
    id: string;
    phone: string;
    name: string | null;
    tier: string | null;
    status: string;
    pointsBalance: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
    storeId: string | null;
    partyId: string | null;
    enrolledAt: Date;
  }) {
    return {
      id: a.id,
      phone: a.phone,
      name: a.name,
      tier: a.tier,
      status: a.status,
      pointsBalance: a.pointsBalance,
      /** Never negative — see `lookup` for why the two are kept apart. */
      spendablePoints: Math.max(0, a.pointsBalance),
      adjustmentDebt: Math.max(0, -a.pointsBalance),
      lifetimeEarned: a.lifetimeEarned,
      lifetimeRedeemed: a.lifetimeRedeemed,
      storeId: a.storeId,
      partyId: a.partyId,
      enrolledAt: a.enrolledAt,
    };
  }
}

/* ------------------------------------------------------------ module-local */

function hashKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A positive finite number, or null. Anything else in config is not a rate. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function readSettings(config: Record<string, unknown>): ProgrammeSettings {
  return {
    earnPoints: num(config.earnPoints),
    earnPerAmount: num(config.earnPerAmount),
    redeemValuePerPoint: num(config.redeemValuePerPoint),
    // The floor is 1, not 0: "redeem 0 points" is a movement that means nothing
    // and would still write a ledger line.
    minRedeemPoints: num(config.minRedeemPoints) ?? 1,
    maxRedeemPointsPerTransaction: num(config.maxRedeemPointsPerTransaction),
    webhookUrl:
      typeof config.webhookUrl === 'string' && config.webhookUrl.trim()
        ? config.webhookUrl.trim()
        : null,
  };
}

/** Both halves of the rate, or earning is off. */
export function canEarn(s: Pick<ProgrammeSettings, 'earnPoints' | 'earnPerAmount'>): boolean {
  return s.earnPoints != null && s.earnPerAmount != null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
