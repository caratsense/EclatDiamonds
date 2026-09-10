import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LeadSource } from '@prisma/client';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { IdentityService } from './identity.service';
import { LeadIntakeService } from './lead-intake.service';
import type { CreateLeadFormDto, SubmitLeadFormDto, UpdateLeadFormDto } from './dto/lead-forms.dto';

/** What a visitor's browser is allowed to learn about a form before submitting. */
export interface PublicLeadFormView {
  name: string;
  /** Pre-fills the enquiry box, so the visitor can leave it alone. */
  defaultInterest: string | null;
  /** Whether the enquiry box may be left empty and still produce a useful lead. */
  interestOptional: boolean;
}

/**
 * Lead-capture forms a tenant embeds on its own website.
 *
 * The public half is the only anonymous write in the CRM besides QR capture, and
 * it is modelled on it deliberately: the tenant and branch come from a
 * server-side record found by an unguessable key, never from anything in the
 * request body. A caller cannot name the organisation it wants to file into.
 */
@Injectable()
export class LeadFormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly intake: LeadIntakeService,
  ) {}

  /* ------------------------------------------------------------- admin side */

  async list(user: AuthUser) {
    const forms = await this.prisma.leadForm.findMany({
      /*
       * Branch-scoped, like every other operation on this model.
       *
       * `create` and `update` both call `assertStoreAllowed`; this one filtered
       * on organisation alone, so a manager assigned only to Branch A received
       * every branch's forms INCLUDING their `publicKey` — which this file
       * elsewhere describes as a capability: anyone holding it can file leads
       * into that branch. Reading a list is not supposed to hand out authority
       * the caller does not otherwise have.
       */
      where: { organisationId: user.organisationId, ...this.scope.storeFilter(user) },
      orderBy: { createdAt: 'desc' },
      // Bounded. Unbounded plus unfiltered is how one tenant's list becomes a
      // response nobody can render.
      take: 200,
      select: {
        id: true, publicKey: true, name: true, storeId: true, defaultInterest: true,
        campaign: true, allowedOrigins: true, enabled: true, createdAt: true,
        store: { select: { name: true } },
      },
    });
    return forms.map((f) => ({
      ...f,
      storeName: f.store.name,
      store: undefined,
      submitPath: `/enquiry/${f.publicKey}`,
    }));
  }

  async create(user: AuthUser, dto: CreateLeadFormDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const store = await this.prisma.store.findFirst({
      where: { id: dto.storeId, organisationId: user.organisationId, isAggregate: false },
      select: { id: true, name: true },
    });
    if (!store) throw new BadRequestException('Choose a branch that belongs to this organisation.');

    const form = await this.prisma.leadForm.create({
      data: {
        organisationId: user.organisationId,
        // 32 unguessable characters. This is a capability: anyone holding it can
        // file leads into this branch, so it is generated, never chosen.
        publicKey: randomBytes(24).toString('base64url'),
        name: dto.name.trim(),
        storeId: store.id,
        defaultInterest: dto.defaultInterest?.trim() || null,
        campaign: dto.campaign?.trim() || null,
        allowedOrigins: normaliseOrigins(dto.allowedOrigins),
        createdById: user.id,
      },
      select: { id: true, publicKey: true, name: true, enabled: true },
    });

    await this.audit.record(user, {
      action: 'crm.lead_form_created',
      entityType: 'LeadForm',
      entityId: form.id,
      storeId: store.id,
      summary: `Created the website enquiry form "${form.name}" for ${store.name}.`,
      // The key itself is never written to the audit trail; it is a credential.
      metadata: { storeId: store.id, campaign: dto.campaign ?? null },
    });

    return { ...form, submitPath: `/enquiry/${form.publicKey}` };
  }

  async update(user: AuthUser, id: string, dto: UpdateLeadFormDto) {
    const form = await this.prisma.leadForm.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, name: true, storeId: true, enabled: true },
    });
    if (!form) throw new NotFoundException('Form not found');
    this.scope.assertStoreAllowed(user, form.storeId);

    if (dto.storeId) {
      this.scope.assertStoreAllowed(user, dto.storeId);
      const target = await this.prisma.store.findFirst({
        where: { id: dto.storeId, organisationId: user.organisationId, isAggregate: false },
        select: { id: true },
      });
      if (!target) throw new BadRequestException('Choose a branch that belongs to this organisation.');
    }

    const updated = await this.prisma.leadForm.update({
      where: { id: form.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.storeId !== undefined ? { storeId: dto.storeId } : {}),
        ...(dto.defaultInterest !== undefined ? { defaultInterest: dto.defaultInterest?.trim() || null } : {}),
        ...(dto.campaign !== undefined ? { campaign: dto.campaign?.trim() || null } : {}),
        ...(dto.allowedOrigins !== undefined ? { allowedOrigins: normaliseOrigins(dto.allowedOrigins) } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
      select: { id: true, publicKey: true, name: true, enabled: true, storeId: true },
    });

    await this.audit.record(user, {
      action: dto.enabled === false ? 'crm.lead_form_disabled' : 'crm.lead_form_updated',
      entityType: 'LeadForm',
      entityId: updated.id,
      storeId: updated.storeId,
      summary:
        dto.enabled === false
          ? `Turned off the website enquiry form "${updated.name}".`
          : `Updated the website enquiry form "${updated.name}".`,
      metadata: { enabled: updated.enabled },
    });

    return { ...updated, submitPath: `/enquiry/${updated.publicKey}` };
  }

  /* ------------------------------------------------------------ public side */

  /**
   * What the embedded page may read before anyone types anything.
   *
   * A disabled form and a key that never existed return the SAME refusal, so
   * probing keys cannot tell a real tenant from a typo.
   */
  async publicView(publicKey: string): Promise<PublicLeadFormView> {
    const form = await this.loadPublic(publicKey);
    return {
      name: form.name,
      defaultInterest: form.defaultInterest,
      interestOptional: Boolean(form.defaultInterest),
    };
  }

  async submit(publicKey: string, dto: SubmitLeadFormDto, origin: string | undefined) {
    const form = await this.loadPublic(publicKey);

    // Origin allow-list, when the tenant configured one. Absent Origin headers
    // are accepted: server-side and non-browser submissions legitimately have
    // none, and refusing them would break the form the moment a tenant proxies
    // it. The allow-list narrows browsers, it is not an authentication boundary
    // — the key is.
    const allowed = Array.isArray(form.allowedOrigins) ? (form.allowedOrigins as string[]) : [];
    if (allowed.length && origin && !allowed.includes(origin)) {
      throw new BadRequestException('This form cannot be submitted from this website.');
    }

    if (!dto.phone && !dto.email) {
      throw new BadRequestException('Leave a phone number or an email address so we can reply.');
    }
    if (dto.phone && !this.identity.normalize('phone', dto.phone, form.organisation.country)) {
      throw new BadRequestException('Enter a valid phone number including its country code when required.');
    }
    if (dto.email && !this.identity.normalize('email', dto.email, form.organisation.country)) {
      throw new BadRequestException('Enter a valid email address.');
    }

    const interest = dto.interest?.trim() || form.defaultInterest;
    if (!interest) throw new BadRequestException('Tell us what you are interested in.');

    const result = await this.intake.capture({
      organisationId: form.organisationId,
      storeId: form.storeId,
      // Scoped to the form so two forms cannot collide on a client-generated id.
      originKey: `web_form:${form.id}:${dto.submissionId}`,
      customerName: dto.customerName.trim(),
      phone: dto.phone?.trim() ?? null,
      email: dto.email?.trim() ?? null,
      interest,
      source: LeadSource.website,
      identitySource: 'web_form',
      summary: 'A visitor submitted an enquiry through a website form.',
      auditAction: 'crm.lead_captured_from_web_form',
      systemActor: 'web_form_capture',
      followUpNote: 'Website enquiry follow-up',
      // No name, phone, email or enquiry text. The form id identifies which form
      // produced the lead; the lead itself holds the customer's details.
      metadata: { leadFormId: form.id, campaign: form.campaign ?? null, consent: true },
    });

    // The visitor is told their reference and nothing about the tenant's setup.
    return {
      accepted: result.accepted,
      duplicate: result.duplicate,
      reference: result.reference,
    };
  }

  private async loadPublic(publicKey: string) {
    const form = await this.prisma.leadForm.findFirst({
      where: {
        publicKey,
        enabled: true,
        // A suspended or cancelled tenant's forms stop accepting enquiries, the
        // same way its people stop being able to sign in.
        organisation: { status: { in: ['active', 'onboarding'] } },
      },
      select: {
        id: true, organisationId: true, storeId: true, name: true,
        defaultInterest: true, campaign: true, allowedOrigins: true,
        organisation: { select: { country: true } },
      },
    });
    if (!form) throw new NotFoundException('This enquiry form is no longer available.');
    return form;
  }
}

/** Trim, drop blanks, and keep only well-formed origins. */
function normaliseOrigins(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      out.push(url.origin);
    } catch {
      throw new BadRequestException(`"${trimmed}" is not a valid website address.`);
    }
  }
  return out;
}
