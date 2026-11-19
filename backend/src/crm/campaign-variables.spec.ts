import {
  CampaignVariableError,
  parseVariableMappings,
  resolveVariables,
  templateComponentsFor,
  variableSlotsIn,
} from './campaign-variables';

/**
 * A broadcast used to send NO template parameters at all.
 *
 * Every automated sender in the product fills its own `{{n}}` in code — the
 * visit-feedback ask puts the first name in `{{1}}` and the link in `{{2}}`.
 * The campaign wizard let somebody pick any approved template and sent nothing,
 * so a template with a single variable was refused by Meta on every recipient,
 * after the campaign was already running, and each refusal read as that
 * customer's problem rather than the campaign's.
 *
 * These assertions are about the two ways that fails quietly: a value that
 * comes out blank (Meta refuses a blank parameter) and a count that does not
 * match the template.
 */

const name = { name: 'Priya Shah', branchName: 'Mumbai Bandra' };

describe('reading a mapping', () => {
  it('accepts one row per variable', () => {
    const m = parseVariableMappings(
      [{ slot: 1, source: 'customer_first_name', fallback: 'there' }],
      1,
    );
    expect(m).toHaveLength(1);
    expect(m[0].source).toBe('customer_first_name');
  });

  it('refuses a template whose variables nobody filled', () => {
    expect(() => parseVariableMappings(undefined, 1)).toThrow(CampaignVariableError);
    expect(() => parseVariableMappings([], 2)).toThrow(/2 variables/);
  });

  it('names the variable that was left out', () => {
    expect(() =>
      parseVariableMappings([{ slot: 1, source: 'customer_name', fallback: 'Customer' }], 2),
    ).toThrow(/\{\{2\}\}/);
  });

  it('refuses a row for a variable the template does not have', () => {
    expect(() =>
      parseVariableMappings(
        [
          { slot: 1, source: 'customer_name', fallback: 'Customer' },
          { slot: 2, source: 'fixed', text: 'Diwali' },
        ],
        1,
      ),
    ).toThrow(/only goes up to/);
  });

  it('refuses values on a template that has none', () => {
    expect(() => parseVariableMappings([{ slot: 1, source: 'fixed', text: 'x' }], 0)).toThrow(
      /no variables/,
    );
    expect(parseVariableMappings(undefined, 0)).toEqual([]);
  });

  it('demands a stand-in for anything read off the customer', () => {
    // The whole point: Meta refuses a blank parameter, so a customer with no
    // name on record would fail the send rather than merely read oddly.
    expect(() =>
      parseVariableMappings([{ slot: 1, source: 'customer_first_name', fallback: '  ' }], 1),
    ).toThrow(/no name on record/);
  });

  it('needs no stand-in for a fixed wording, which cannot be empty', () => {
    const m = parseVariableMappings([{ slot: 1, source: 'fixed', text: 'Diwali offer' }], 1);
    expect(m[0].fallback).toBe('Diwali offer');
  });

  it('refuses a fixed value that is only spaces', () => {
    expect(() => parseVariableMappings([{ slot: 1, source: 'fixed', text: '   ' }], 1)).toThrow(
      /Type the wording/,
    );
  });

  it('refuses a source nobody offers', () => {
    expect(() =>
      parseVariableMappings([{ slot: 1, source: 'customer_pan_number', fallback: 'x' }], 1),
    ).toThrow(/Choose what goes into/);
  });

  it('puts the rows in slot order whatever order they arrive in', () => {
    const m = parseVariableMappings(
      [
        { slot: 2, source: 'fixed', text: 'Sunday' },
        { slot: 1, source: 'customer_first_name', fallback: 'there' },
      ],
      2,
    );
    expect(m.map((r) => r.slot)).toEqual([1, 2]);
  });
});

describe('filling it in for one customer', () => {
  const mapping = (source: string, fallback = 'there') =>
    parseVariableMappings([{ slot: 1, source, fallback }], 1);

  it('takes the first name, not the whole name', () => {
    expect(resolveVariables(mapping('customer_first_name'), name)).toEqual(['Priya']);
  });

  it('takes the whole name when asked for it', () => {
    expect(resolveVariables(mapping('customer_name'), name)).toEqual(['Priya Shah']);
  });

  it('takes the branch', () => {
    expect(resolveVariables(mapping('branch_name'), name)).toEqual(['Mumbai Bandra']);
  });

  it('falls back when the customer has no name', () => {
    expect(resolveVariables(mapping('customer_first_name'), { name: null })).toEqual(['there']);
    expect(resolveVariables(mapping('customer_first_name'), { name: '   ' })).toEqual(['there']);
  });

  it('never returns a blank, which is what Meta refuses', () => {
    const values = resolveVariables(
      parseVariableMappings(
        [
          { slot: 1, source: 'customer_first_name', fallback: 'there' },
          { slot: 2, source: 'branch_name', fallback: 'our store' },
        ],
        2,
      ),
      {},
    );
    expect(values).toEqual(['there', 'our store']);
    expect(values.every((v) => v.trim().length > 0)).toBe(true);
  });

  it('flattens a name with a line break in it', () => {
    // Meta refuses a parameter containing a newline, a tab, or four spaces in
    // a row — a pasted name would be rejected at the provider, not here.
    expect(resolveVariables(mapping('customer_name'), { name: 'Priya\n  Shah' })).toEqual([
      'Priya Shah',
    ]);
  });
});

describe('the components block', () => {
  it('is undefined for a template with no variables', () => {
    // Meta refuses an empty parameter list as firmly as a missing one.
    expect(templateComponentsFor([])).toBeUndefined();
  });

  it('is one body component with the values in order', () => {
    expect(templateComponentsFor(['Priya', 'Bandra'])).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Priya' },
          { type: 'text', text: 'Bandra' },
        ],
      },
    ]);
  });
});

describe('counting a template’s variables', () => {
  it('counts each placeholder once', () => {
    expect(variableSlotsIn('Hi {{1}}, your order {{2}} is ready, {{1}}.')).toBe(2);
  });

  it('is zero for wording with none', () => {
    expect(variableSlotsIn('The shop is open on Sunday.')).toBe(0);
  });
});
