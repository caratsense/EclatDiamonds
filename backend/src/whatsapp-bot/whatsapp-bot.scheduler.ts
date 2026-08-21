import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobRunnerService } from '../scheduler/job-runner.service';
import { WhatsAppBotService } from './whatsapp-bot.service';

/**
 * Safety net for inbound processing.
 *
 * The webhook already kicks off processing the moment a message lands, so this is
 * not the normal path — it exists for what that pass can miss: a crash between
 * storing and handling, or a transient failure worth another attempt. Runs through
 * {@link JobRunnerService} for the same reason the other jobs do: `@Cron` fires in
 * every replica, and only one of them should sweep.
 */
@Injectable()
export class WhatsAppBotScheduler {
  private readonly logger = new Logger(WhatsAppBotScheduler.name);

  constructor(
    private readonly bot: WhatsAppBotService,
    private readonly runner: JobRunnerService,
    private readonly config: ConfigService,
  ) {}

  /** Shares SCHEDULER_ENABLED with the other jobs, so a clone can silence everything at once. */
  private get enabled(): boolean {
    return (this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') !== 'false';
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'whatsapp.process-pending' })
  async sweep(): Promise<void> {
    if (!this.enabled) return;

    // One sweep per 5-minute bucket, whichever instance gets there first.
    const bucket = Math.floor(Date.now() / (5 * 60_000));
    const result = await this.runner.runOnce(
      'whatsapp.process-pending',
      'global',
      `bucket-${bucket}`,
      () => this.bot.processPending(),
    );
    if (result && (result.processed > 0 || result.failed > 0)) {
      this.logger.log(`swept: ${JSON.stringify(result)}`);
    }
  }
}
