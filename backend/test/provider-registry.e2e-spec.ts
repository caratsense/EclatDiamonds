import { ConnectorRegistry } from '../src/integration/connectors/connector-registry';
import { createCipheriv } from 'node:crypto';
import { getProvider, listProviders } from '../src/integration/framework/provider-registry';
import {
  assertNonSecretIntegrationConfig,
  IntegrationsRegistryService,
  resolveState,
} from '../src/integration/framework/integrations-registry.service';
import { CredentialCrypto } from '../src/integration/framework/credential-crypto';
import { WhatsAppCredentialsService } from '../src/integrations/whatsapp-credentials.service';

describe('provider and connector registry consistency', () => {
  const connectors = new ConnectorRegistry();

  it('advertises the same profile-backed BUSY capability in both catalogues', () => {
    const provider = getProvider('busy');
    const connector = connectors.get('busy');

    expect(provider).toMatchObject({
      available: true,
      credentialScope: 'on_premise',
      entities: ['customers', 'products'],
    });
    expect(provider?.blockedReason).toBeUndefined();
    expect(connector).toMatchObject({
      status: 'connected',
      entities: ['customers', 'products'],
      fileUpload: false,
    });
    expect(connector?.capabilities.supportsCustomers).toBe(true);
    expect(connector?.capabilities.supportsProducts).toBe(true);
    expect(connector?.capabilities.supportsStock).toBe(false);
  });

  it('exposes Tally and generic ODBC only through outbound Connect agents', () => {
    const provider = getProvider('tally');
    const connector = connectors.get('tally');
    const odbcProvider = getProvider('odbc');
    const odbcConnector = connectors.get('odbc');

    expect(provider).toMatchObject({
      available: true,
      credentialScope: 'on_premise',
      entities: ['customers', 'products'],
    });
    expect(connector).toMatchObject({ status: 'connected', entities: ['customers', 'products'] });
    expect(odbcProvider).toMatchObject({ available: true, credentialScope: 'on_premise' });
    expect(odbcConnector).toMatchObject({ status: 'connected', fileUpload: false });
  });

  it('keeps the Gati provider catalogue aligned with the implemented connector', () => {
    const provider = getProvider('gati');
    const connector = connectors.get('gati');

    expect(provider?.entities).toEqual(connector?.entities);
    expect(provider?.entities).toContain('ledger');
    expect(provider?.entities).not.toContain('payments');
    expect(connector?.capabilities.supportsPayments).toBe(false);
  });

  it('advertises only the tenant WhatsApp credential the runtime actually consumes', () => {
    expect(getProvider('whatsapp_cloud')).toMatchObject({
      available: true,
      credentialScope: 'tenant',
      credentialKinds: ['access_token'],
    });
    expect(getProvider('razorpay')).toMatchObject({
      available: true,
      credentialScope: 'platform_env',
    });
  });

  /**
   * INT-04. `available: false` is not cosmetic — it makes the provider
   * unconnectable (integrations-registry.service.ts refuses to create the row),
   * so the entire Meta lane that now ships here was unreachable through the
   * product. It flips only because every piece of it exists in this repository.
   */
  it('offers Meta Ads as connectable, declaring only capabilities that ship here', () => {
    const provider = getProvider('meta_ads');

    expect(provider).toMatchObject({
      available: true,
      category: 'ads',
      credentialScope: 'tenant',
      credentialKinds: ['access_token'],
      // Lead Ads arrive by signature-verified webhook; spend is pulled from the
      // ad account. Nothing else is claimed.
      entities: ['leads', 'ad_insights'],
      webhooks: true,
    });
    // An available provider must not also carry an excuse.
    expect(provider?.blockedReason).toBeUndefined();
    // What the tenant must still bring belongs in the description they read.
    expect(provider?.description).toMatch(/leads_retrieval/);
    expect(provider?.description).toMatch(/ads_read/);
    // Industry-neutral: this is a universal integration surface.
    expect(provider?.description).not.toMatch(/jewel|gold|carat|diamond|eclat/i);
  });

  it('keeps Instagram unavailable, because no code here calls it', () => {
    const provider = getProvider('instagram');

    expect(provider?.available).toBe(false);
    expect(provider?.blockedReason).toMatch(/adapter and app review/i);
  });

  /**
   * Telephony flipped to connectable, and only as far as the inbound half goes.
   *
   * `available: false` is not cosmetic — it makes a provider unconnectable, and
   * a webhook nobody can connect returns 404 to every tenant. It flips because
   * the inbound door now exists, is authenticated per tenant, and is covered
   * end to end in telephony-webhook.e2e-spec.ts.
   *
   * What it must NOT do is let the word "telephony" imply the outbound half.
   * The description is the only thing a tenant reads before connecting, so the
   * absence is asserted there rather than trusted to stay written.
   */
  it('offers inbound telephony, and says plainly that outbound is not built', () => {
    const provider = getProvider('telephony');

    expect(provider).toMatchObject({
      available: true,
      category: 'messaging',
      credentialScope: 'tenant',
      webhooks: true,
    });
    // An available provider must not also carry an excuse.
    expect(provider?.blockedReason).toBeUndefined();
    // The name itself carries the limit, for the card that shows only a name.
    expect(provider?.name).toMatch(/inbound/i);
    expect(provider?.description).toMatch(/OUTBOUND IS NOT BUILT/);
    expect(provider?.description).toMatch(/no vendor-specific adapter/i);
    // The routing promise this whole lane rests on.
    expect(provider?.description).toMatch(/unrouted/i);
    // Universal surface: no vertical vocabulary.
    expect(provider?.description).not.toMatch(/jewel|gold|carat|diamond|eclat/i);
  });

  /**
   * Everything still unbuilt stays unbuilt.
   *
   * Pinned as a LIST rather than one case each, so that flipping any of them
   * has to be a deliberate edit to this line. Each of these would need an
   * adapter, an app review, or a commercial account that does not exist — and
   * each has been asked about often enough that "it's nearly there" is a
   * standing temptation.
   */
  it.each(['instagram', 'facebook_messenger', 'email', 'sms', 'rcs', 'google_business'])(
    'keeps %s unavailable, with a reason',
    (code) => {
      const provider = getProvider(code);
      // Named, not sampled: a code that quietly stops being registered would
      // otherwise make this assertion pass by vanishing.
      expect([code, Boolean(provider)]).toEqual([code, true]);
      if (!provider) return;
      expect([code, provider.available]).toEqual([code, false]);
      expect([code, Boolean(provider.blockedReason)]).toEqual([code, true]);
    },
  );

  it('states a blockedReason for every provider it refuses to offer', () => {
    for (const provider of listProviders()) {
      if (provider.available) {
        expect([provider.code, provider.blockedReason]).toEqual([provider.code, undefined]);
      } else {
        expect([provider.code, Boolean(provider.blockedReason)]).toEqual([
          provider.code,
          true,
        ]);
      }
    }
  });
});

