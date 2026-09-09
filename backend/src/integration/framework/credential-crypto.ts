import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export interface CredentialContext {
  organisationId: string;
  integrationId: string;
  kind: string;
}

const CONTEXT_BOUND_PREFIX = 'aad1:';

/**
 * CredentialCrypto — envelope encryption for tenant integration secrets
 * (CaratOS Phase A5 / B2).
 *
 * AES-256-GCM. GCM rather than CBC because it authenticates: a tampered
 * ciphertext fails to decrypt instead of silently producing different plaintext,
 * which for a credential means a modified row cannot be used to redirect an API
 * call somewhere else.
 *
 * FAIL-CLOSED, deliberately and without exception: if no key is configured,
 * `encrypt` THROWS. It does not fall back to storing plaintext, base64, or
 * anything else — a "temporary" plaintext fallback is how secrets end up in a
 * database backup forever, and nothing downstream can tell the difference
 * afterwards.
 *
 * KEY MANAGEMENT
 *   CREDENTIAL_ENCRYPTION_KEY          — active key, base64, exactly 32 bytes.
 *   CREDENTIAL_ENCRYPTION_KEY_VERSION  — integer stamped onto rows it writes.
 *   CREDENTIAL_ENCRYPTION_KEY_PREVIOUS — prior key, DECRYPT ONLY, for rotation.
 *
 * Rotating: publish the new key as ACTIVE and the old one as PREVIOUS, bump
 * VERSION, then re-encrypt rows whose `keyVersion` is behind. Once none remain,
 * drop PREVIOUS. Nothing needs downtime, and a row can always be read by exactly
 * one of the two keys.
 *
 * This is not a KMS. A managed KMS (AWS Secrets Manager / KMS) is the correct
 * destination and the interface here is deliberately narrow enough to swap the
 * implementation without touching a caller.
 */
@Injectable()
export class CredentialCrypto {
  private readonly log = new Logger(CredentialCrypto.name);

  constructor(private readonly config: ConfigService) {}

  /** True when a usable key is configured — for health checks and admin UI. */
  get isConfigured(): boolean {
    try {
      this.assertConfigured();
      return true;
    } catch {
      return false;
    }
  }

  /** Fail closed at the start of an operator action that requires the active key. */
  assertConfigured(): void {
    this.activeKey();
    // A valid key paired with an invalid version is not a usable
    // configuration: ciphertext written under an accidental fallback version
    // cannot be rotated safely later.
    void this.activeVersion;
  }

