/**
 * What fills a template's `{{1}}`, `{{2}}` … on ONE thread send, and the
 * refusal when nothing does.
 *
 * ## The incident this exists for (28 Nov)
 *
 * A manager sent the template "newmessage" from a thread and typed "Sneha" for
 * `{{1}}`. The stored message row said:
 *
 *     templateComponents: [[]]
 *
 * — an array holding an empty array. The browser had posted the right thing,
 * `[{ type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }]`; the
 * ValidationPipe destroyed it on the way in. `templateComponents?: unknown[]`
 * reflects as `design:type = Array`, class-transformer applies that type to
 * every ELEMENT of the array, and an `Array` instance carrying `type` and
 * `parameters` as named (non-index) properties serialises to `[]`. Nothing
 * threw. In process the value still answered `.type === 'body'`, so the loss
 * surfaced only once the row was written, and only to somebody reading the JSON.
 *
 * That template was PENDING review at Meta, so the send was blocked and the
 * customer received nothing. Had it been approved, Meta would have been handed
 * a hollow block and the customer would have read "Hello {{1}}" — which is what
 * the client saw in the inbox and reasonably believed had gone out.
 *
 * The transform is fixed where it broke, on the DTO field. This module is the
 * second half: the block a send carries is produced by ONE function, and the
 * single funnel every send passes through re-derives it from the values inside
 * it, so a block that lost its values cannot be queued no matter who built it
 * or what mangled it in between.
 *
 * Pure on purpose, like `media-header-send` beside it: the exact JSON and every
 * refusal can be asserted without a tenant, a provider or an approved template.
 */

import {
  // The identical rule, from the one place that already states it: Meta refuses
  // a parameter carrying a newline, a tab or four consecutive spaces. Imported
  // rather than restated — a broadcast and a thread send have to collapse a
  // pasted name the same way or the two drift apart.
  flatten as flattenParameterText,
  templateComponentsFor,
  variableSlotsIn,
} from '../crm/campaign-variables';

/** Raised for something the person sending can read and act on. */
export class TemplateParameterError extends Error {}

/** `{{1}}`, `{{2}}` … for a sentence somebody has to read. */
function slotList(slots: number[]): string {
  return slots.map((n) => `{{${n}}}`).join(', ');
}

/**
 * How many `{{n}}` a template really has, or null when nothing on the row
 * records it.
 *
 * `bodySource` is the authority: it is the body as Meta holds it, placeholders
 * intact, written by every sync. `variables` comes second and not first because
 * a template DISCOVERED at the provider is stored with `variables: []` whatever
 * its body says — reading that as "no variables" would refuse every correct
 * send of every template created at Meta rather than here, which is most of them.
 *
 * `bodyPreview` is deliberately not consulted. It has the approved examples
 * substituted into it, so it cannot tell a template with no variables from one
 * whose variables are already filled, and a wrong zero here refuses a
 * legitimate send. Null means unknown, and unknown means the structure is
 * checked while the count is not.
 */
export function templateSlotCount(metadata: unknown): number | null {
  const raw = (metadata ?? {}) as Record<string, unknown>;
  const bodySource = typeof raw.bodySource === 'string' ? raw.bodySource : '';
  if (bodySource.trim()) return variableSlotsIn(bodySource);
  const variables = Array.isArray(raw.variables) ? raw.variables.length : 0;
  if (variables > 0) return variables;
  return null;
}

/**
 * The `components` block for these values, or undefined for a template that
 * takes none — Meta refuses an empty parameter list as firmly as a missing one.
 *
 * The JSON itself comes from `templateComponentsFor`, which the broadcast and
 * quick-reply senders already use, so the shape has exactly one definition.
 *
 * `templateName` is carried only so a refusal can name the template. "That
 * message was not sent" is a support ticket; with the template and the slot in
 * it, it is something the sender can fix on the screen they are looking at.
 */
