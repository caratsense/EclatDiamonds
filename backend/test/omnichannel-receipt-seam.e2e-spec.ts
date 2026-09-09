import { MetaDeliveryReceiptAdapter } from '../src/integrations/meta-delivery-receipt.adapter';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import type { MetaDeliveryReceipt, MetaReceiptOwner } from '../src/integrations/meta-contracts';
import type { MetaWebhookService } from '../src/integrations/meta-webhook.service';

/**
 * The seam between the Meta webhook and the omnichannel outbox.
 *
 * Both halves shipped without the join: `MetaWebhookService` parsed WhatsApp
 * status events and handed them to a sink nobody registered, and
 * `OmnichannelService.applyDeliveryReceipt` had zero callers in the tree. The
 * observable effect was that no outbound message could ever leave `sent` — not
 * to delivered, not to read, and a provider-reported failure never appeared in
 * the outbox at all.
 *
 * These tests pin the join itself and the two rules that make it safe to cross:
 * the tenant comes from the caller (resolved from an asset we own) and never
 * from the provider payload, and an unrecognised status is dropped rather than
 * guessed.
 */

const receipt = (over: Partial<MetaDeliveryReceipt> = {}): MetaDeliveryReceipt => ({
  provider: 'whatsapp_cloud',
  externalMessageId: 'wamid.TEST1',
  recipientId: '919999999999',
  status: 'delivered',
  occurredAt: new Date('2026-09-09T12:00:00.000Z'),
  conversationId: null,
  pricingCategory: null,
  providerErrorCodes: [],
  ...over,
});

const OWNER: MetaReceiptOwner = { organisationId: 'org-a', integrationId: 'int-1' };

function makeAdapter() {
  const applied: Parameters<OmnichannelService['applyDeliveryReceipt']>[0][] = [];
  const omnichannel = {
    applyDeliveryReceipt: async (input: Parameters<OmnichannelService['applyDeliveryReceipt']>[0]) => {
      applied.push(input);
      return { matched: true, updated: true, messageId: 'm1', status: input.status };
    },
  } as unknown as OmnichannelService;

  let registered: unknown = null;
  const webhook = {
    registerDeliveryReceiptSink: (sink: unknown) => {
      registered = sink;
    },
  } as unknown as MetaWebhookService;

  const adapter = new MetaDeliveryReceiptAdapter(webhook, omnichannel);
  return { adapter, applied, registered: () => registered };
}

describe('meta delivery receipt seam', () => {
  it('registers itself with the webhook on init — the step that was missing', () => {
    const { adapter, registered } = makeAdapter();
    expect(registered()).toBeNull();
    adapter.onModuleInit();
    expect(registered()).toBe(adapter);
  });

  it('forwards a delivered receipt to the outbox', async () => {
    const { adapter, applied } = makeAdapter();
    await adapter.acceptMetaDeliveryReceipt(receipt(), OWNER);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      organisationId: 'org-a',
      providerMessageId: 'wamid.TEST1',
      status: 'delivered',
    });
  });

  it('takes the tenant from the resolved owner, never from the payload', async () => {
    const { adapter, applied } = makeAdapter();
    // A hostile or merely wrong payload cannot redirect the receipt: the
    // organisation is a separate argument the webhook resolves from a phone
    // number id it owns.
    await adapter.acceptMetaDeliveryReceipt(
      receipt({ recipientId: 'org-b', conversationId: 'org-b' }),
      OWNER,
    );
    expect(applied[0].organisationId).toBe('org-a');
  });

  it('drops a status it does not recognise instead of inventing one', async () => {
    const { adapter, applied } = makeAdapter();
    await adapter.acceptMetaDeliveryReceipt(receipt({ status: 'unknown' }), OWNER);
    expect(applied).toHaveLength(0);
  });

  it('drops a receipt with no provider message id', async () => {
    const { adapter, applied } = makeAdapter();
    await adapter.acceptMetaDeliveryReceipt(receipt({ externalMessageId: '' }), OWNER);
    expect(applied).toHaveLength(0);
  });

  it('passes provider error CODES only, never a customer-visible string', async () => {
    const { adapter, applied } = makeAdapter();
    await adapter.acceptMetaDeliveryReceipt(
      receipt({ status: 'failed', providerErrorCodes: ['131047', '470'] }),
      OWNER,
    );
    expect(applied[0].error).toBe('Provider error 131047, 470');
    expect(applied[0].error).not.toMatch(/9199|wamid/);
  });

  it('sends no error string for a non-failed receipt', async () => {
    const { adapter, applied } = makeAdapter();
    await adapter.acceptMetaDeliveryReceipt(receipt({ status: 'read' }), OWNER);
    expect(applied[0].error).toBeUndefined();
  });

  it('tolerates a receipt for a message this tenant never sent', async () => {
    const applied: unknown[] = [];
    const omnichannel = {
      applyDeliveryReceipt: async (input: unknown) => {
        applied.push(input);
        return { matched: false, updated: false };
      },
    } as unknown as OmnichannelService;
    const webhook = { registerDeliveryReceiptSink: () => {} } as unknown as MetaWebhookService;
    const adapter = new MetaDeliveryReceiptAdapter(webhook, omnichannel);
    // The same WhatsApp number can be used by the Meta console; an unmatched
    // receipt is normal traffic, not an error to throw on.
    await expect(adapter.acceptMetaDeliveryReceipt(receipt(), OWNER)).resolves.toBeUndefined();
    expect(applied).toHaveLength(1);
  });
});
