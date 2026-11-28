import {
  TemplateParameterError,
  normaliseTemplateComponents,
  shapeTemplateComponents,
  templateSlotCount,
} from './template-parameters';

/**
 * The values somebody typed, on their way to the provider.
 *
 * The fault this file exists for (28 Nov): the client sent the template
 * "newmessage" from a thread with "Sneha" typed into `{{1}}`, and the stored
 * row carried `templateComponents: [[]]` — the ValidationPipe had coerced each
 * component into an `Array`, which `JSON.stringify` empties. She then read
 * "Hello {{1}}, hope you are having a good day!" in the inbox and concluded a
 * customer had been sent a literal placeholder. Nobody had been sent anything:
 * the template was PENDING at Meta and the send was blocked. On an approved
 * template it would have gone out hollow.
 *
 * So the first test here is that exact array, and the rest are the ways a
 * parameter block can be wrong that a person can still fix.
 */
describe('shaping a template parameter block', () => {
  const ONE = { templateName: 'newmessage', slots: 1 };

  it('carries one value in the shape Meta accepts', () => {
    expect(shapeTemplateComponents({ ...ONE, values: ['Sneha'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] },
    ]);
  });

  it('keeps several values in slot order, which is positional at Meta', () => {
    expect(
      shapeTemplateComponents({
        templateName: 'quotation_pdf_v1',
        slots: 3,
        values: ['Sneha Chouksey', 'Q-1042', '₹1,24,500'],
      }),
    ).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Sneha Chouksey' },
          { type: 'text', text: 'Q-1042' },
          { type: 'text', text: '₹1,24,500' },
        ],
      },
    ]);
  });

  it('leaves an emoji in a value exactly as typed', () => {
    // A jewellery chain's own wording carries them, and a mangled emoji is a
    // customer reading mojibake. Nothing here may normalise it away.
    expect(shapeTemplateComponents({ ...ONE, values: ['Sneha 💎'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sneha 💎' }] },
    ]);
  });

  it('collapses a newline rather than refusing the send', () => {
    /*
     * Meta refuses a parameter containing a newline, a tab or four consecutive
     * spaces (#132000), so the choice is between a customer reading the words
     * on one line and a customer reading nothing. The words win — and this is
     * the same rule campaign-variables applies to a broadcast, from the same
     * function, so a pasted name cannot be collapsed one way here and another
     * way there.
     */
    expect(
      shapeTemplateComponents({ ...ONE, values: ['Sneha\nChouksey\t(Indore)'] }),
    ).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sneha Chouksey (Indore)' }] },
    ]);
    expect(shapeTemplateComponents({ ...ONE, values: ['Sneha    Chouksey'] })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sneha Chouksey' }] },
    ]);
  });

  it('refuses a value that is only whitespace, naming the slot and the template', () => {
    // It collapses to nothing, and Meta refuses a blank parameter as firmly as
    // a missing one — so this is the empty send wearing a disguise.
    expect(() => shapeTemplateComponents({ ...ONE, values: ['   '] })).toThrow(
      TemplateParameterError,
    );
    expect(() => shapeTemplateComponents({ ...ONE, values: ['\n'] })).toThrow(
      /\{\{1\}\} in the template "newmessage" came through empty/,
    );
  });

  it('names every empty slot, not just the first', () => {
    expect(() =>
      shapeTemplateComponents({
        templateName: 'offer_v2',
        slots: 3,
        values: ['Sneha', '', ' '],
      }),
    ).toThrow(/\{\{2\}\}, \{\{3\}\} in the template "offer_v2" came through empty/);
  });

  it('sends no component block at all for a template with no variables', () => {
    // "nailsevent" has an image header and no body variables. An empty
    // parameter list is refused by Meta as firmly as a missing one, so the
    // correct block is no block.
    expect(
      shapeTemplateComponents({ templateName: 'nailsevent', slots: 0, values: [] }),
    ).toBeUndefined();
  });

  it('refuses values for a template that has no variables', () => {
    expect(() =>
      shapeTemplateComponents({ templateName: 'nailsevent', slots: 0, values: ['Sneha'] }),
    ).toThrow(/"nailsevent" has no variables/);
  });

  it('refuses fewer values than slots, naming the ones nothing fills', () => {
    expect(() =>
      shapeTemplateComponents({ templateName: 'offer_v2', slots: 3, values: ['Sneha'] }),
    ).toThrow(/needs a value for \{\{2\}\}, \{\{3\}\}/);
  });

  it('refuses more values than slots, because the rest reach nobody', () => {
    expect(() =>
      shapeTemplateComponents({ ...ONE, values: ['Sneha', 'Indore'] }),
    ).toThrow(/only goes up to \{\{1\}\}, and 2 values were sent/);
  });

  it('checks the content but not the count when the template records no slots', () => {
    // An old row with neither bodySource nor variables cannot say how many
    // placeholders it has, and inventing a count there would refuse a send that
    // has always worked.
    expect(
      shapeTemplateComponents({ templateName: 'legacy', slots: null, values: ['Sneha'] }),
    ).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }]);
    expect(() =>
      shapeTemplateComponents({ templateName: 'legacy', slots: null, values: [' '] }),
    ).toThrow(TemplateParameterError);
  });
});

