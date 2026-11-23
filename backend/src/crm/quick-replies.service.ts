import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { ROLE_RANK } from '../common/role.util';
import { StoreScopeService } from '../common/store-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  providerTemplateStatus,
  templateSendability,
} from '../omnichannel/omnichannel-policy';
import { variableDefaultsFrom } from '../omnichannel/template-draft';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import {
  CampaignVariableError,
  parseVariableMappings,
  resolveVariables,
  templateComponentsFor,
  variableSlotsIn,
  type VariableMapping,
} from './campaign-variables';
import { ConversationsService } from './conversations.service';
import type { CreateQuickReplyDto, UpdateQuickReplyDto } from './quick-replies.dto';
import {
  QuickReplyKind,
  fillPlaceholders,
  insideCustomerCareWindow,
  kindUsableNow,
  unknownPlaceholders,
  QUICK_REPLY_PLACEHOLDERS,
} from './quick-replies';

const TEMPLATE_ASSET_KIND = 'message_template';

/**
 * Beyond this the chip row stops being a shortcut and becomes a menu nobody
 * reads. A product judgement, not data integrity, so it is counted here where
 * the refusal can say why.
 */
export const QUICK_REPLIES_PER_TENANT_MAX = 40;

/** One chip, as the inbox needs it: ready to use, or not offered at all. */
export interface QuickReplyChip {
  id: string;
  label: string;
  kind: QuickReplyKind;
  /** The words, placeholders already filled. Both kinds carry it: free text to
   *  put in the composer, a template to show what pressing it will send. */
  text: string;
  /** True for a template-backed chip, which SENDS rather than drafts. */
  sends: boolean;
}

/** One row as the management screen needs it, warnings included. */
export interface QuickReplyRow {
  id: string;
  label: string;
  kind: QuickReplyKind;
  body: string | null;
  templateAssetId: string | null;
  templateName: string | null;
  storeId: string | null;
  storeName: string | null;
  sortOrder: number;
  isActive: boolean;
  /**
   * Why this reply cannot reach anybody at the moment, in words for whoever is
   * looking at the screen. Null when it is fine. This is the screen that can
   * fix it, which is why the warning lives here and not in the inbox.
   */
  warning: string | null;
}

interface ResolvedTemplate {
  assetId: string;
  name: string;
  /** Null when the template can be sent; otherwise why it cannot. */
  blocked: string | null;
  mappings: VariableMapping[];
  bodyPreview: string;
  category: string;
}

/**
 * Quick replies: the words a salesperson sends from the inbox with one tap.
 *
 * Three decisions are worth stating, because each one replaces something that
 * used to be hardcoded in `conversations/page.tsx`.
 *
 * **A template-backed chip SENDS; it does not draft.** A template's wording is
 * fixed at Meta, so there is nothing to edit in the composer — and dropping its
 * body into the draft would invite somebody to change a word, at which point it
 * goes out as free text under a different set of rules, or not at all. It also
 * has to behave the same way at 09:00 and at 09:00 the next day: a chip that
 * drafts inside the window and sends outside it is the kind of inconsistency
 * that sends the wrong message to a customer standing in the shop.
 *
 * **Placeholders are filled on the server.** One resolver, one set of
 * stand-ins. The template path has no choice — the values travel as provider
 * parameters — and letting the free-text path interpolate in the browser would
 * be a second copy of the rule, which is how two copies end up disagreeing
 * about what happens when a customer has no name recorded.
 *
 * **A reply for every branch is head office's to write.** A branch manager may
 * add, edit and delete their own branch's replies and only those. Reshaping
 * what all eleven branches see is a different act from writing a shortcut for
 * your own counter, and the difference is `storeId` being null.
 */
