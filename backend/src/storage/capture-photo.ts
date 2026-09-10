import { Logger } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Store a small camera capture that arrived as a `data:` URL.
 *
 * Two screens send one: the attendance punch and the counter visit. The rules
 * they need are identical and are security-relevant, so they live here once —
 * a second copy is how the two copies eventually disagree about what a valid
 * image is.
 *
 * ## What this refuses, and why
 *
 * `data:` is a URL scheme. The MIME type after `data:` is written by whoever
 * sent it and proves nothing, so the bytes are checked against the type that was
 * claimed. Without that, a base64 blob of anything at all could be stored under
 * a `.jpeg` name and later served as one.
 *
 * ## What it never does
 *
 * Throw. Both callers are recording something that matters more than the photo —
 * an attendance punch, a customer visit — and neither may fail because a camera
 * frame was malformed or object storage was having a bad minute. A rejection
 * returns null and is logged; the caller writes its row with no photo, which is
 * honest. A broken link that looks like evidence is worse than no evidence.
 *
 * ## What it is not
 *
 * Identification. Nothing here compares the image to anything. Callers must not
 * record a returned URL as proof of WHO was present.
 */

/** Small enough that a bad frame is cheap, large enough for any real capture. */
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/;

const logger = new Logger('CapturePhoto');

export async function saveCapturedPhoto(
  storage: StorageService,
  organisationId: string,
  folder: string,
  baseName: string,
  photo: string | undefined | null,
): Promise<string | null> {
  if (!photo) return null;

  const match = DATA_URL.exec(photo.trim());
  if (!match) {
    logger.warn('Capture rejected: not a base64 data URL for a supported image type.');
    return null;
  }

  const [, declared, payload] = match;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    logger.warn('Capture rejected: payload is not decodable base64.');
    return null;
  }

  if (!buffer.length || buffer.length > MAX_CAPTURE_BYTES) {
    logger.warn(`Capture rejected: ${buffer.length} bytes.`);
    return null;
  }
  if (!looksLikeImage(buffer, declared)) {
    logger.warn(`Capture rejected: content does not match declared type ${declared}.`);
    return null;
  }

  const ext = declared === 'jpg' ? 'jpeg' : declared;
  try {
    return await storage.save(organisationId, folder, `${baseName}.${ext}`, buffer);
  } catch (err) {
    logger.error(
      `Capture could not be stored (${err instanceof Error ? err.message : String(err)}) — ` +
        'recording without it.',
    );
    return null;
  }
}

/**
 * Does the buffer start like the image type it claims to be?
 *
 * Only the container signature is checked. This is not a decoder and does not
 * pretend to be: it is the cheap check that stops the declared type being a
 * free-text field, and the file is only ever served back as an image.
 */
export function looksLikeImage(buffer: Buffer, declared: string): boolean {
  if (buffer.length < 12) return false;
  if (declared === 'png') {
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (declared === 'jpeg' || declared === 'jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (declared === 'webp') {
    return (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}