describe('re-deriving a submitted parameter block', () => {
  const ONE = { templateName: 'newmessage', slots: 1 };

  it('refuses the [[]] of 28 Nov instead of queueing it', () => {
    /*
     * This is the literal value the production row held. Each component had
     * been coerced into an `Array` carrying `type` and `parameters` as named
     * properties, which serialise to nothing — so by the time it reached the
     * database the typed value was gone and the block looked like a list
     * containing an empty list.
     */
    expect(() => normaliseTemplateComponents({ ...ONE, components: [[]] })).toThrow(
      /did not arrive in a shape the provider accepts/,
    );
  });

  it('passes a correct block through unchanged', () => {
    const components = [{ type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }];
    expect(normaliseTemplateComponents({ ...ONE, components })).toEqual(components);
  });

  it('refuses a template with variables sent with no block at all', () => {
    expect(() =>
      normaliseTemplateComponents({ ...ONE, components: undefined }),
    ).toThrow(/The template "newmessage" needs a value for \{\{1\}\}/);
  });

  it('accepts no block for a template with no variables', () => {
    expect(
      normaliseTemplateComponents({
        templateName: 'nailsevent',
        slots: 0,
        components: undefined,
      }),
    ).toBeUndefined();
  });

  it('refuses a body block whose parameters are empty', () => {
    // The shape that reaches Meta as "(#132000) number of parameters does not
    // match", one recipient at a time, invisibly from the inbox.
    expect(() =>
      normaliseTemplateComponents({ ...ONE, components: [{ type: 'body', parameters: [] }] }),
    ).toThrow(/needs a value for \{\{1\}\}/);
  });

  it('refuses a body block with no parameters key', () => {
    expect(() =>
      normaliseTemplateComponents({ ...ONE, components: [{ type: 'body' }] }),
    ).toThrow(/carries no list of values/);
  });

  it('refuses two body blocks, which Meta allows one of', () => {
    expect(() =>
      normaliseTemplateComponents({
        ...ONE,
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] },
        ],
      }),
    ).toThrow(/two body blocks/);
  });

  it('refuses a value that is not text', () => {
    expect(() =>
      normaliseTemplateComponents({
        ...ONE,
        components: [{ type: 'body', parameters: [{ type: 'text', text: 42 }] }],
      }),
    ).toThrow(/something other than text/);
  });

  it('keeps a media header where it was, and rebuilds only the body', () => {
    // The header is decided at delivery from the template's own metadata
    // (media-header-send), and a carousel's cards are matched positionally, so
    // neither is this function's to touch.
    const header = { type: 'header', parameters: [{ type: 'image', image: { id: '9' } }] };
    expect(
      normaliseTemplateComponents({
        ...ONE,
        components: [header, { type: 'body', parameters: [{ type: 'text', text: ' Sneha ' }] }],
      }),
    ).toEqual([header, { type: 'body', parameters: [{ type: 'text', text: 'Sneha' }] }]);
  });

  it('leaves a header-only block alone for a template with no variables', () => {
    const header = { type: 'header', parameters: [{ type: 'image', image: { id: '9' } }] };
    expect(
      normaliseTemplateComponents({
        templateName: 'nailsevent',
        slots: 0,
        components: [header],
      }),
    ).toEqual([header]);
  });

  it('collapses a newline that arrived inside a submitted value', () => {
    expect(
      normaliseTemplateComponents({
        ...ONE,
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Sneha\nji 💎' }] }],
      }),
    ).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Sneha ji 💎' }] }]);
  });
});

describe('counting a template\'s slots', () => {
  it('reads the body as Meta holds it, placeholders intact', () => {
    expect(
      templateSlotCount({ bodySource: 'Hello {{1}}, hope you are having a good day!' }),
    ).toBe(1);
  });

  it('counts a repeated placeholder once, as Meta does', () => {
    expect(templateSlotCount({ bodySource: 'Hi {{1}}, {{2}} is ready, {{1}}.' })).toBe(2);
  });

  it('believes the body over an empty variables list', () => {
    /*
     * The trap. A template DISCOVERED at the provider is stored with
     * `variables: []` whatever its body says — "newmessage" itself is one, with
     * `metadata.variables: ["{{1}}"]` only because it was also submitted here.
     * Reading the empty list as "no variables" would refuse every correct send
     * of every template created at Meta rather than in this app.
     */
    expect(templateSlotCount({ bodySource: 'Hello {{1}}!', variables: [] })).toBe(1);
  });

  it('falls back to the recorded variables when there is no body source', () => {
    expect(templateSlotCount({ variables: ['{{1}}', '{{2}}'] })).toBe(2);
  });

  it('is unknown rather than zero when nothing records the placeholders', () => {
    // bodyPreview has the approved examples substituted in, so it cannot tell a
    // template with no variables from one whose variables are already filled. A
    // wrong zero here refuses a legitimate send.
    expect(templateSlotCount({ bodyPreview: 'Hello Priya, hope you are well!' })).toBeNull();
    expect(templateSlotCount({})).toBeNull();
    expect(templateSlotCount(null)).toBeNull();
  });
});
