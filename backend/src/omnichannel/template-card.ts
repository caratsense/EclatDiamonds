/**
 * What a template message LOOKED LIKE to the customer who received it.
 *
 * An approved template is a shape held by the provider, not text we send: a
 * send names the template and supplies its variables, so the words and the
 * picture never travel through our own message row. The row is therefore
 * blank — no body, no media — and the inbox drew a blank bubble for it.
 *
 * The client saw that on the nails-event broadcast. The campaign screen
 * previewed the invitation with its photograph, 104 customers received exactly
 * that, and her own conversations tab showed an empty message against every
 * one of them. Her words: "the same should be shown on conversations tab."
 *
 * So the bubble is rebuilt here from the approved template the send named.
 * DERIVED ON READ, never stored — the same decision, for the same reason, as
 * the advert card beside it: the template is the source of truth for its own
 * wording, and a copy written into every message row could disagree with it
 * after an edit and then there would be no way to tell which was shown.
 *
 * The picture is Meta's own CDN address for the approved file, which is what
 * the campaign preview already loads. Treat it as best-effort: it expires, and
 * an expired thumbnail must degrade to a captioned bubble, never to an error.
 */
export interface TemplateCard {
  /** The template's own name, so a colleague can find what was sent. */
  name: string | null;
  /** 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'TEXT', or null for no header. */
  headerFormat: string | null;
  headerText: string | null;
  /** Meta's CDN address for the approved header file. Expires. */
  headerImageUrl: string | null;
  /** The approved wording, with this send's own variables substituted. */
  body: string | null;
  footerText: string | null;
}

/**
 * Build the card from a template asset's metadata and the parameters one send
 * supplied for it.
 *
 * `parameters` are the positional values that filled {{1}}, {{2}}… for THIS
 * recipient, read off the send's own stored components. A template with no
 * variables has none, and its approved wording is already what was shown.
 */
export function templateCardFrom(
  name: string | null,
  metadata: unknown,
  parameters: string[] = [],
): TemplateCard | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = metadata as Record<string, unknown>;

  /*
   * `bodySource` is the approved text WITH its {{n}} markers; `bodyPreview` is
   * the same text with the provider's sample values already substituted.
   *
   * Source first, filled with this recipient's own values — a preview shows
   * whoever the sample named, and showing a colleague "Hi Priya" on Anjali's
   * thread is worse than showing her nothing. Preview is the fallback only
   * when there is no source to fill, and then only because it is at least the
   * right words.
   */
  const source = str(raw.bodySource);
  const body = source ? fillSlots(source, parameters) : str(raw.bodyPreview);

  return {
    name,
    headerFormat: str(raw.headerFormat)?.toUpperCase() ?? null,
    headerText: str(raw.headerText),
    headerImageUrl: str(raw.headerImageUrl),
    body,
    footerText: str(raw.footerText),
  };
}

/**
 * Substitute {{1}}, {{2}}… with the values this send supplied.
 *
 * A slot with no value is LEFT AS IT IS rather than emptied. An unfilled slot
 * is a bug worth seeing; a silently blank one reads as a sentence the customer
 * was actually sent.
 */
function fillSlots(text: string, parameters: string[]) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, index: string) => {
    const value = parameters[Number(index) - 1];
    return typeof value === 'string' && value.length ? value : whole;
  });
}

/**
 * The positional body parameters out of the components one send stored.
 *
 * Only the `body` component is read. A header parameter is the picture's media
 * id, which belongs to no slot in the wording, and a button parameter is a URL
 * suffix — substituting either into the text would corrupt the sentence.
 */
export function bodyParametersFrom(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const body = components.find(
    (c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'body',
  ) as { parameters?: unknown } | undefined;
  if (!body || !Array.isArray(body.parameters)) return [];
  return body.parameters.map((p) => {
    if (p && typeof p === 'object') {
      const text = (p as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    return '';
  });
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Which approved template a stored message named, if any.
 *
 * `payload.omnichannel` is the delivery instruction the outbox wrote when the
 * message was queued, and `templateAssetId` is the only durable link from a
 * sent message back to the shape the customer actually saw.
 */
export function templateAssetIdFrom(payload: unknown): string | null {
  const omni = omnichannelOf(payload);
  return omni ? str(omni.templateAssetId) : null;
}

/** The template components that same instruction stored, for its variables. */
export function templateComponentsFrom(payload: unknown): unknown {
  const omni = omnichannelOf(payload);
  return omni ? omni.templateComponents : null;
}

function omnichannelOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const omni = (payload as Record<string, unknown>).omnichannel;
  if (!omni || typeof omni !== 'object' || Array.isArray(omni)) return null;
  return omni as Record<string, unknown>;
}