describe('integration public config boundary', () => {
  it('reports a saved tenant credential as pending verification, not absent setup', () => {
    expect(
      resolveState(
        {
          status: 'not_configured',
          lastError: null,
          lastHealthAt: null,
          credentials: [{ kind: 'access_token', expiresAt: null }],
        },
        getProvider('whatsapp_cloud'),
      ),
    ).toEqual({
      state: 'configuring',
      reason: 'Credential saved; the provider connection has not been verified yet.',
    });
  });

  it.each(['clientSecret', 'api_key', 'access-token', 'nestedPassword'])(
    'rejects credential-shaped key %s from plaintext config',
    (key) => {
      expect(() =>
        assertNonSecretIntegrationConfig({ safe: { endpoint: 'https://example.test', [key]: 'do-not-store' } }),
      ).toThrow(/encrypted credentials endpoint/i);
    },
  );

  it('accepts bounded non-secret provider settings', () => {
    expect(() =>
      assertNonSecretIntegrationConfig({ endpoint: 'https://example.test', region: 'in', retries: 2 }),
    ).not.toThrow();
  });

  it.each([
    { authorization: 'Bearer tenant-secret' },
    { token: 'tenant-secret' },
    { endpoint: 'https://operator:password@example.test/path' },
    { connection: 'Server=db;UID=user;PWD=tenant-secret' },
    { kind: 'access_token', value: 'tenant-secret' },
  ])('rejects embedded or disguised credentials from plaintext config', (config) => {
    expect(() => assertNonSecretIntegrationConfig(config)).toThrow(
      /encrypted credentials endpoint/i,
    );
  });

  it.each([
    { type: 'access_token', value: 'tenant-secret' },
    { kind: 'password', content: 'tenant-secret' },
    { kind: 'access_token', secret: 'tenant-secret' },
  ])('rejects type/kind discriminator credential envelopes', (config) => {
    expect(() => assertNonSecretIntegrationConfig(config)).toThrow(
      /encrypted credentials endpoint/i,
    );
  });

  it('rejects case-insensitive duplicate keys before a discriminator can be shadowed', () => {
    expect(() =>
      assertNonSecretIntegrationConfig({
        kind: 'access_token',
        Kind: 'safe',
        value: 'tenant-secret',
      }),
    ).toThrow(/duplicate field names/i);
  });
});

