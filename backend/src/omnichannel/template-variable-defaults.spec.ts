import {
  TEMPLATE_VARIABLE_SOURCES,
  TemplateDraftError,
  buildTemplatePayload,
  parseVariableDefaults,
  variableDefaultsFrom,
  variableDefaultsMetadata,
  type TemplateDraft,
} from './template-draft';
import {
  VARIABLE_SOURCES,
  parseVariableMappings,
  resolveVariables,
} from '../crm/campaign-variables';

/**
 * What normally fills `{{1}}`, said once on the template.
 *
 * The client wrote a template whose whole body was `{{1}}`, put "Priya" in as
 * the sample, and asked where she tells the system that this is a customer's
 * name. The sample is for Meta's reviewer and never leaves the building; the
 * real mapping was on the broadcast, so it existed and was invisible from the
 * screen she was on, and had to be re-chosen on every send.
 *
 * These tests hold the two things that make the remembered answer safe:
 *   - a default that could not be honoured is refused BEFORE the template is
 *     created at Meta, where the mistake is still free to fix;
 *   - a stored row is accepted verbatim by the broadcast's own parser. That is
 *     asserted against the real `parseVariableMappings`, not a copy of it: the
 *     two shapes drifting apart would show up as a broadcast refusing every
 *     template that carried a default, which is the kind of failure that is
 *     discovered by a campaign nobody could send.
 */
const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'nibhana_new_arrivals_v1',
  languageCode: 'en_US',
  category: 'MARKETING',
  body: 'Hello {{1}}, the new collection is in at {{2}}.',
  examples: ['Priya', 'Bandra'],
  ...over,
});

describe('TEMPLATE_VARIABLE_SOURCES', () => {
  it('offers exactly what the send path can resolve', () => {
    /*
     * The one rule no screen can show you. `resolveVariables` is handed a
     * subject of {name, branchName}; a fifth source added to the template
     * composer would be chosen, stored, pre-selected on every broadcast, and
     * then send the stand-in to every recipient with nothing logged anywhere.
     *
     * So the two lists are asserted equal. Adding a source means extending the
     * resolver and the subject fetch in the same change, and this fails until
     * both are done.
     */
    expect([...TEMPLATE_VARIABLE_SOURCES]).toEqual([...VARIABLE_SOURCES]);
  });
});

describe('parseVariableDefaults', () => {
  it('reads a choice for every variable, in slot order', () => {
    expect(
      parseVariableDefaults(
        draft({
          variableDefaults: [
            { slot: 2, source: 'branch_name', fallback: 'our store' },
            { slot: 1, source: 'customer_first_name', fallback: 'there' },
          ],
        }),
      ),
    ).toEqual([
      { slot: 1, source: 'customer_first_name', fallback: 'there' },
      { slot: 2, source: 'branch_name', fallback: 'our store' },
    ]);
  });

  it('allows a choice for only some of the variables', () => {
    // Saying what {{1}} normally is and leaving {{2}} to each broadcast is a
    // reasonable thing to want, so a subset is not an error.
    expect(
      parseVariableDefaults(
        draft({ variableDefaults: [{ slot: 1, source: 'customer_name', fallback: 'there' }] }),
      ),
    ).toHaveLength(1);
  });

  it('refuses a row for a slot the message does not have', () => {
    /*
     * The way to get one is to delete a variable from a template that already
     * had a default. The row would then fill nothing while reading on screen
     * as though it filled something.
     */
    expect(() =>
      parseVariableDefaults(
        draft({
          body: 'Hello {{1}}, the new collection is in.',
          examples: ['Priya'],
          variableDefaults: [
            { slot: 1, source: 'customer_first_name', fallback: 'there' },
            { slot: 2, source: 'branch_name', fallback: 'our store' },
          ],
        }),
      ),
    ).toThrow(/\{\{2\}\} is not in this message/);
  });

  it('refuses the same slot twice', () => {
    expect(() =>
      parseVariableDefaults(
        draft({
          variableDefaults: [
            { slot: 1, source: 'customer_first_name', fallback: 'there' },
            { slot: 1, source: 'customer_name', fallback: 'there' },
          ],
        }),
      ),
    ).toThrow(/listed twice/);
  });

  it('refuses a source nothing can resolve', () => {
    // `resolveVariables` is handed a subject of {name, branchName}. A source
    // outside that list would be chosen on the template and then send the
    // fallback to every recipient, which looks exactly like it worked.
    expect(() =>
      parseVariableDefaults(
        draft({
          variableDefaults: [
            { slot: 1, source: 'customer_gender' as never, fallback: 'there' },
          ],
        }),
      ),
    ).toThrow(/Choose what normally fills \{\{1\}\}/);
  });

  it('refuses a fixed wording with nothing in it', () => {
    expect(() =>
      parseVariableDefaults(draft({ variableDefaults: [{ slot: 1, source: 'fixed', text: '  ' }] })),
    ).toThrow(/Type the wording/);
  });

  it('refuses a customer value with no stand-in', () => {
    // Meta refuses a parameter that is an empty string, so a customer with no
    // name recorded would fail the send rather than merely read oddly.
    expect(() =>
      parseVariableDefaults(
        draft({ variableDefaults: [{ slot: 1, source: 'customer_first_name' }] }),
      ),
    ).toThrow(/something to say when a customer has no name/);
  });

  it('refuses a stand-in longer than the broadcast would accept', () => {
    expect(() =>
      parseVariableDefaults(
        draft({
          variableDefaults: [{ slot: 1, source: 'branch_name', fallback: 'x'.repeat(61) }],
        }),
      ),
    ).toThrow(/too long/);
  });

  it('flattens a pasted value rather than storing what Meta will refuse', () => {
    // Meta's own rule: no newline, no tab, no run of four or more spaces in a
    // parameter. Caught here instead of on every recipient of the first send.
    expect(
      parseVariableDefaults(
        draft({
          variableDefaults: [{ slot: 1, source: 'fixed', text: ' Diwali\n collection    now ' }],
        }),
      ),
    ).toEqual([
      { slot: 1, source: 'fixed', text: 'Diwali collection now', fallback: 'Diwali collection now' },
    ]);
  });
});

