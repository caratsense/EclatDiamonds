/**
 * The `header` component of a SEND, for a template whose header is a picture,
 * a video or a document.
 *
 * An approved template already holds its header media — Meta looked at that
 * exact file before approving — which reads as "the picture belongs to the
 * template now". It does not. Meta keeps it as the EXAMPLE, and a send that
 * omits the header component is refused with "(#132012) Parameter format does
 * not match format in the created template", a sentence that names neither the
 * header nor the picture. One broadcast of 126 recipients went out that way
 * and reached nobody.
 *
 * Same split as the carousel next door, for the same reason: creation names
 * the file by asset HANDLE, a send names it by MEDIA ID, and Meta accepts
 * neither in the other's place.
 *
 * Kept as pure functions so the exact JSON, and every refusal, can be asserted
 * without a network, a tenant or an approved template to hand.
 */

/** The header formats that carry a file rather than words. */
export type MediaHeaderFormat = 'IMAGE' | 'DOCUMENT' | 'VIDEO';

const MEDIA_FORMATS: MediaHeaderFormat[] = ['IMAGE', 'DOCUMENT', 'VIDEO'];

/** What a person calls the thing that is missing. */
const NOUN: Record<MediaHeaderFormat, string> = {
  IMAGE: 'picture',
  DOCUMENT: 'document',
  VIDEO: 'video',
};

export interface MediaHeaderComponent {
  type: 'header';
  parameters: { type: 'image' | 'document' | 'video'; [key: string]: unknown }[];
}

/**
 * Where this send's header file comes from, or why there is none to send.
 *
 * `none` is the ordinary case — a text header, or no header at all — and the
 * caller's components are left exactly as they are.
 */
export type MediaHeaderPlan =
  | { kind: 'none' }
  /** Our own copy of the file, by private storage key. */
  | { kind: 'stored'; format: MediaHeaderFormat; storageKey: string }
  /** The approved file on Meta's CDN, which is the only copy we hold. */
  | { kind: 'approved'; format: MediaHeaderFormat; url: string }
  | { kind: 'refuse'; format: MediaHeaderFormat; reason: string };

/**
 * Decide the header file for one send, from the template's asset metadata.
 *
 * `templateName` is carried only so a refusal can name the template. "This
 * message was not sent" with no name is a support ticket; with the name it is
 * something head office can go and fix.
 *
 * Two sources, preferred in that order:
 *
 *   - `headerImageKey` — the bytes we kept when somebody uploaded the picture
 *     here. Ours, private, and certain to still exist.
 *   - `headerImageUrl` — Meta's own CDN address for the approved file, written
 *     by every template sync. It is all we hold for a template that was
 *     created at Meta rather than here, and in practice that is most of them.
 *
 * A DOCUMENT header is refused rather than filled from either, and that is
 * deliberate. A document header is a document written for ONE recipient — a
 * quotation — which the message carries as its attachment, and the file Meta
 * holds for that template is the specimen submitted for review. Sending the
 * specimen to a customer is a worse outcome than not sending at all.
 */
export function planMediaHeader(templateName: string, metadata: unknown): MediaHeaderPlan {
  const raw = (metadata ?? {}) as Record<string, unknown>;
  const declared = typeof raw.headerFormat === 'string' ? raw.headerFormat.toUpperCase() : '';
  const format = MEDIA_FORMATS.find((candidate) => candidate === declared);
  if (!format) return { kind: 'none' };

  const named = templateName.trim() || 'this template';

  if (format === 'DOCUMENT') {
    return {
      kind: 'refuse',
      format,
      reason:
        `The template "${named}" has a document header, so the document it is built around has ` +
        'to be attached to the message. Nothing was attached, so it was not sent.',
    };
  }

  const storageKey = typeof raw.headerImageKey === 'string' ? raw.headerImageKey.trim() : '';
  if (storageKey) return { kind: 'stored', format, storageKey };

  const url = typeof raw.headerImageUrl === 'string' ? raw.headerImageUrl.trim() : '';
  if (/^https:\/\//i.test(url)) return { kind: 'approved', format, url };

  return {
    kind: 'refuse',
    format,
    reason:
      `The template "${named}" has a ${NOUN[format]} in its header and we hold no copy of that ` +
      `${NOUN[format]}, so the message was not sent. Synchronise templates, which reads it back ` +
      'from the provider.',
  };
}

/**
 * Build the component.
 *
 * The file is named by MEDIA ID and never by link. Meta accepts either, and
 * the id is the one this product can stand behind: it is the shape already
 * proven by the carousel and by a quotation's document header, it is checked
 * when the bytes are uploaded rather than once per recipient at delivery, and
 * it needs no public address for a picture to keep working. A link would put
 * every recipient of a broadcast behind one URL staying fetchable — which is
 * the shape of the failure this whole path exists to end.
 */
export function buildMediaHeaderComponent(
  format: MediaHeaderFormat,
  mediaId: string,
): MediaHeaderComponent {
  if (!mediaId) {
    throw new Error('A media header needs the media id of an uploaded file.');
  }
  const kind = format.toLowerCase() as 'image' | 'document' | 'video';
  return { type: 'header', parameters: [{ type: kind, [kind]: { id: mediaId } }] };
}

/**
 * The caller's components with this send's header among them.
 *
 * Any header already in the list is dropped rather than kept beside the new
 * one: Meta allows a template exactly one header component, and two is
 * refused with the same unhelpful #132012 as none.
 */
export function withMediaHeader(
  components: unknown[] | undefined,
  format: MediaHeaderFormat,
  mediaId: string,
): unknown[] {
  const header = buildMediaHeaderComponent(format, mediaId);
  const rest = (components ?? []).filter(
    (component) => (component as { type?: string } | null)?.type !== 'header',
  );
  return [header, ...rest];
}
