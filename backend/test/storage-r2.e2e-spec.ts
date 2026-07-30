import { ConfigService } from '@nestjs/config';
import { StorageService } from '../src/storage/storage.service';

/**
 * StorageService against a real HTTP endpoint that verifies SigV4.
 *
 * `R2_ENDPOINT` points at a local stand-in (see scratchpad/fake_r2.py) that
 * recomputes the expected signature with botocore. Skipped unless
 * `R2_TEST_ENDPOINT` is set, so CI without the stand-in still passes; run it
 * with the stand-in up to exercise the real upload path.
 */
const endpoint = process.env.R2_TEST_ENDPOINT;
const describeIf = endpoint ? describe : describe.skip;

describeIf('StorageService — R2 provider', () => {
  const env: Record<string, string> = {
    STORAGE_PROVIDER: 'r2',
    R2_ACCOUNT_ID: 'testacct',
    R2_ACCESS_KEY_ID: 'TESTACCESSKEY0001',
    R2_SECRET_ACCESS_KEY: 'TESTSECRETKEY000000000000000000000000001',
    R2_BUCKET: 'eclat-media',
    R2_PUBLIC_BASE_URL: 'https://pub-deadbeef.r2.dev',
    R2_ENDPOINT: endpoint ?? '',
  };

  const makeService = (overrides: Record<string, string> = {}) => {
    const merged = { ...env, ...overrides };
    const config = {
      get: (k: string) => merged[k],
    } as unknown as ConfigService;
    return new StorageService(config);
  };

  it('selects the R2 provider when fully configured', () => {
    expect(makeService().usingR2).toBe(true);
  });

  it('falls back to local when a required value is missing', () => {
    // A half-configured provider must not take the whole upload path down.
    expect(makeService({ R2_PUBLIC_BASE_URL: '' }).usingR2).toBe(false);
  });

  it('uploads and returns the public URL', async () => {
    const url = await makeService().save('products', 'abc123.jpg', Buffer.from('jpegbytes'));
    expect(url).toBe('https://pub-deadbeef.r2.dev/products/abc123.jpg');
  });

  it('sanitises awkward filenames before they become keys', async () => {
    // `save()` strips anything outside [A-Za-z0-9._-], so a space never reaches
    // the signer. Asserted here because that sanitisation is what keeps object
    // keys, and therefore signatures, predictable — encodeKey is the backstop.
    const url = await makeService().save('products', 'ring size 7.png', Buffer.from('x'));
    expect(url).toBe('https://pub-deadbeef.r2.dev/products/ring_size_7.png');
  });

  it('sends a large body intact', async () => {
    const big = Buffer.alloc(256 * 500);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const url = await makeService().save('products', 'big.jpg', big);
    expect(url).toBe('https://pub-deadbeef.r2.dev/products/big.jpg');
  });

  it('falls back to local disk when R2 rejects the request', async () => {
    // Wrong secret -> 403. The upload must still succeed somewhere rather than
    // failing the caller's intake at the counter.
    const url = await makeService({ R2_SECRET_ACCESS_KEY: 'WRONG' }).save(
      'products',
      'fallback.jpg',
      Buffer.from('x'),
    );
    expect(url).toBe('/uploads/products/fallback.jpg');
  });
});
