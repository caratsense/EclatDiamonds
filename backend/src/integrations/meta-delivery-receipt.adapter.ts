import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { OmnichannelService } from '../omnichannel/omnichannel.service';
import type {
  MetaDeliveryReceipt,
  MetaDeliveryReceiptSink,
  MetaReceiptOwner,
} from './meta-contracts';
import { MetaWebhookService } from './meta-webhook.service';

/**
 * Joins the Meta webhook to the omnichannel outbox.
 *
 * Both halves of this seam already existed and neither knew about the other:
 * `MetaWebhookService` parsed WhatsApp status events into `MetaDeliveryReceipt`s
 * and handed them to a sink that was never registered, while
 * `OmnichannelService.applyDeliveryReceipt` — the method the outbox needs in
 * order to ever leave `sent` — had no callers anywhere in the tree. Receipts
 * were parsed and dropped, so no message could reach delivered or read and a
 * provider-reported failure never surfaced in the outbox.
 *
 * This adapter is deliberately thin. It maps the provider vocabulary onto the
 * outbox vocabulary and does nothing else: no tenant lookup (the webhook
 * resolves that from an asset it owns, and passes it in), no policy, no
 * writes of its own.
 */
@Injectable()
export class MetaDeliveryReceiptAdapter implements MetaDeliveryReceiptSink, OnModuleInit {
  private readonly logger = new Logger(MetaDeliveryReceiptAdapter.name);

  constructor(
    private readonly webhook: MetaWebhookService,
    private readonly omnichannel: OmnichannelService,
  ) {}

  onModuleInit(): void {
    this.webhook.registerDeliveryReceiptSink(this);
  }

  async acceptMetaDeliveryReceipt(
    receipt: MetaDeliveryReceipt,
    owner: MetaReceiptOwner,
  ): Promise<void> {
    // 'unknown' is what the extractor returns for a status string Meta added
    // after this code was written. Guessing a state for it would be worse than
    // ignoring it: the outbox would show a movement the provider never reported.
    if (receipt.status === 'unknown') return;
    if (!receipt.externalMessageId) return;

    const result = await this.omnichannel.applyDeliveryReceipt({
      organisationId: owner.organisationId,
      providerMessageId: receipt.externalMessageId,
      status: receipt.status,
      occurredAt: receipt.occurredAt ?? undefined,
      // Codes only. The extractor keeps Meta's human-readable title and any echoed
      // message body out of this field, and the outbox redacts what it stores, so
      // no customer content reaches the message row or the log line below.
      error:
        receipt.status === 'failed' && receipt.providerErrorCodes.length
          ? `Provider error ${receipt.providerErrorCodes.join(', ')}`
          : undefined,
    });

    // A receipt for a message we never sent is normal — the same WhatsApp number
    // can be used by the bot or by a person in the Meta console — so this is not
    // an error. It is logged without the recipient's phone number.
    if (!result.matched) {
      this.logger.debug(
        `Delivery receipt for an unknown provider message id (org ${owner.organisationId}).`,
      );
    }
  }
}