describe('variableDefaultsMetadata', () => {
  it('is null when nothing was chosen', () => {
    /*
     * Null and not an absent key: an edit MERGES over the metadata already
     * stored, so a key left out would keep the old defaults after she had just
     * cleared them, and the broadcast would go on pre-selecting a choice she
     * had removed.
     */
    expect(variableDefaultsMetadata(draft())).toBeNull();
    expect(variableDefaultsMetadata(draft({ variableDefaults: [] }))).toBeNull();
  });

  it('is the parsed rows when something was', () => {
    expect(
      variableDefaultsMetadata(
        draft({ variableDefaults: [{ slot: 1, source: 'customer_first_name', fallback: 'there' }] }),
      ),
    ).toEqual([{ slot: 1, source: 'customer_first_name', fallback: 'there' }]);
  });
});

describe('buildTemplatePayload', () => {
  it('refuses an unusable default before the template exists at Meta', () => {
    /*
     * `templateShapeMetadata` runs AFTER the create call, so a bad row found
     * there would throw on a template that already exists upstream and cannot
     * be un-created. This is the last point where the mistake is free.
     */
    expect(() =>
      buildTemplatePayload(
        draft({ variableDefaults: [{ slot: 9, source: 'customer_name', fallback: 'there' }] }),
      ),
    ).toThrow(TemplateDraftError);
  });

  it('sends nothing about the default to Meta', () => {
    // Meta approves a shape, not a mapping. The sample values are what its
    // reviewer sees; where the real value comes from is ours alone.
    const payload = buildTemplatePayload(
      draft({ variableDefaults: [{ slot: 1, source: 'customer_first_name', fallback: 'there' }] }),
    );
    expect(JSON.stringify(payload)).not.toContain('customer_first_name');
    expect(JSON.stringify(payload)).toContain('Priya');
  });
});

describe('variableDefaultsFrom', () => {
  it('reads back what was stored', () => {
    expect(
      variableDefaultsFrom([
        { slot: 1, source: 'customer_first_name', fallback: 'there' },
        { slot: 2, source: 'fixed', text: 'Diwali collection', fallback: 'Diwali collection' },
      ]),
    ).toEqual([
      { slot: 1, source: 'customer_first_name', fallback: 'there' },
      { slot: 2, source: 'fixed', text: 'Diwali collection', fallback: 'Diwali collection' },
    ]);
  });

  it('drops what it cannot read instead of throwing', () => {
    /*
     * This runs on the way out of the database, on the template LIST. A throw
     * here would take the whole screen down over one row written by an older
     * shape of this code, and the honest answer to an unreadable row is that
     * the slot has no default — which the broadcast already handles by asking.
     */
    expect(
      variableDefaultsFrom([
        null,
        'nonsense',
        { slot: 0, source: 'customer_name', fallback: 'there' },
        { slot: 1.5, source: 'customer_name', fallback: 'there' },
        { slot: 2, source: 'what_is_this', fallback: 'there' },
        { slot: 3, source: 'branch_name' },
        { slot: 4, source: 'fixed' },
        { slot: 5, source: 'customer_name', fallback: 'there' },
        { slot: 5, source: 'branch_name', fallback: 'our store' },
      ]),
    ).toEqual([{ slot: 5, source: 'customer_name', fallback: 'there' }]);
  });

  it('is empty for a template that recorded none', () => {
    expect(variableDefaultsFrom(null)).toEqual([]);
    expect(variableDefaultsFrom(undefined)).toEqual([]);
  });
});

describe('a stored default and the broadcast that pre-selects it', () => {
  const stored = variableDefaultsMetadata(
    draft({
      variableDefaults: [
        { slot: 1, source: 'customer_first_name', fallback: 'there' },
        { slot: 2, source: 'branch_name', fallback: 'our store' },
      ],
    }),
  );

  it('is accepted by the broadcast parser untouched', () => {
    // The whole point of the feature: the wizard hands these rows straight to
    // the campaign it is building. If this ever fails, every template carrying
    // a default becomes unsendable from the wizard.
    expect(() => parseVariableMappings(stored, 2)).not.toThrow();
  });

  it('resolves to the customer in front of you, never to the sample', () => {
    const mappings = parseVariableMappings(stored, 2);
    expect(resolveVariables(mappings, { name: 'Anjali Shah', branchName: 'Bandra' })).toEqual([
      'Anjali',
      'Bandra',
    ]);
    // "Priya" is the sample Meta reviewed. Nobody is ever sent it.
    expect(resolveVariables(mappings, { name: null, branchName: null })).toEqual([
      'there',
      'our store',
    ]);
  });
});