  get activeVersion(): number {
    const configured = this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY_VERSION');
    // Version 1 is the backwards-compatible default for deployments created
    // before explicit rotation support. Once the variable is present, malformed
    // input must fail closed rather than silently stamping new rows as version 1.
    if (configured == null || configured.trim() === '') return 1;
    const raw = configured.trim();
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new InternalServerErrorException(
        'CREDENTIAL_ENCRYPTION_KEY_VERSION must be a positive integer.',
      );
    }
    const version = Number(raw);
    if (!Number.isSafeInteger(version)) {
      throw new InternalServerErrorException(
        'CREDENTIAL_ENCRYPTION_KEY_VERSION is outside the supported integer range.',
      );
    }
    return version;
  }

  /**
   * Encrypt a secret. Throws if no key is configured — the caller must surface
   * that as "integration cannot be saved", never swallow it.
   */
  encrypt(plaintext: string, context: CredentialContext): {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  } {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new InternalServerErrorException('Refusing to encrypt an empty secret');
    }
    const key = this.activeKey();
    // 96-bit nonce: the size GCM is specified for, and random per message. Never
    // reuse one with the same key — that breaks GCM catastrophically, which is
    // why this is generated here and never passed in.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(contextBytes(context));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      // The prefix is a format marker, not secret data. It lets deployments
      // read legacy pre-AAD rows while ensuring every new row is context-bound.
      ciphertext: CONTEXT_BOUND_PREFIX + enc.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.activeVersion,
    };
  }

  /**
   * Decrypt. Tries the key matching `keyVersion` first, then the other one, so a
   * rotation in progress does not break reads.
   *
   * Never logs the ciphertext or any part of the plaintext on failure — a
   * decryption error says only that it failed.
   */
  decrypt(record: {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  }, context: CredentialContext): string {
    const candidates: Buffer[] = [];
    const active = this.safeKey('CREDENTIAL_ENCRYPTION_KEY');
    const previous = this.safeKey('CREDENTIAL_ENCRYPTION_KEY_PREVIOUS');

    if (record.keyVersion === this.activeVersion) {
      if (active) candidates.push(active);
      if (previous) candidates.push(previous);
    } else {
      if (previous) candidates.push(previous);
      if (active) candidates.push(active);
    }
    if (!candidates.length) {
      throw new InternalServerErrorException(
        'No credential encryption key is configured, so stored secrets cannot be read.',
      );
    }

    for (const key of candidates) {
      try {
        const contextBound = this.isContextBound(record);
        const ciphertext = contextBound
          ? record.ciphertext.slice(CONTEXT_BOUND_PREFIX.length)
          : record.ciphertext;
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(record.iv, 'base64'),
        );
        if (contextBound) decipher.setAAD(contextBytes(context));
        decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
        const out = Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'base64')),
          decipher.final(),
        ]);
        return out.toString('utf8');
      } catch {
        // Wrong key or tampered data — try the next candidate. The specific
        // reason is deliberately not distinguished or logged.
      }
    }
    this.log.error('Credential decryption failed with every configured key.');
    throw new InternalServerErrorException(
      'Stored credential could not be decrypted. The encryption key may have changed.',
    );
  }

  /** Legacy rows have no prefix and are upgraded by their owning service. */
  isContextBound(record: { ciphertext: string }): boolean {
    return record.ciphertext.startsWith(CONTEXT_BOUND_PREFIX);
  }

  /**
   * Verify both metadata and cryptographic ownership by the active key.
   *
   * This catches the dangerous operator mistake where ACTIVE changes but its
   * VERSION does not: a version-only check would call old rows current and allow
   * PREVIOUS to be removed even though ACTIVE cannot decrypt them.
   */
  isEncryptedWithActiveKey(
    record: {
      ciphertext: string;
      iv: string;
      authTag: string;
      keyVersion: number;
    },
    context: CredentialContext,
  ): boolean {
    if (!this.isContextBound(record) || record.keyVersion !== this.activeVersion) {
      return false;
    }
    const key = this.activeKey();
    return this.tryDecrypt(record, context, key) !== null;
  }

  /**
   * Constant-time comparison for webhook signatures and shared secrets.
   *
   * Length is compared first and returns false — that leaks only the length,
   * which a signature scheme already publishes. Comparing buffers of different
   * lengths would throw, and the naive `===` would leak the position of the first
   * differing byte through timing.
   */
  static safeEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  private activeKey(): Buffer {
    const key = this.safeKey('CREDENTIAL_ENCRYPTION_KEY');
    if (!key) {
      throw new InternalServerErrorException(
        'CREDENTIAL_ENCRYPTION_KEY is not set. Integration credentials cannot be stored ' +
          'until it is — they are never written unencrypted.',
      );
    }
    return key;
  }

  private safeKey(name: string): Buffer | null {
    const raw = this.config.get<string>(name);
    if (!raw) return null;
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, 'base64');
    } catch {
      return null;
    }
    // A short key silently truncated or padded would produce ciphertext nobody
    // can read later. Reject it loudly at the point of use instead.
    if (buf.length !== 32) {
      this.log.error(
        `${name} must decode to exactly 32 bytes (got ${buf.length}). It is being ignored.`,
      );
      return null;
    }
    return buf;
  }

  private tryDecrypt(
    record: { ciphertext: string; iv: string; authTag: string },
    context: CredentialContext,
    key: Buffer,
  ): string | null {
    try {
      const contextBound = this.isContextBound(record);
      const ciphertext = contextBound
        ? record.ciphertext.slice(CONTEXT_BOUND_PREFIX.length)
        : record.ciphertext;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(record.iv, 'base64'),
      );
      if (contextBound) decipher.setAAD(contextBytes(context));
      decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
      const out = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]);
      return out.toString('utf8');
    } catch {
      return null;
    }
  }
}

function contextBytes(context: CredentialContext): Buffer {
  for (const [name, value] of Object.entries(context)) {
    if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) {
      throw new InternalServerErrorException(`Invalid credential encryption context: ${name}`);
    }
  }
  return Buffer.from(
    JSON.stringify([
      'caratos-integration-credential',
      1,
      context.organisationId,
      context.integrationId,
      context.kind,
    ]),
    'utf8',
  );
}
