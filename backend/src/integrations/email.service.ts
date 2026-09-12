import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EmailSendResult {
  /** Accepted by the SMTP server. */
  sent: boolean;
  /** True when SMTP is not configured — the mail was logged, not sent. */
  dryRun: boolean;
  to: string;
  messageId?: string;
  error?: string;
}

/**
 * SMTP email client (nodemailer) — report delivery for Module 10 (weekly/monthly
 * rollups) and any future transactional mail. Mirrors WhatsAppService: fully
 * code-complete but gated on env. The moment SMTP_HOST/USER/PASS/FROM are set it
 * goes live; until then every send is a logged no-op (`dryRun`) that NEVER throws,
 * so the app builds + boots identically with or without SMTP configured.
 *
 * Client input still pending: the owner's email ID / mail format (see
 * docs/CLIENT-CALL-2026-07.md § Module 10). Nothing here depends on that — it
 * only decides the `to` a caller passes.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  private get host(): string {
    return this.config.get<string>('SMTP_HOST') ?? '';
  }
  private get port(): number {
    return Number(this.config.get<string>('SMTP_PORT') ?? 587);
  }
  private get user(): string {
    return this.config.get<string>('SMTP_USER') ?? '';
  }
  private get pass(): string {
    return this.config.get<string>('SMTP_PASS') ?? '';
  }
  private get from(): string {
    return this.config.get<string>('SMTP_FROM') ?? '';
  }

  /**
   * True when the SMTP credentials are configured (otherwise every send is a
   * dry-run). SMTP_PORT has a sensible default (587) so it is not part of the gate.
   */
  get enabled(): boolean {
    return Boolean(this.host && this.user && this.pass && this.from);
  }

  /** Lazily build (and reuse) the nodemailer transport. Only called when enabled. */
  private getTransport(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport({
        host: this.host,
        port: this.port,
        secure: this.port === 465, // implicit TLS on 465; STARTTLS otherwise
        auth: { user: this.user, pass: this.pass },
      });
    }
    return this.transporter;
  }

  /**
   * Send a plain-text email, optionally with files attached. No-op (logged) when
   * SMTP is not configured.
   *
   * `to` may be several addresses, comma-separated — one message with several
   * recipients rather than several messages, so a reply-all reaches the group
   * that was sent the report.
   */
  async send(
    to: string,
    subject: string,
    body: string,
    attachments?: EmailAttachment[],
  ): Promise<EmailSendResult> {
    if (!this.enabled) {
      this.logger.log(
        `[dry-run] Email → ${to}: ${subject}` +
          (attachments?.length ? ` (+${attachments.length} attachment)` : ''),
      );
      return { sent: false, dryRun: true, to };
    }
    try {
      const info = await this.getTransport().sendMail({
        from: this.from,
        to,
        subject,
        text: body,
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              })),
            }
          : {}),
      });
      return { sent: true, dryRun: false, to, messageId: info.messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Email send to ${to} failed: ${error}`);
      return { sent: false, dryRun: false, to, error };
    }
  }
}
