import { createHash, createHmac } from 'crypto';

/**
 * Minimal AWS Signature Version 4 signer for single S3-compatible requests.
 *
 * Cloudflare R2 speaks the S3 API, so uploading to it means signing with SigV4.
 * The official `@aws-sdk/client-s3` would do this, but it pulls ~15MB of
 * transitive dependencies (credential providers, region resolution, retry
 * middleware, XML marshalling) to serve exactly one operation: PUT an object at
 * a known endpoint with static credentials. The algorithm below is the whole of
 * what we need and is verified against botocore's own signer in
 * `test/sigv4.spec.ts`.
 *
 * Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */

export interface SigV4Input {
  method: string;
  /** Full request URL, e.g. https://<acct>.r2.cloudflarestorage.com/bucket/key.jpg */
  url: string;
  /** Header name -> value. `host` is derived from the URL and must not be passed. */
  headers: Record<string, string>;
  /** Raw request body; empty for GET/DELETE. */
  payload: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 always uses `auto`. */
  region: string;
  service: string;
  /** Injectable for deterministic tests; defaults to now. */
  date?: Date;
}

const hex = (b: Buffer): string => b.toString('hex');
const sha256 = (data: Buffer | string): string => hex(createHash('sha256').update(data).digest());
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 encoding, for building an object key into a URL. `encodeURIComponent`
 * leaves `!'()*` unescaped; AWS's own `uri-encode` rule escapes them.
 *
 * Note this is for *callers constructing the URL* — the canonicalisation below
 * deliberately does not re-encode. See `canonicalPath`.
 */
export function encodeKey(value: string): string {
  return value
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/');
}

/**
 * The canonical path is the URL's path used **verbatim** — no re-encoding and no
 * `.`/`..` normalisation.
 *
 * This is S3-specific and easy to get wrong. General SigV4 says to URI-encode
 * the path, but S3 (and therefore R2) does not: botocore's `S3SigV4Auth`
 * overrides the base signer with a method whose entire body is `return path`,
 * commented "For S3, we do not normalize the path". Re-encoding here turns a key
 * containing a space into `%2520` and yields SignatureDoesNotMatch — which reads
 * like a bad secret and sends you debugging the wrong thing.
 *
 * Consequence: whatever we sign is exactly what goes on the wire, so the caller
 * owns encoding the key (via `encodeKey`) when building the URL.
 */
function canonicalPath(pathname: string): string {
  return pathname || '/';
}

/**
 * Query pairs sorted and rejoined in their **already-encoded** form, matching
 * botocore's `_canonical_query_string_url`. Round-tripping through
 * `URLSearchParams` would decode and re-encode, turning a literal `/` in a value
 * into `%2F` and breaking the signature.
 */
function canonicalQuery(search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return '';
  return query
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=');
      return i === -1 ? ([pair, ''] as [string, string]) : ([pair.slice(0, i), pair.slice(i + 1)] as [string, string]);
    })
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Returns the headers to send, including `Authorization`. The caller sends the
 * request itself, so this stays free of any HTTP client.
 */
export function signRequest(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.date ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260730T101530Z
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256(input.payload);

  // Host comes from the URL, never the caller — a mismatch here is unsignable.
  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  // Canonical headers: lowercase names, trimmed values, sorted by name.
  const normalized = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = normalized.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = normalized.map(([k]) => k).join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hex(hmac(kSigning, stringToSign));

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
