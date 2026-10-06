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
