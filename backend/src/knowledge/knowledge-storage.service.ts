import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { encodeKey, signRequest } from '../storage/sigv4';

/** Private storage for source documents. This directory is never mounted by main.ts. */
@Injectable()
export class KnowledgeStorageService {
  constructor(private readonly config: ConfigService) {}

  get mode(): 'local' | 'r2' {
    return (this.config.get<string>('KNOWLEDGE_STORAGE_PROVIDER') ?? 'local').toLowerCase() === 'r2'
      ? 'r2'
      : 'local';
  }

  private get root(): string {
    const configured = this.config.get<string>('KNOWLEDGE_UPLOAD_DIR');
    if (configured) return isAbsolute(configured) ? configured : join(process.cwd(), configured);
    return join(process.cwd(), 'uploads-private', 'knowledge');
  }

  async save(organisationId: string, documentId: string, fileName: string, buffer: Buffer) {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeOrganisationId = safeIdentifier(organisationId, 'organisation');
    const safeDocumentId = safeIdentifier(documentId, 'document');
    const key = `org/${safeOrganisationId}/${safeDocumentId}/${safeName}`;
    if (this.mode === 'r2') {
      await this.r2Request('PUT', key, buffer, contentTypeOf(safeName));
      return key;
    }
    const target = this.resolveKey(key);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, buffer, { flag: 'wx' });
    return key;
  }

  async read(organisationId: string, key: string): Promise<Buffer> {
    this.assertOwnedKey(organisationId, key);
    if (this.mode === 'r2') return this.r2Request('GET', key);
    return readFile(this.resolveKey(key));
  }

  async remove(organisationId: string, key: string): Promise<void> {
    this.assertOwnedKey(organisationId, key);
    if (this.mode === 'r2') {
      await this.r2Request('DELETE', key);
      return;
    }
    await unlink(this.resolveKey(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private get r2() {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID') ?? '';
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID') ?? '';
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY') ?? '';
    const bucket =
      this.config.get<string>('KNOWLEDGE_R2_BUCKET') ??
      this.config.get<string>('R2_BUCKET') ??
      '';
    const endpoint = (
      this.config.get<string>('KNOWLEDGE_R2_ENDPOINT') ??
      this.config.get<string>('R2_ENDPOINT') ??
      `https://${accountId}.r2.cloudflarestorage.com`
    ).replace(/\/+$/, '');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        'KNOWLEDGE_STORAGE_PROVIDER=r2 requires R2 account credentials and KNOWLEDGE_R2_BUCKET (or R2_BUCKET).',
      );
    }
    return { accessKeyId, secretAccessKey, bucket, endpoint };
  }

  private async r2Request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    payload: Buffer = Buffer.alloc(0),
    contentType?: string,
  ): Promise<Buffer> {
    const { accessKeyId, secretAccessKey, bucket, endpoint } = this.r2;
    const url = `${endpoint}/${bucket}/${encodeKey(key)}`;
    const headers = signRequest({
      method,
      url,
      headers:
        method === 'PUT'
          ? { 'content-type': contentType ?? 'application/octet-stream', 'cache-control': 'private, no-store' }
          : {},
      payload,
      accessKeyId,
      secretAccessKey,
      region: 'auto',
      service: 's3',
    });
    const response = await fetch(url, {
      method,
      headers,
      ...(method === 'PUT' ? { body: new Uint8Array(payload) } : {}),
    });
    if (method === 'DELETE' && response.status === 404) return Buffer.alloc(0);
    if (!response.ok) throw new Error(`Private knowledge storage returned ${response.status}.`);
    return method === 'GET' ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  }

  private assertOwnedKey(organisationId: string, key: string): void {
    const safeOrganisationId = safeIdentifier(organisationId, 'organisation');
    const normalised = key.replace(/\\/g, '/');
    if (
      !normalised.startsWith(`org/${safeOrganisationId}/`) ||
      normalised.includes('../') ||
      normalised.startsWith('/')
    ) {
      throw new Error('Knowledge storage key does not belong to this organisation');
    }
  }

  private resolveKey(key: string): string {
    const target = resolve(this.root, key);
    const fromRoot = relative(resolve(this.root), target);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error('Invalid private knowledge storage key');
    }
    return target;
  }
}

function safeIdentifier(value: string, label: string): string {
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label} identifier for private knowledge storage`);
  }
  return value;
}

function contentTypeOf(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  const types: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain; charset=utf-8',
  };
  return types[extension] ?? 'application/octet-stream';
}
