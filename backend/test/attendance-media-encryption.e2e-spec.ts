import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { StorageService } from '../src/storage/storage.service';

const ORG = 'org_attendance_crypto';
const KEY = Buffer.alloc(32, 0x5a);
const PHOTO = Buffer.from('synthetic attendance photo bytes', 'utf8');

function storage(root: string, options: { key?: string; nodeEnv?: string } = {}) {
  return new StorageService(
    new ConfigService({
      STORAGE_PROVIDER: 'local',
      UPLOAD_DIR: root,
      NODE_ENV: options.nodeEnv ?? 'test',
      ATTENDANCE_MEDIA_KEY: options.key ?? '',
    }),
  );
}

function localFile(root: string, stored: string): string {
  const relative = stored.replace(/^\/uploads\//, '');
  return join(root, ...relative.split('/'));
}

describe('attendance media encryption', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'caratos-attendance-media-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts authenticated ciphertext, never the photo or key, in the public storage tree', async () => {
    const service = storage(root, { key: KEY.toString('base64'), nodeEnv: 'production' });
    const stored = await service.save(ORG, 'attendance', 'in.png', PHOTO);

    expect(stored).toMatch(/\.attendance\.enc$/);
    const atRest = await readFile(localFile(root, stored));
    expect(StorageService.isEncryptedAttendanceMedia(atRest)).toBe(true);
    expect(atRest.includes(PHOTO)).toBe(false);
    expect(atRest.includes(KEY)).toBe(false);

    const opened = await service.readAttendanceObject(ORG, stored);
    expect(opened?.buffer).toEqual(PHOTO);
    expect(opened?.contentType).toBe('image/png');
    await expect(service.readAttendanceObject('another_org', stored)).resolves.toBeNull();
    await expect(
      service.readAttendanceObject(
        ORG,
        `https://attacker.invalid/org/${ORG}/attendance/in.png.attendance.enc`,
      ),
    ).resolves.toBeNull();
  });

  it('refuses modified ciphertext rather than returning unauthenticated bytes', async () => {
    const service = storage(root, { key: KEY.toString('base64'), nodeEnv: 'production' });
    const stored = await service.save(ORG, 'attendance', 'out.jpeg', PHOTO);
    const atRest = await readFile(localFile(root, stored));
    atRest[atRest.length - 1] ^= 0xff;
    await writeFile(localFile(root, stored), atRest);
    await expect(service.readAttendanceObject(ORG, stored)).resolves.toBeNull();
  });

  it('fails closed for a new production photo when the dedicated key is absent', async () => {
    const service = storage(root, { nodeEnv: 'production' });
    await expect(service.save(ORG, 'attendance', 'in.png', PHOTO)).rejects.toThrow(
      /ATTENDANCE_MEDIA_KEY is required/,
    );
  });

  it('will not hand out a non-attendance object through the attendance reader', async () => {
    const service = storage(root, { key: KEY.toString('base64'), nodeEnv: 'production' });
    const catalogue = await service.save(ORG, 'catalogue', 'ring.png', PHOTO);
    await expect(service.readAttendanceObject(ORG, catalogue)).resolves.toBeNull();
    await expect(
      service.readAttendanceObject(ORG, `/uploads/org/${ORG}/attendance/../catalogue/ring.png`),
    ).resolves.toBeNull();
    await expect(
      service.readAttendanceObject(ORG, `/uploads/org/${ORG}/attendance/%2e%2e/catalogue/ring.png`),
    ).resolves.toBeNull();
  });

  it('continues to read a namespaced legacy plaintext object during migration', async () => {
    const legacyWriter = storage(root, { nodeEnv: 'test' });
    const stored = await legacyWriter.save(ORG, 'attendance', 'legacy.png', PHOTO);
    const encryptedReader = storage(root, { key: KEY.toString('base64'), nodeEnv: 'production' });

    expect(StorageService.isEncryptedAttendanceMedia(await readFile(localFile(root, stored)))).toBe(false);
    await expect(encryptedReader.readAttendanceObject(ORG, stored)).resolves.toMatchObject({
      buffer: PHOTO,
      contentType: 'image/png',
    });
  });
});
