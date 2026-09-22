/**
 * Upload folders the public static handler must never serve.
 *
 * `attendance` holds photographs of named employees' faces, `visits` holds
 * photographs of customers at a counter, `exports` holds generated archives
 * — every catalogue photograph in one file — and `messages` holds whatever a
 * customer sent into a WhatsApp thread, which is their content and often a
 * photograph of something they own. Each is read only through an
 * authenticated route that checks the caller.
 */
const PRIVATE_MEDIA = /^\/uploads\/org\/[^/]+\/(attendance|visits|exports|messages)\//i;

/**
 * Would the static handler, given this request path, reach a private folder?
 *
 * Tested on the path as the handler will resolve it, not as it arrived: the
 * handler percent-decodes and then normalises, so `/uploads/org/x/%65xports/`,
 * `/uploads//org/x/exports/` and `/uploads/org/x/./exports/` all reach the same
 * file as the plain form and must all be refused. An upload path that will not
 * decode is refused rather than guessed at.
 */
export function isPrivateUploadPath(rawPath: string): boolean {
  if (PRIVATE_MEDIA.test(rawPath)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return /^\/uploads(\/|%2f)/i.test(rawPath);
  }
  const normalised = decoded
    .replace(/\\/g, '/')
    .replace(/\/\.(?=\/)/g, '')
    .replace(/\/{2,}/g, '/');
  return PRIVATE_MEDIA.test(normalised);
}
