/**
 * What goes into a template's `{{1}}`, `{{2}}` … when a broadcast is sent.
 *
 * A WhatsApp template is approved with its placeholders intact; the real values
 * travel with each individual send as positional parameters. Every automated
 * sender in this codebase hardcodes its own (the visit-feedback ask puts the
 * first name in `{{1}}` and the form link in `{{2}}`), which is right for a
 * message the product sends and impossible for one a person writes.
 *
 * So a campaign carries a MAPPING instead: one row per placeholder saying where
 * its value comes from. Before this, campaigns sent no parameters at all — a
 * template with a single `{{1}}` could be written, approved by Meta, picked for
 * a broadcast, and rejected on every single recipient.
 *
 * Pure on purpose. It is the one place that decides what a customer reads, and
 * it is worth being able to test that without a database.
 */

/** Raised for a mapping somebody can fix, phrased for them. */
export class CampaignVariableError extends Error {}

export const VARIABLE_SOURCES = [
  'customer_first_name',
  'customer_name',
  'branch_name',
  'fixed',
] as const;

export type VariableSourceKind = (typeof VARIABLE_SOURCES)[number];

export interface VariableMapping {
  /** 1-based, matching `{{n}}`. */
  slot: number;
  source: VariableSourceKind;
  /** The value itself, when `source` is 'fixed'. */
  text?: string;
  /**
   * What to send when the source is empty for this customer.
   *
   * NOT optional, and not allowed to be blank. Meta rejects a template
   * parameter that is an empty string, so a customer with no name recorded
   * would fail the send rather than merely read oddly — and on a broadcast
   * that failure is per-recipient and invisible until afterwards.
   */
  fallback: string;
}

/** The customer a send is being rendered for. */
export interface VariableSubject {
  name?: string | null;
  branchName?: string | null;
}

const MAX_FIXED = 200;
const MAX_FALLBACK = 60;

/**
 * Meta's own rule about parameter content: no newline, no tab, and no run of
 * four or more spaces. A pasted name with a line break in it would be refused
 * at the provider, so it is flattened here rather than sent and rejected.
 */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstName(full: string): string {
  return flatten(full).split(' ')[0] ?? '';
}

/**
 * Read and check a mapping against the template it is for.
 *
 * `slots` is how many placeholders the template actually has, read from what
 * Meta told us about it. A mapping is accepted only when it covers exactly
 * those — one short and the send is rejected by the provider, one extra and the
 * author believes a value is going somewhere it is not.
 */
export function parseVariableMappings(value: unknown, slots: number): VariableMapping[] {
  if (slots === 0) {
    if (Array.isArray(value) && value.length > 0) {
      throw new CampaignVariableError(
        'This template has no variables, so there are no values to fill in.',
      );
    }
    return [];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new CampaignVariableError(
      `This template has ${slots} variable${slots === 1 ? '' : 's'}. ` +
        'Say what each one should contain before sending.',
    );
  }

  const parsed = value.map((raw, i) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const slot = typeof row.slot === 'number' ? row.slot : i + 1;
    const source = row.source;
    if (typeof source !== 'string' || !VARIABLE_SOURCES.includes(source as VariableSourceKind)) {
      throw new CampaignVariableError(
        `Choose what goes into {{${slot}}}: the customer's name, their branch, or a fixed wording.`,
      );
    }
    const text = typeof row.text === 'string' ? flatten(row.text) : '';
    if (source === 'fixed') {
      if (!text) throw new CampaignVariableError(`Type the wording for {{${slot}}}.`);
      if (text.length > MAX_FIXED) {
        throw new CampaignVariableError(
          `The wording for {{${slot}}} is too long — keep it under ${MAX_FIXED} characters.`,
        );
      }
    }
    const fallback = typeof row.fallback === 'string' ? flatten(row.fallback) : '';
    /*
     * A fixed value needs no fallback: it is never empty. Everything else does,
     * because the customer record it reads from can be.
     */
    if (source !== 'fixed' && !fallback) {
      throw new CampaignVariableError(
        `Give {{${slot}}} something to say when a customer has no name on record — ` +
          'Meta refuses a message with a blank value in it.',
      );
    }
    if (fallback.length > MAX_FALLBACK) {
      throw new CampaignVariableError(
        `The stand-in for {{${slot}}} is too long — keep it under ${MAX_FALLBACK} characters.`,
      );
    }
    return {
      slot,
      source: source as VariableSourceKind,
      ...(source === 'fixed' ? { text } : {}),
      fallback: source === 'fixed' ? text : fallback,
    };
  });

  const seen = new Set(parsed.map((m) => m.slot));
  const missing: string[] = [];
  for (let n = 1; n <= slots; n += 1) if (!seen.has(n)) missing.push(`{{${n}}}`);
  if (missing.length) {
    throw new CampaignVariableError(`Nothing is filling ${missing.join(', ')}.`);
  }
  const extra = parsed.filter((m) => m.slot < 1 || m.slot > slots);
  if (extra.length) {
    throw new CampaignVariableError(
      `This template only goes up to {{${slots}}}; ` +
        `${extra.map((m) => `{{${m.slot}}}`).join(', ')} would be sent to nobody.`,
    );
  }

  return parsed.sort((a, b) => a.slot - b.slot);
}

/**
 * The parameter values for one customer, in slot order.
 *
 * Never returns a blank: an empty source falls back, and a blank fallback
 * cannot be saved, so the array that reaches Meta is always complete.
 */
export function resolveVariables(
  mappings: VariableMapping[],
  subject: VariableSubject,
): string[] {
  return [...mappings]
    .sort((a, b) => a.slot - b.slot)
    .map((m) => {
      const value =
        m.source === 'fixed'
          ? (m.text ?? '')
          : m.source === 'customer_first_name'
            ? firstName(subject.name ?? '')
            : m.source === 'customer_name'
              ? flatten(subject.name ?? '')
              : flatten(subject.branchName ?? '');
      return value || m.fallback;
    });
}

/**
 * The `components` block a template send carries, or undefined when the
 * template takes no values — Meta refuses an empty parameter list as firmly as
 * a missing one.
 */
export function templateComponentsFor(values: string[]): unknown[] | undefined {
  if (!values.length) return undefined;
  return [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }];
}

/** How many `{{n}}` a body actually uses. The template's own count, not a guess. */
export function variableSlotsIn(body: string): number {
  const found = new Set<number>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]));
  return found.size;
}