@Injectable()
export class QuickRepliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly conversations: ConversationsService,
    /*
     * forwardRef for the same reason ConversationAiGate has one: CrmModule and
     * OmnichannelModule are a genuine two-way edge. Sending through
     * OmnichannelService rather than writing a Message here is the point —
     * consent, the window, template approval, the outbox and the audit trail
     * are enforced in exactly one place, and a quick reply must not be a second
     * door past them.
     */
    @Inject(forwardRef(() => OmnichannelService))
    private readonly omnichannel: OmnichannelService,
  ) {}

  /* ---------------------------------------------------------------- the inbox */

  /**
   * The chips for one thread: what can be sent to this customer right now.
   *
   * The server decides, not the browser. The composer's own affordance already
   * computes the window locally and that is fine for enabling a text box, but
   * WHICH shortcuts exist is a question about stored rows, template approval
   * and branch scope, and all three live here.
   */
  async forConversation(
    user: AuthUser,
    conversationId: string,
  ): Promise<{ windowOpen: boolean; chips: QuickReplyChip[]; canManage: boolean }> {
    const conversation = await this.conversations.assertCanAccess(user, conversationId);
    const windowOpen = insideCustomerCareWindow(conversation.lastInboundAt);

    const rows = await this.prisma.quickReply.findMany({
      where: {
        ...this.scope.orgFilter(user),
        isActive: true,
        // A reply belongs to this branch or to all of them. A thread with no
        // branch yet — an ad click nobody has routed — sees the shared ones,
        // which is the honest answer rather than nothing at all.
        OR: [{ storeId: null }, ...(conversation.storeId ? [{ storeId: conversation.storeId }] : [])],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const templates = await this.resolveTemplates(
      user.organisationId,
      rows.map((r) => r.templateAssetId),
    );
    const subject = {
      customerName: conversation.party?.name ?? null,
      branchName: conversation.store?.name ?? (await this.businessName(user.organisationId)),
      agentName: user.name,
    };

    const chips: QuickReplyChip[] = [];
    for (const row of rows) {
      const kind = row.kind as QuickReplyKind;
      if (!kindUsableNow(kind, windowOpen)) continue;
      if (kind === 'free_text') {
        if (!row.body) continue;
        chips.push({
          id: row.id,
          label: row.label,
          kind,
          text: fillPlaceholders(row.body, subject),
          sends: false,
        });
        continue;
      }
      /*
       * A template-backed chip whose template cannot be sent is NOT offered.
       *
       * Deliberately a hidden chip rather than a disabled one. The reasons are
       * all somebody else's job — Meta has not approved it, the approval is a
       * day stale, nobody mapped its variables — and none of them can be acted
       * on by the person holding a tablet in front of a customer. The
       * management screen shows the same row with the reason spelled out,
       * because that is where it can be fixed.
       */
      const resolved = row.templateAssetId ? templates.get(row.templateAssetId) : undefined;
      if (!resolved || resolved.blocked) continue;
      chips.push({
        id: row.id,
        label: row.label,
        kind,
        text: previewWithValues(resolved.bodyPreview, resolved.mappings, subject),
        sends: true,
      });
    }

    return { windowOpen, chips, canManage: isManager(user) };
  }

  /**
   * Press a template-backed chip.
   *
   * Free text never comes here: it fills the composer and leaves by the send
   * button the salesperson already uses, so nothing about drafting, attaching a
   * photo or editing a word changes.
   */
  async send(user: AuthUser, conversationId: string, quickReplyId: string) {
    const conversation = await this.conversations.assertCanAccess(user, conversationId);
    const row = await this.prisma.quickReply.findFirst({
      where: { id: quickReplyId, ...this.scope.orgFilter(user), isActive: true },
    });
    if (!row) throw new NotFoundException('That quick reply no longer exists.');
    // A branch reply belongs to that branch's threads only; without this the id
    // in the URL would be enough to send another branch's wording.
    if (row.storeId && row.storeId !== conversation.storeId) {
      throw new NotFoundException('That quick reply is not set up for this branch.');
    }
    if (row.kind !== 'template' || !row.templateAssetId) {
      throw new BadRequestException(
        'This quick reply is wording for the composer, not a template. Put it in the box and send it from there.',
      );
    }

    const resolved = (await this.resolveTemplates(user.organisationId, [row.templateAssetId])).get(
      row.templateAssetId,
    );
    if (!resolved) {
      throw new BadRequestException(
        'The template behind this quick reply is no longer on this account. A manager can point it at another one.',
      );
    }
    if (resolved.blocked) throw new BadRequestException(resolved.blocked);

    const branchName = conversation.store?.name ?? (await this.businessName(user.organisationId));
    const values = resolveVariables(resolved.mappings, {
      name: conversation.party?.name ?? null,
      branchName,
    });

    /*
     * A marketing template is sent AS marketing, whatever the chip is used for.
     *
     * Purpose is what makes the consent rules apply, and Meta's own category is
     * the only honest reading of what a template is. Sending an offer template
     * as `service` because it was pressed inside a support conversation would
     * walk a marketing message straight past recorded consent.
     */
    const purpose = resolved.category === 'marketing' ? 'marketing' : 'service';

    const queued = await this.omnichannel.queue(user, conversationId, {
      purpose,
      templateAssetId: row.templateAssetId,
      templateComponents: templateComponentsFor(values),
    });
    return {
      messageId: queued.message.id,
      status: queued.message.status,
      label: row.label,
      sentText: previewWithValues(resolved.bodyPreview, resolved.mappings, {
        customerName: conversation.party?.name ?? null,
        branchName,
      }),
    };
  }

  /* ------------------------------------------------------------- the managing */

  /** Every reply this manager can see, retired ones included. */
  async list(user: AuthUser): Promise<{
    rows: QuickReplyRow[];
    placeholders: typeof QUICK_REPLY_PLACEHOLDERS;
    canWriteEveryBranch: boolean;
  }> {
    const rows = await this.prisma.quickReply.findMany({
      where: {
        ...this.scope.orgFilter(user),
        // A manager sees their own branches' replies and the shared ones. Head
        // office's storeIds is every branch of the organisation, so this is the
        // whole list for them.
        OR: [{ storeId: null }, { storeId: { in: user.storeIds } }],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const [templates, stores] = await Promise.all([
      this.resolveTemplates(
        user.organisationId,
        rows.map((r) => r.templateAssetId),
      ),
      this.prisma.store.findMany({
        where: { ...this.scope.orgFilter(user) },
        select: { id: true, name: true },
      }),
    ]);
    const storeName = new Map(stores.map((s) => [s.id, s.name]));

    return {
      rows: rows.map((row) => {
        const resolved = row.templateAssetId ? templates.get(row.templateAssetId) : undefined;
        return {
          id: row.id,
          label: row.label,
          kind: row.kind as QuickReplyKind,
          body: row.body,
          templateAssetId: row.templateAssetId,
          templateName: resolved?.name ?? null,
          storeId: row.storeId,
          storeName: row.storeId ? (storeName.get(row.storeId) ?? null) : null,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
          warning: this.warningFor(row, resolved),
        };
      }),
      placeholders: QUICK_REPLY_PLACEHOLDERS,
      canWriteEveryBranch: user.role === 'head_office',
    };
  }

  async create(user: AuthUser, dto: CreateQuickReplyDto): Promise<QuickReplyRow> {
    this.assertScope(user, dto.storeId ?? null);
    const { body, templateAssetId } = await this.readContent(user, dto.kind, dto);

    const existing = await this.prisma.quickReply.count({ where: this.scope.orgFilter(user) });
    if (existing >= QUICK_REPLIES_PER_TENANT_MAX) {
      throw new BadRequestException(
        `This business already has ${QUICK_REPLIES_PER_TENANT_MAX} quick replies. ` +
          'Delete one before adding another.',
      );
    }

    const row = await this.prisma.quickReply.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId ?? null,
        label: dto.label.trim(),
        kind: dto.kind,
        body,
        templateAssetId,
        // New ones land at the end, where somebody who has arranged the row
        // expects to find them, and can be dragged from there.
        sortOrder: existing,
        createdById: user.id,
      },
    });
    return this.one(user, row.id);
  }

  async update(user: AuthUser, id: string, dto: UpdateQuickReplyDto): Promise<QuickReplyRow> {
    const current = await this.mustReach(user, id);
    // Both ends of a move: a manager may not take a branch reply away from
    // another branch, nor hand their own to every branch.
    this.assertScope(user, current.storeId);
    if ('storeId' in dto) this.assertScope(user, dto.storeId ?? null);

    /*
     * `Unchecked`, because `storeId` is written as the plain column it is. The
     * checked input offers `store: { connect | disconnect }` instead, and
     * moving a reply to every branch is a disconnect — two shapes for one
     * assignment, on the field that is also the permission boundary.
     */
    const data: Prisma.QuickReplyUncheckedUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label.trim();
    if ('storeId' in dto) data.storeId = dto.storeId ?? null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    const kind = (dto.kind ?? current.kind) as QuickReplyKind;
    if (dto.kind !== undefined || dto.body !== undefined || dto.templateAssetId !== undefined) {
      const { body, templateAssetId } = await this.readContent(user, kind, {
        body: dto.body ?? (dto.kind && dto.kind !== current.kind ? undefined : (current.body ?? undefined)),
        templateAssetId:
          dto.templateAssetId ??
          (dto.kind && dto.kind !== current.kind ? undefined : (current.templateAssetId ?? undefined)),
      });
      data.kind = kind;
      data.body = body;
      data.templateAssetId = templateAssetId;
    }

    await this.prisma.quickReply.update({ where: { id }, data });
    return this.one(user, id);
  }

  /**
   * Delete, not retire.
   *
   * The opposite of a lead tag, and for a clear reason: a tag somebody applied
   * is a record of what they thought at the time, while a quick reply is only a
   * shortcut. Nothing references it after the message has been sent — the
   * message carries its own words — so keeping a deleted shortcut around would
   * add a row to a settings screen and nothing else. `isActive` still exists
   * for switching one off for a season without losing the wording.
   */
  async remove(user: AuthUser, id: string): Promise<{ deleted: true; label: string }> {
    const row = await this.mustReach(user, id);
    this.assertScope(user, row.storeId);
    await this.prisma.quickReply.delete({ where: { id } });
    return { deleted: true, label: row.label };
  }

  /** The order the chip row reads in, as the screen arranged it. */
  async reorder(user: AuthUser, ids: string[]): Promise<QuickReplyRow[]> {
    const wanted = [...new Set(ids)];
    const rows = await this.prisma.quickReply.findMany({
      where: { id: { in: wanted }, ...this.scope.orgFilter(user) },
      select: { id: true, storeId: true },
    });
    if (rows.length !== wanted.length) {
      throw new NotFoundException('One of those quick replies no longer exists.');
    }
    for (const row of rows) this.assertScope(user, row.storeId);

    await this.prisma.$transaction(
      wanted.map((id, index) =>
        this.prisma.quickReply.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    return (await this.list(user)).rows;
  }

  /* -------------------------------------------------------------- the plumbing */

  private async one(user: AuthUser, id: string): Promise<QuickReplyRow> {
    const row = (await this.list(user)).rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException('Quick reply not found.');
    return row;
  }

  /**
   * What `{branch}` falls back to on a thread with no branch.
   *
   * The business's own name, which is precisely what the hardcoded chip did
   * (`conversation.store?.name ?? TENANT_NAME`). An ad click nobody has routed
   * yet has no branch, and "Our showroom is open" reading as "Our our showroom
   * is open" would be a regression dressed as a refactor. The pure stand-in in
   * quick-replies.ts is the last line of defence beneath this, for a tenant
   * whose name cannot be read at all.
   */
  private async businessName(organisationId: string): Promise<string | null> {
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { name: true },
    });
    return organisation?.name ?? null;
  }

  /** Fail as "not found" for another tenant's row, never as "forbidden". */
  private async mustReach(user: AuthUser, id: string) {
    const row = await this.prisma.quickReply.findFirst({
      where: { id, ...this.scope.orgFilter(user) },
    });
    if (!row) throw new NotFoundException('Quick reply not found.');
    return row;
  }

  /**
   * May this person write a reply at this scope?
   *
   * The one real permission decision in the feature. `null` — every branch —
   * is head office's, because it rewords what all eleven branches see. A
   * concrete branch goes through the ordinary store-scope check, so a manager
   * writes for the shops they run and no others.
   */
  private assertScope(user: AuthUser, storeId: string | null): void {
    if (storeId === null) {
      if (user.role !== 'head_office') {
        throw new ForbiddenException(
          'A quick reply for every branch is head office’s to set. Choose your own branch, ' +
            'or ask head office to add it for everybody.',
        );
      }
      return;
    }
    this.scope.assertStoreAllowed(user, storeId);
  }

  /**
   * The content half of a save, checked against the kind that was chosen.
   *
   * Phrased as sentences rather than validator names because this is where
   * somebody finds out they have picked "template" and typed words, which is
   * the single most likely mistake on the screen.
   */
  private async readContent(
    user: AuthUser,
    kind: QuickReplyKind,
    input: { body?: string; templateAssetId?: string },
  ): Promise<{ body: string | null; templateAssetId: string | null }> {
    if (kind === 'free_text') {
      const body = input.body?.trim();
      if (!body) throw new BadRequestException('Type the words this quick reply should send.');
      const unknown = unknownPlaceholders(body);
      if (unknown.length) {
        throw new BadRequestException(
          `There is nothing to put in ${unknown.map((t) => `{${t}}`).join(', ')}. ` +
            `You can use ${QUICK_REPLY_PLACEHOLDERS.map((p) => `{${p.token}}`).join(', ')}.`,
        );
      }
      return { body, templateAssetId: null };
    }

    const assetId = input.templateAssetId;
    if (!assetId) {
      throw new BadRequestException(
        'Choose the approved template this quick reply should send. ' +
          'A template is what reaches somebody more than 24 hours after they last wrote.',
      );
    }
    const resolved = (await this.resolveTemplates(user.organisationId, [assetId])).get(assetId);
    if (!resolved) {
      throw new BadRequestException('That template is not on this account.');
    }
    /*
     * A template that cannot be sent today is still SAVED.
     *
     * Approval is Meta's to give and arrives hours later; refusing the save
     * would mean the client could not set a quick reply up until the moment it
     * happened to be approved. The row is stored with its warning showing on
     * this screen, and the chip simply does not appear in the inbox until the
     * template is genuinely sendable.
     */
    return { body: null, templateAssetId: assetId };
  }

  /** The sentence the management screen shows against a row, or null. */
  private warningFor(
    row: { kind: string; body: string | null; templateAssetId: string | null },
    resolved: ResolvedTemplate | undefined,
  ): string | null {
    if (row.kind === 'free_text') {
      return row.body ? null : 'This quick reply has no words in it, so it is not offered.';
    }
    if (!row.templateAssetId) return 'No template is chosen, so this is not offered.';
    if (!resolved) {
      return 'The template this used is no longer on this account. Choose another one.';
    }
    return resolved.blocked;
  }

  /**
   * Everything a stored template id has to answer before a chip is offered.
   *
   * One query for the whole list. The verdict is the provider's and its age
   * counts — `templateSendability` is the same function
   * `OmnichannelService.queue` applies at send time, so a chip is never offered
   * for a template the send path would then refuse. The only thing added on top
   * is whether the variables can be filled at all: a template with `{{1}}` and
   * no stored default for it would be queued and rejected per recipient, which
   * from the inbox looks exactly like nothing happening.
   */
  private async resolveTemplates(
    organisationId: string,
    ids: (string | null)[],
  ): Promise<Map<string, ResolvedTemplate>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map();

    const assets = await this.prisma.integrationAsset.findMany({
      where: {
        id: { in: wanted },
        organisationId,
        kind: TEMPLATE_ASSET_KIND,
        integration: { providerCode: 'whatsapp_cloud' },
      },
      select: {
        id: true,
        name: true,
        externalId: true,
        isActive: true,
        lastVerifiedAt: true,
        metadata: true,
      },
    });

    const out = new Map<string, ResolvedTemplate>();
    for (const asset of assets) {
      const raw = (asset.metadata ?? {}) as Record<string, unknown>;
      const verdict = templateSendability({
        isActive: asset.isActive,
        providerStatus: providerTemplateStatus(raw.providerStatus),
        providerSyncedAt: asset.lastVerifiedAt ?? null,
      });
      const bodyPreview =
        typeof raw.bodySource === 'string'
          ? raw.bodySource
          : typeof raw.bodyPreview === 'string'
            ? raw.bodyPreview
            : '';
      const slots = Array.isArray(raw.variables)
        ? raw.variables.length
        : variableSlotsIn(bodyPreview);

      let mappings: VariableMapping[] = [];
      let blocked = verdict.sendable ? null : verdict.reason;
      try {
        mappings = parseVariableMappings(variableDefaultsFrom(raw.variableDefaults), slots);
      } catch (error) {
        if (!(error instanceof CampaignVariableError)) throw error;
        blocked =
          blocked ??
          'This template has variables with nothing filling them. Set what each one should ' +
            'contain on the Message Templates screen, then it can be sent from here.';
      }

      out.set(asset.id, {
        assetId: asset.id,
        name: asset.name ?? asset.externalId,
        blocked,
        mappings,
        bodyPreview,
        category: typeof raw.category === 'string' ? raw.category : 'utility',
      });
    }
    return out;
  }
}

/** A manager, for the "you can edit these" hint the inbox shows. */
function isManager(user: AuthUser): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
}

/**
 * The template's body with its real values in it, for the chip's tooltip and
 * the "sent" toast.
 *
 * What a salesperson needs to know before pressing a chip is what the customer
 * will read, and `{{1}}` tells them nothing. The substitution is display only —
 * the send carries the same values as provider parameters, built from the same
 * mappings — so the two cannot drift.
 */
function previewWithValues(
  bodyPreview: string,
  mappings: VariableMapping[],
  subject: { customerName?: string | null; branchName?: string | null },
): string {
  if (!bodyPreview) return '';
  const values = resolveVariables(mappings, {
    name: subject.customerName ?? null,
    branchName: subject.branchName ?? null,
  });
  return bodyPreview.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => {
    const value = values[Number(n) - 1];
    return value ?? whole;
  });
}
