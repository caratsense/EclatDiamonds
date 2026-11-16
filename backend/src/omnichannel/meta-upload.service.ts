import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Turning a picture into an asset handle Meta will accept on a TEMPLATE.
 *
 * This is not the media upload used when sending. There are two, they return
 * different things, and they are not interchangeable:
 *
 *   - `POST /{phone-number-id}/media` returns a MEDIA ID, used when SENDING an
 *     image or a template's media header. That is what WhatAppService uses.
 *   - the Resumable Upload API returns an ASSET HANDLE, and that is the only
 *     thing accepted in `example.header_handle` when a template is CREATED.
 *
 * Passing the first where the second belongs fails at Meta with a message
 * about the handle being invalid, which tells you nothing about why.
 *
 * Two hops, and the second one has a trap: the upload step authenticates with
 * `Authorization: OAuth <token>` — NOT `Bearer`. Meta's own docs say "You must
 * include the access token in the header or the call will fail", and a Bearer
 * there fails in a way that reads like a permissions problem.
 */
@Injectable()
export class MetaUploadService {
  private readonly logger = new Logger(MetaUploadService.name);

  /** What Meta accepts as a template header image. */
  static readonly SUPPORTED = ['image/jpeg', 'image/jpg', 'image/png'] as const;
  /** Meta's own cap for a template header image. */
  static readonly MAX_BYTES = 5 * 1024 * 1024;

  constructor(private readonly config: ConfigService) {}

  private get apiVersion(): string {
    return this.config.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
  }
  private get graphBase(): string {
    return this.config.get<string>('WHATSAPP_GRAPH_BASE') ?? 'https://graph.facebook.com';
  }
  /**
   * The Meta APP id, which the resumable upload is scoped to.
   *
   * Nothing else in the product needed it until now — every other call is
   * scoped to a WABA or a phone number — so it is read here and nowhere else.
   */
  private get appId(): string {
    return (this.config.get<string>('META_APP_ID') ?? '').trim();
  }

  /** Whether template images can be uploaded at all, and why not when they cannot. */
  readiness(): { ready: boolean; reason?: string } {
    if (!this.appId) {
      return {
        ready: false,
        reason:
          'META_APP_ID is not set on the server. A template image is uploaded against the Meta app, ' +
          'not the WhatsApp number, so Meta cannot be asked for a handle without it.',
      };
    }
    return { ready: true };
  }

  /**
   * Upload one picture and return its asset handle.
   *
   * The bytes never pass through any public URL: the file is posted straight
   * to Meta, and what comes back is an opaque handle that only means anything
   * inside a template submission.
   */
  async uploadTemplateImage(
    accessToken: string,
    file: { buffer: Buffer; mimeType: string; filename?: string },
  ): Promise<string> {
    const ready = this.readiness();
    if (!ready.ready) throw new BadRequestException(ready.reason);

    if (!(MetaUploadService.SUPPORTED as readonly string[]).includes(file.mimeType)) {
      throw new BadRequestException(
        `Meta accepts a JPEG or PNG as a template image; this is ${file.mimeType}.`,
      );
    }
    if (file.buffer.length > MetaUploadService.MAX_BYTES) {
      throw new BadRequestException(
        `That image is ${(file.buffer.length / 1024 / 1024).toFixed(1)} MB; Meta allows 5 MB.`,
      );
    }

    // --- 1. open a session ------------------------------------------------
    const start = new URL(`${this.graphBase}/${this.apiVersion}/${this.appId}/uploads`);
    start.searchParams.set('file_name', file.filename || 'header.jpg');
    start.searchParams.set('file_length', String(file.buffer.length));
    start.searchParams.set('file_type', file.mimeType);

    const opened = await fetch(start, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const session = (await opened.json().catch(() => null)) as
      | { id?: string; error?: { message?: string } }
      | null;
    if (!opened.ok || !session?.id) {
      throw new BadRequestException(
        `Meta refused the upload session (HTTP ${opened.status})` +
          (session?.error?.message ? `: ${session.error.message}` : ''),
      );
    }

    // --- 2. send the bytes ------------------------------------------------
    // `session.id` already carries the "upload:" prefix, so it is used whole.
    const put = await fetch(`${this.graphBase}/${this.apiVersion}/${session.id}`, {
      method: 'POST',
      headers: {
        // OAuth, not Bearer. See the class comment — this one is easy to lose
        // an afternoon to.
        authorization: `OAuth ${accessToken}`,
        file_offset: '0',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(file.buffer),
      signal: AbortSignal.timeout(60_000),
    });
    const uploaded = (await put.json().catch(() => null)) as
      | { h?: string; error?: { message?: string } }
      | null;
    if (!put.ok || !uploaded?.h) {
      throw new BadRequestException(
        `Meta refused the image (HTTP ${put.status})` +
          (uploaded?.error?.message ? `: ${uploaded.error.message}` : ''),
      );
    }

    this.logger.log(`Template image uploaded: ${file.buffer.length} bytes -> handle acquired`);
    return uploaded.h;
  }
}