describe('integration credential context binding', () => {
  const rawKey = Buffer.alloc(32, 7);
  const crypto = new CredentialCrypto({
    get: (name: string) =>
      name === 'CREDENTIAL_ENCRYPTION_KEY'
        ? rawKey.toString('base64')
        : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
          ? '3'
          : undefined,
  } as never);
  const first = {
    organisationId: 'org-a',
    integrationId: 'integration-a',
    kind: 'access_token',
  };

  it('refuses a valid ciphertext tuple when it is moved to another row context', () => {
    const sealed = crypto.encrypt('tenant-secret', first);
    const expectedFailureLog = jest
      .spyOn((crypto as unknown as { log: { error: (message: string) => void } }).log, 'error')
      .mockImplementation(() => undefined);

    expect(crypto.decrypt(sealed, first)).toBe('tenant-secret');
    expect(() =>
      crypto.decrypt(sealed, { ...first, integrationId: 'integration-b' }),
    ).toThrow(/could not be decrypted/i);
    expectedFailureLog.mockRestore();
  });

  it('continues to read a legacy unbound row so the owner can upgrade it in place', () => {
    const iv = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', rawKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update('saved-before-aad', 'utf8'),
      cipher.final(),
    ]).toString('base64');
    const legacy = {
      ciphertext,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: 3,
    };

    expect(crypto.isContextBound(legacy)).toBe(false);
    expect(crypto.decrypt(legacy, first)).toBe('saved-before-aad');
  });

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])(
    'fails closed for invalid configured key version %s',
    (version) => {
      const invalid = new CredentialCrypto({
        get: (name: string) =>
          name === 'CREDENTIAL_ENCRYPTION_KEY'
            ? rawKey.toString('base64')
            : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
              ? version
              : undefined,
      } as never);

      expect(invalid.isConfigured).toBe(false);
      expect(() => invalid.encrypt('secret', first)).toThrow(/positive integer|supported integer/i);
    },
  );
});

