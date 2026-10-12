/**
 * Reading and writing the words the customer bot says.
 *
 * The wording lives in `Organisation.settings.botScript` as a sparse set of
 * overrides. See `whatsapp-bot/bot-script.ts` for why it is sparse and what is
 * deliberately not editable — this file is only the storage and the audit trail
 * around it.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import type { AuthUser } from '../common/auth-user';
import { updateOrgSettings } from '../config/org-settings';
import {
  AI_CONTEXT_MAX,
  AI_GUARDRAILS_MAX,
  FIRST_REPLY_MAX,
  normaliseCampaignQuestions,
  type CampaignQuestion,
} from './adset-rules.service';
import {
  describeBotScript,
  resolveBotScript,
  validateBotScript,
  type BotScript,
} from '../whatsapp-bot/bot-script';

@Injectable()
export class BotScriptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async read(organisationId: string): Promise<BotScript> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    return resolveBotScript(settings.botScript);
  }

  /**
   * The DEFAULT conversation (client, 12 Oct): the walk-in script, in the same
   * shape as a campaign's — first reply, free-text questions, a brief — used
   * when a customer writes in from NO advertisement. Once enabled it replaces
   * the fixed button questionnaire for this tenant; left off, the legacy
   * questionnaire keeps running exactly as before.
   *
   * Stored in Organisation.settings.customerBotDefault, beside botScript (the
   * legacy wording overrides) and crmAdSetRules (the campaigns).
   */
  async defaultConversation(user: AuthUser): Promise<DefaultConversation> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: user.organisationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    return normaliseDefaultConversation(settings.customerBotDefault);
  }

  async saveDefaultConversation(user: AuthUser, input: unknown): Promise<DefaultConversation> {
    const next = normaliseDefaultConversation(input);
    if (next.enabled && !next.firstReply) {
      throw new BadRequestException(
        'An enabled walk-in conversation needs its first reply — that is the message every new customer gets.',
      );
    }
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings,
      customerBotDefault: next as unknown as Record<string, unknown>,
    }));
    await this.audit.record(user, {
      action: 'crm.bot_default_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: next.enabled
        ? 'Walk-in conversation enabled — free text, no questionnaire'
        : 'Walk-in conversation disabled — the questionnaire runs',
      metadata: { enabled: next.enabled, questions: next.questions.length },
    });
    return next;
  }

  /** The script as the editing screen needs it: defaults beside overrides. */
  async describe(user: AuthUser) {
    return describeBotScript(await this.read(user.organisationId));
  }

  /**
   * Replace the overrides.
   *
   * The whole script is sent each time rather than patched field by field,
   * because "clear this box to go back to the default" has to be expressible —
   * and with a patch it is indistinguishable from "leave this field alone".
   * `resolveBotScript` drops blanks, so a cleared box simply stops being an
   * override.
   */
  async save(user: AuthUser, input: unknown): Promise<ReturnType<typeof describeBotScript>> {
    const script = resolveBotScript(input);

    const problems = validateBotScript(script);
    if (problems.length) {
      // Named fields, so the screen can point at the box rather than make
      // somebody hunt for which answer was too long.
      throw new BadRequestException({
        message: problems.map((p) => p.message).join(' '),
        problems,
      });
    }

    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings,
      botScript: script as unknown as Record<string, unknown>,
    }));

    const changed = [
      script.greeting === false ? 'greeting switched off' : null,
      script.intro ? 'opening line' : null,
      script.introHint ? 'opening hint' : null,
      ...Object.keys(script.steps ?? {}),
    ].filter(Boolean);

    await this.audit.record(user, {
      action: 'crm.bot_script_updated',
      entityType: 'Organisation',
      entityId: user.organisationId,
      summary: changed.length
        ? `Reworded the customer bot: ${changed.join(', ')}`
        : 'Reset the customer bot to its default wording',
      metadata: { changed },
    });

    return describeBotScript(script);
  }
}

/** The walk-in conversation, same anatomy as a campaign script, no matching. */
export interface DefaultConversation {
  enabled: boolean;
  firstReply: string | null;
  questions: CampaignQuestion[];
  aiContext: string | null;
  aiGuardrails: string | null;
  /** Off: the first reply still sends; the next message goes to a person. */
  aiReplies: boolean;
}

export function normaliseDefaultConversation(value: unknown): DefaultConversation {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  return {
    enabled: raw.enabled === true,
    firstReply: text(raw.firstReply, FIRST_REPLY_MAX),
    questions: normaliseCampaignQuestions(raw.questions),
    aiContext: text(raw.aiContext, AI_CONTEXT_MAX),
    aiGuardrails: text(raw.aiGuardrails, AI_GUARDRAILS_MAX),
    aiReplies: raw.aiReplies !== false,
  };
}
