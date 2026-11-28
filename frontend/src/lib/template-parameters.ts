/**
 * The values somebody typed into a template's `{{1}}`, `{{2}}` …, in the shape
 * WhatsApp takes them.
 *
 * ## The fault this exists for (28 Nov)
 *
 * The client sent the template "newmessage" from a thread with "Sneha" typed
 * into `{{1}}`, and the stored message said
 * `payload.omnichannel.templateComponents: [[]]` — an array holding an empty
 * array, with her value nowhere in it. The inbox then drew the template's own
 * wording, "Hello {{1}}, hope you are having a good day!", and she reasonably
 * read that as a customer having been sent a literal placeholder.
 *
 * The browser was not at fault — the block left here correctly shaped and was
 * flattened by the server's request pipeline (see the omnichannel DTO, and
 * `backend/src/omnichannel/template-parameters.ts` for the mechanism). But the
 * shaping lived inline in `useSendTemplateReply`, where nothing could assert
 * it, so there was no test anywhere that said what this request body must look
 * like. That is what this file is: one function, one test file, and the only
 * place on this side that decides the wire shape of a template send.
 *
 * ## What it deliberately does NOT do
 *
 * Refuse. An empty slot, a value too many, a template with no variables sent
 * values — the server names the template and the slot in a sentence the dialog
 * already shows (`apiErrorMessage`), and two refusals written in two places
 * drift into disagreeing with each other. The dialog's own send button stays
 * disabled while a slot is blank; this function just does not quietly repair
 * anything on the way past.
 */

/**
 * Collapsed the way Meta requires: no newline, no tab, no run of four or more
 * spaces in a parameter (#132000 refuses the whole message).
 *
 * Collapsed and not refused, because the choice is between a customer reading
 * a pasted name on one line and a customer reading nothing. Identical to
 * `flatten` in the backend's crm/campaign-variables, which every broadcast and
 * quick reply already goes through.
 */
export function flattenTemplateParameter(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The `components` block for these values, or undefined when there are none.
 *
 * Undefined rather than an empty array, and omitted from the request rather
 * than sent: Meta refuses an empty parameter list as firmly as a missing one,
 * so a template with no variables has to travel with no block at all.
 */
export function templateParameterComponents(values: string[]): unknown[] | undefined {
  if (!values.length) return undefined;
  return [
    {
      type: "body",
      parameters: values.map((value) => ({
        type: "text",
        text: flattenTemplateParameter(value),
      })),
    },
  ];
}