export function shapeTemplateComponents(input: {
  templateName: string;
  /** From `templateSlotCount`. Null skips the count check, never the content one. */
  slots: number | null;
  values: string[];
}): unknown[] | undefined {
  const named = input.templateName.trim() || 'this template';
  const texts = input.values.map((value) => flattenParameterText(value ?? ''));

  if (input.slots === 0) {
    if (texts.length) {
      throw new TemplateParameterError(
        `The template "${named}" has no variables, so there are no values to send with it.`,
      );
    }
    return undefined;
  }

  if (input.slots !== null) {
    if (texts.length < input.slots) {
      const missing: number[] = [];
      for (let n = texts.length + 1; n <= input.slots; n += 1) missing.push(n);
      throw new TemplateParameterError(
        `The template "${named}" needs a value for ${slotList(missing)}. ` +
          'Nothing came through for it, so the message was not queued.',
      );
    }
    if (texts.length > input.slots) {
      throw new TemplateParameterError(
        `The template "${named}" only goes up to {{${input.slots}}}, ` +
          `and ${texts.length} values were sent — the rest would reach nobody.`,
      );
    }
  }

  /*
   * A blank is refused, never filled in on somebody's behalf. Meta rejects a
   * message with an empty parameter in it, so a slot that arrived empty is a
   * send that fails at the provider rather than one that merely reads oddly —
   * and on this path the person who can type the missing word is the one
   * looking at the screen.
   */
  const blank = texts.flatMap((text, i) => (text ? [] : [i + 1]));
  if (blank.length) {
    throw new TemplateParameterError(
      `${slotList(blank)} in the template "${named}" came through empty. ` +
        'Meta refuses a message with a blank value in it, so it was not queued.',
    );
  }

  return templateComponentsFor(texts);
}

/** A plain object, which is what every provider component is. */
function componentObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A submitted block, rebuilt from the values inside it.
 *
 * The body component is re-derived through `shapeTemplateComponents`, so
 * whatever arrives is held to the same rule as something built here. Header,
 * carousel and button components pass through in the order they came: a media
 * header is decided at delivery from the template's own metadata, and a
 * carousel's cards are matched positionally, so neither is this function's to
 * rewrite.
 *
 * Anything that is not a component object at all — the `[[]]` of 28 Nov among
 * them — is refused here rather than written to the outbox and handed to Meta.
 */
export function normaliseTemplateComponents(input: {
  templateName: string;
  slots: number | null;
  components: unknown[] | undefined;
}): unknown[] | undefined {
  const named = input.templateName.trim() || 'this template';
  const malformed = (what: string) =>
    new TemplateParameterError(
      `The values for the template "${named}" did not arrive in a shape the provider ` +
        `accepts (${what}), so nothing was queued.`,
    );

  if (!input.components) {
    // No block at all is the correct send for a template with no variables, and
    // the whole fault for one that has them.
    return shapeTemplateComponents({ ...input, values: [] });
  }

  const components = input.components.map((component) => {
    const object = componentObject(component);
    if (!object) throw malformed('a component arrived as something other than an object');
    return object;
  });

  const bodies = components.filter((component) => component.type === 'body');
  if (bodies.length > 1) throw malformed('two body blocks, where Meta allows one');

  const parameters = bodies[0]?.parameters;
  if (bodies.length && !Array.isArray(parameters)) {
    throw malformed('the body block carries no list of values');
  }

  const values = (Array.isArray(parameters) ? parameters : []).map((parameter) => {
    const object = componentObject(parameter);
    /*
     * Text is the only parameter type anything in this product sends and the
     * only one a person types. A currency or date_time parameter is refused
     * rather than passed through unread, because passing it through would leave
     * this function unable to say what the slot count had counted. If one is
     * ever needed, widen it here — this is the one place.
     */
    if (!object || object.type !== 'text' || typeof object.text !== 'string') {
      throw malformed('a value arrived as something other than text');
    }
    return object.text;
  });

  const body = shapeTemplateComponents({ ...input, values });

  // Rebuilt in place, so a header that came before the body stays before it.
  const rest = components.filter((component) => component.type !== 'body');
  if (!body) return rest.length ? rest : undefined;
  const at = components.findIndex((component) => component.type === 'body');
  const out: unknown[] = [...components];
  out.splice(at, 1, ...body);
  return out;
}
