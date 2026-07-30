import { readFileSync } from 'fs';
import { join } from 'path';
import { signRequest, encodeKey } from '../src/storage/sigv4';

/**
 * Our SigV4 signer vs. the reference implementation.
 *
 * `sigv4-vectors.json` was produced by botocore's own `S3SigV4Auth` (the signer
 * inside the AWS CLI and boto3) — see the generator in the commit message. Each
 * vector pins the timestamp botocore used, so feeding the same instant back in
 * makes the signature fully deterministic and any difference is the algorithm.
 *
 * Worth keeping because a signing bug does not fail loudly or locally: uploads
 * work in dev on the local-disk provider and only break against real R2, where
 * every mistake surfaces as the same opaque `SignatureDoesNotMatch`.
 */
describe('SigV4 signer (vs botocore)', () => {
  const vectors: {
    name: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    payload_b64: string;
    amzDate: string;
    contentSha256: string;
    authorization: string;
  }[] = JSON.parse(readFileSync(join(__dirname, 'sigv4-vectors.json'), 'utf8'));

  const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  it('has vectors to check', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
  });

  for (const v of vectors) {
    it(`matches botocore: ${v.name}`, () => {
      const iso = v.amzDate.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        '$1-$2-$3T$4:$5:$6.000Z',
      );
      const signed = signRequest({
        method: v.method,
        url: v.url,
        headers: v.headers,
        payload: Buffer.from(v.payload_b64, 'base64'),
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET_KEY,
        region: 'auto',
        service: 's3',
        date: new Date(iso),
      });

      expect(signed['x-amz-date']).toBe(v.amzDate);
      expect(signed['x-amz-content-sha256']).toBe(v.contentSha256.toLowerCase());
      expect(signed.Authorization).toBe(v.authorization);
    });
  }

  describe('encodeKey', () => {
    it('keeps path separators literal', () => {
      expect(encodeKey('catalogue/product_1.jpg')).toBe('catalogue/product_1.jpg');
    });

    it('escapes spaces and non-ASCII', () => {
      expect(encodeKey('catalogue/ring design é.png')).toBe(
        'catalogue/ring%20design%20%C3%A9.png',
      );
    });

    it("escapes the characters encodeURIComponent leaves alone (!'()*)", () => {
      expect(encodeKey("it's (a) ring!*.jpg")).toBe('it%27s%20%28a%29%20ring%21%2A.jpg');
    });
  });
});