describe('integration credential owner rotation', () => {
  const oldKey = Buffer.alloc(32, 4);
  const activeKey = Buffer.alloc(32, 5);
  const context = {
    organisationId: 'org-a',
    integrationId: 'integration-a',
    kind: 'access_token',
  };
  const oldCrypto = new CredentialCrypto({
    get: (name: string) =>
      name === 'CREDENTIAL_ENCRYPTION_KEY'
        ? oldKey.toString('base64')
        : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
          ? '1'
          : undefined,
  } as never);
  const activeCrypto = new CredentialCrypto({
    get: (name: string) =>
      name === 'CREDENTIAL_ENCRYPTION_KEY'
        ? activeKey.toString('base64')
        : name === 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'
          ? oldKey.toString('base64')
          : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
            ? '2'
            : undefined,
  } as never);
  const owner = {
    id: 'user-a',
    name: 'Owner',
    email: 'owner@example.test',
    role: 'head_office',
    organisationId: context.organisationId,
    storeIds: [],
    allStores: true,
  } as never;

  it('stores only a consumed tenant credential and binds it to its owning row', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'credential-a' });
    const service = new IntegrationsRegistryService(
      {
        integration: {
          findFirst: jest.fn().mockResolvedValue({
            id: context.integrationId,
            organisationId: context.organisationId,
            providerCode: 'whatsapp_cloud',
            name: 'WhatsApp',
          }),
        },
        integrationCredential: { upsert },
      } as never,
      activeCrypto,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.setCredential(owner, context.integrationId, context.kind, 'tenant-token'),
    ).resolves.toMatchObject({ stored: true, kind: context.kind, keyVersion: 2 });
    const create = upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({
      organisationId: context.organisationId,
      integrationId: context.integrationId,
      kind: context.kind,
      keyVersion: 2,
    });
    expect(create.ciphertext).toMatch(/^aad1:/);
    expect(activeCrypto.decrypt(create, context)).toBe('tenant-token');
  });

  it('registers the non-secret WhatsApp phone identity needed by the sender', async () => {
    const upsert = jest.fn().mockResolvedValue({
      id: 'asset-a',
      kind: 'phone_number',
      externalId: '123456789012345',
      name: 'Main sender',
      isActive: true,
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findConflictingOwner = jest.fn().mockResolvedValue(null);
    const transaction = jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        integrationAsset: {
          findFirst: findConflictingOwner,
          updateMany,
          upsert,
        },
      }),
    );
    const service = new IntegrationsRegistryService(
      {
        integration: {
          findFirst: jest.fn().mockResolvedValue({
            id: context.integrationId,
            organisationId: context.organisationId,
            providerCode: 'whatsapp_cloud',
            name: 'WhatsApp',
          }),
        },
        $transaction: transaction,
      } as never,
      activeCrypto,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.setAsset(owner, context.integrationId, {
        kind: 'phone_number',
        externalId: '123456789012345',
        name: 'Main sender',
      }),
    ).resolves.toMatchObject({ externalId: '123456789012345', isActive: true });
    expect(findConflictingOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: 'phone_number',
          externalId: '123456789012345',
          integration: { providerCode: 'whatsapp_cloud' },
        }),
      }),
    );
    // REGISTERING NO LONGER DEACTIVATES ITS SIBLINGS.
    //
    // This used to assert the opposite: that saving a number switched every
    // other number on the connection off. That was a real simplification while a
    // tenant had one number, and a blocker for a business with eight across two
    // WABA accounts — the branches on the numbers it silently deactivated
    // started sending as somebody else and nothing said so.
    //
    // What is NOT relaxed is the unique ownership claim below, which is the
    // property that actually matters: two connections can never both own the
    // same phone-number id. Which of a tenant's own numbers a branch uses is now
    // a routing decision, where it belongs.
    expect(updateMany).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organisationId: context.organisationId,
          integrationId: context.integrationId,
          kind: 'phone_number',
          ownershipKey: 'whatsapp_cloud:phone_number:123456789012345',
        }),
      }),
    );
  });

  it('refuses registering the configured platform WhatsApp phone identity to a tenant', async () => {
    const transaction = jest.fn();
    const service = new IntegrationsRegistryService(
      {
        integration: {
          findFirst: jest.fn().mockResolvedValue({
            id: context.integrationId,
            organisationId: context.organisationId,
            providerCode: 'whatsapp_cloud',
            name: 'WhatsApp',
          }),
        },
        $transaction: transaction,
      } as never,
      activeCrypto,
      { record: jest.fn() } as never,
      {
        get: (name: string) =>
          name === 'WHATSAPP_PHONE_NUMBER_ID' ? '123456789012345' : undefined,
      } as never,
    );

    await expect(
      service.setAsset(owner, context.integrationId, {
        kind: 'phone_number',
        externalId: '123456789012345',
      }),
    ).rejects.toThrow(/belongs to the platform sender/i);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('turns the database ownership race backstop into a safe conflict response', async () => {
    const service = new IntegrationsRegistryService(
      {
        integration: {
          findFirst: jest.fn().mockResolvedValue({
            id: context.integrationId,
            organisationId: context.organisationId,
            providerCode: 'whatsapp_cloud',
            name: 'WhatsApp',
          }),
        },
        $transaction: jest.fn().mockRejectedValue({ code: 'P2002' }),
      } as never,
      activeCrypto,
      { record: jest.fn() } as never,
    );

    await expect(
      service.setAsset(owner, context.integrationId, {
        kind: 'phone_number',
        externalId: '123456789012345',
      }),
    ).rejects.toThrow(/already registered/i);
  });

  it('refuses creating a tenant row for a deployment-scoped provider', async () => {
    const create = jest.fn();
    const service = new IntegrationsRegistryService(
      { integration: { create } } as never,
      activeCrypto,
      { record: jest.fn() } as never,
    );

    await expect(
      service.create(owner, { providerCode: 'razorpay', name: 'Razorpay' }),
    ).rejects.toThrow(/configured by the platform operator/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('rewraps an older context-bound row on generic adapter use', async () => {
    const old = oldCrypto.encrypt('rotate-me', context);
    const row = { id: 'credential-a', ...context, ...old };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new IntegrationsRegistryService(
      {
        integrationCredential: {
          findFirst: jest.fn().mockResolvedValue(row),
          updateMany,
        },
      } as never,
      activeCrypto,
      {} as never,
    );

    await expect(
      service.credentialFor(context.organisationId, context.integrationId, context.kind),
    ).resolves.toBe('rotate-me');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, ciphertext: row.ciphertext },
        data: expect.objectContaining({ keyVersion: 2 }),
      }),
    );
  });

  it('bulk rewrap reports an auditable, concurrency-fenced rotation result', async () => {
    const old = oldCrypto.encrypt('rotate-in-bulk', context);
    const row = {
      id: 'credential-a',
      ...context,
      ...old,
      integration: { organisationId: context.organisationId },
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const auditRecord = jest.fn().mockResolvedValue(undefined);
    const service = new IntegrationsRegistryService(
      {
        integrationCredential: {
          findMany: jest.fn().mockResolvedValue([row]),
          updateMany,
        },
      } as never,
      activeCrypto,
      { record: auditRecord } as never,
    );

    await expect(
      service.rewrapCredentials({
        id: 'user-a',
        name: 'Owner',
        email: 'owner@example.test',
        role: 'head_office',
        organisationId: context.organisationId,
        storeIds: [],
        allStores: true,
      } as never),
    ).resolves.toEqual({
      scanned: 1,
      current: 0,
      rewrapped: 1,
      concurrent: 0,
      failed: 0,
      activeVersion: 2,
      complete: true,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: row.id,
          ciphertext: row.ciphertext,
          integration: { organisationId: context.organisationId },
        }),
        data: expect.objectContaining({ keyVersion: 2 }),
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'integration.credentials_rewrapped' }),
    );
  });

  it('bulk rewrap rejects a missing active key before declaring metadata-current rows safe', async () => {
    const unconfigured = new CredentialCrypto({
      get: (name: string) =>
        name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION' ? '1' : undefined,
    } as never);
    const findMany = jest.fn();
    const service = new IntegrationsRegistryService(
      { integrationCredential: { findMany } } as never,
      unconfigured,
      { record: jest.fn() } as never,
    );

    await expect(
      service.rewrapCredentials({ organisationId: context.organisationId } as never),
    ).rejects.toThrow(/encryption_key is not set/i);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('detects and rewraps an active-key change even when the version was not incremented', async () => {
    const old = oldCrypto.encrypt('same-version-rotation', context);
    const changedWithoutVersionBump = new CredentialCrypto({
      get: (name: string) =>
        name === 'CREDENTIAL_ENCRYPTION_KEY'
          ? activeKey.toString('base64')
          : name === 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'
            ? oldKey.toString('base64')
            : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
              ? '1'
              : undefined,
    } as never);
    const row = {
      id: 'credential-a',
      ...context,
      ...old,
      integration: { organisationId: context.organisationId },
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new IntegrationsRegistryService(
      {
        integrationCredential: {
          findMany: jest.fn().mockResolvedValue([row]),
          updateMany,
        },
      } as never,
      changedWithoutVersionBump,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(
      service.rewrapCredentials({
        id: 'user-a',
        name: 'Owner',
        email: 'owner@example.test',
        role: 'head_office',
        organisationId: context.organisationId,
        storeIds: [],
        allStores: true,
      } as never),
    ).resolves.toMatchObject({ rewrapped: 1, current: 0, complete: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ keyVersion: 1 }) }),
    );
  });

  it('lazy generic access heals an active-key change with an unchanged version', async () => {
    const old = oldCrypto.encrypt('same-version-lazy-generic', context);
    const changedWithoutVersionBump = new CredentialCrypto({
      get: (name: string) =>
        name === 'CREDENTIAL_ENCRYPTION_KEY'
          ? activeKey.toString('base64')
          : name === 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'
            ? oldKey.toString('base64')
            : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
              ? '1'
              : undefined,
    } as never);
    const row = { id: 'credential-a', ...context, ...old };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new IntegrationsRegistryService(
      {
        integrationCredential: {
          findFirst: jest.fn().mockResolvedValue(row),
          updateMany,
        },
      } as never,
      changedWithoutVersionBump,
      {} as never,
    );

    await expect(
      service.credentialFor(context.organisationId, context.integrationId, context.kind),
    ).resolves.toBe('same-version-lazy-generic');
    const rewritten = updateMany.mock.calls[0][0].data;
    expect(rewritten.ciphertext).not.toBe(row.ciphertext);
    expect(changedWithoutVersionBump.decrypt(rewritten, context)).toBe(
      'same-version-lazy-generic',
    );
  });

  it('bulk rewrap includes and safely repairs a tenant id inconsistent with its parent', async () => {
    const old = oldCrypto.encrypt('repair-tenant-id', context);
    const row = {
      id: 'credential-a',
      ...context,
      organisationId: 'stale-tenant-id',
      ...old,
      integration: { organisationId: context.organisationId },
    };
    const findMany = jest.fn().mockResolvedValue([row]);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new IntegrationsRegistryService(
      { integrationCredential: { findMany, updateMany } } as never,
      activeCrypto,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(service.rewrapCredentials(owner)).resolves.toMatchObject({
      scanned: 1,
      rewrapped: 1,
      failed: 0,
      complete: true,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { integration: { organisationId: context.organisationId } },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          integration: { organisationId: context.organisationId },
        }),
        data: expect.objectContaining({ organisationId: context.organisationId }),
      }),
    );
  });

  it('rewraps an older tenant WhatsApp token before returning the sender', async () => {
    const old = oldCrypto.encrypt('whatsapp-token', context);
    const credential = {
      id: 'credential-a',
      ...old,
      expiresAt: null,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new WhatsAppCredentialsService(
      {
        // The sender is now chosen BEFORE any credential is read, so the double
        // hands over one active number and then the credential of the account
        // that owns it. With several numbers the resolver refuses instead of
        // taking the first, which is what the routing tests cover.
        integrationAsset: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'asset-a',
              externalId: 'phone-number-a',
              integrationId: context.integrationId,
            },
          ]),
        },
        integrationCredential: {
          findUnique: jest.fn().mockResolvedValue({
            ...credential,
            organisationId: context.organisationId,
          }),
          updateMany,
        },
      } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      activeCrypto,
    );

    await expect(service.senderFor(context.organisationId)).resolves.toMatchObject({
      usable: true,
      accessToken: 'whatsapp-token',
      phoneNumberId: 'phone-number-a',
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: credential.id, ciphertext: credential.ciphertext },
        data: expect.objectContaining({ keyVersion: 2 }),
      }),
    );
  });

  it('lazy WhatsApp access heals an active-key change with an unchanged version', async () => {
    const old = oldCrypto.encrypt('same-version-lazy-whatsapp', context);
    const changedWithoutVersionBump = new CredentialCrypto({
      get: (name: string) =>
        name === 'CREDENTIAL_ENCRYPTION_KEY'
          ? activeKey.toString('base64')
          : name === 'CREDENTIAL_ENCRYPTION_KEY_PREVIOUS'
            ? oldKey.toString('base64')
            : name === 'CREDENTIAL_ENCRYPTION_KEY_VERSION'
              ? '1'
              : undefined,
    } as never);
    const credential = { id: 'credential-a', ...old, expiresAt: null };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new WhatsAppCredentialsService(
      {
        // The sender is now chosen BEFORE any credential is read, so the double
        // hands over one active number and then the credential of the account
        // that owns it. With several numbers the resolver refuses instead of
        // taking the first, which is what the routing tests cover.
        integrationAsset: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'asset-a',
              externalId: 'phone-number-a',
              integrationId: context.integrationId,
            },
          ]),
        },
        integrationCredential: {
          findUnique: jest.fn().mockResolvedValue({
            ...credential,
            organisationId: context.organisationId,
          }),
          updateMany,
        },
      } as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      changedWithoutVersionBump,
    );

    await expect(service.senderFor(context.organisationId)).resolves.toMatchObject({
      usable: true,
      accessToken: 'same-version-lazy-whatsapp',
    });
    const rewritten = updateMany.mock.calls[0][0].data;
    expect(rewritten.ciphertext).not.toBe(credential.ciphertext);
    expect(changedWithoutVersionBump.decrypt(rewritten, context)).toBe(
      'same-version-lazy-whatsapp',
    );
  });

  it('refuses storing credentials for an env-backed provider the runtime would ignore', async () => {
    const service = new IntegrationsRegistryService(
      {
        integration: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'razorpay-a',
            organisationId: 'org-a',
            providerCode: 'razorpay',
            name: 'Razorpay',
          }),
        },
      } as never,
      activeCrypto,
      {} as never,
    );

    await expect(
      service.setCredential(
        { id: 'user-a', organisationId: 'org-a' } as never,
        'razorpay-a',
        'api_key',
        'ignored-secret',
      ),
    ).rejects.toThrow(/does not consume tenant-stored credentials/i);
  });
});

describe('WhatsApp inbound phone-number ownership', () => {
  const crypto = {} as CredentialCrypto;

  function serviceFor(
    assets: unknown[],
    env: Record<string, string | undefined> = {},
  ): WhatsAppCredentialsService {
    return new WhatsAppCredentialsService(
      {
        integrationAsset: {
          findMany: jest.fn().mockResolvedValue(assets),
        },
      } as never,
      { get: (name: string) => env[name] } as never,
      crypto,
    );
  }

  it('derives the tenant from the parent Integration and caps lookup at two owners', async () => {
    const service = serviceFor([
      {
        id: 'asset-a',
        organisationId: 'org-a',
        integrationId: 'integration-a',
        integration: { organisationId: 'org-a' },
        // No branch mapped to this number, which is the ordinary state for a
        // tenant with one.
        messagingRoutes: [],
      },
    ]);

    await expect(service.organisationForPhoneNumberId('123456789012345')).resolves.toEqual({
      organisationId: 'org-a',
      integrationId: 'integration-a',
      scope: 'tenant',
      // WHICH number it arrived on, so the reply leaves from the same one.
      assetId: 'asset-a',
      // No branch is mapped to it here, and an unmapped number does not name a
      // branch rather than guessing one.
      storeId: null,
    });
    expect(
      (service as unknown as { prisma: { integrationAsset: { findMany: jest.Mock } } }).prisma
        .integrationAsset.findMany,
    ).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('returns null instead of guessing when two active assets claim one phone ID', async () => {
    const service = serviceFor([
      {
        id: 'asset-a',
        organisationId: 'org-a',
        integrationId: 'integration-a',
        integration: { organisationId: 'org-a' },
        // No branch mapped to this number, which is the ordinary state for a
        // tenant with one.
        messagingRoutes: [],
      },
      {
        id: 'asset-b',
        organisationId: 'org-b',
        integrationId: 'integration-b',
        integration: { organisationId: 'org-b' },
        messagingRoutes: [],
      },
    ]);
    const expectedLog = jest
      .spyOn((service as unknown as { log: { error: (message: string) => void } }).log, 'error')
      .mockImplementation(() => undefined);

    await expect(service.organisationForPhoneNumberId('123456789012345')).resolves.toBeNull();
    expect(expectedLog).toHaveBeenCalledWith(expect.stringMatching(/multiple active tenant assets/i));
  });

  it('returns null when the asset tenant differs from its parent Integration', async () => {
    const service = serviceFor([
      {
        id: 'asset-a',
        organisationId: 'wrong-org',
        integrationId: 'integration-a',
        integration: { organisationId: 'org-a' },
        messagingRoutes: [],
      },
    ]);
    const expectedLog = jest
      .spyOn((service as unknown as { log: { error: (message: string) => void } }).log, 'error')
      .mockImplementation(() => undefined);

    await expect(service.organisationForPhoneNumberId('123456789012345')).resolves.toBeNull();
    expect(expectedLog).toHaveBeenCalledWith(expect.stringMatching(/does not match/i));
  });

  it('returns null when a tenant asset collides with the configured platform sender', async () => {
    const service = serviceFor(
      [
        {
          organisationId: 'org-a',
          integrationId: 'integration-a',
          integration: { organisationId: 'org-a' },
        },
      ],
      {
        WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
        WHATSAPP_PLATFORM_ORGANISATION_ID: 'platform-org',
      },
    );
    const expectedLog = jest
      .spyOn((service as unknown as { log: { error: (message: string) => void } }).log, 'error')
      .mockImplementation(() => undefined);

    await expect(service.organisationForPhoneNumberId('123456789012345')).resolves.toBeNull();
    expect(expectedLog).toHaveBeenCalledWith(expect.stringMatching(/platform sender/i));
  });
});
