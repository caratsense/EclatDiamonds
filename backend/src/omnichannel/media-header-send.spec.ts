import {
  buildMediaHeaderComponent,
  planMediaHeader,
  withMediaHeader,
} from './media-header-send';

/**
 * Sending a template whose header is a file.
 *
 * The trap this file exists for cost a whole broadcast: "nailsevent" has an
 * IMAGE header and no body variables, so the send carried no components at
 * all, and Meta refused all 125 of them with "(#132012) Parameter format does
 * not match format in the created template". The approved template holds the
 * picture for REVIEW; every send has to carry it for DELIVERY.
 */
describe('planning a template send with a media header', () => {
  it('leaves a text-header template alone', () => {
    expect(planMediaHeader('hello_world', { headerFormat: 'TEXT', headerText: 'Hello' })).toEqual({
      kind: 'none',
    });
  });

  it('leaves a template with no header at all alone', () => {
    expect(planMediaHeader('new_message', {})).toEqual({ kind: 'none' });
    expect(planMediaHeader('new_message', null)).toEqual({ kind: 'none' });
  });

  it('prefers our own copy of the picture over the provider\'s', () => {
    expect(
      planMediaHeader('nailsevent', {
        headerFormat: 'IMAGE',
        headerImageKey: 'template-images/abc.jpg',
        headerImageUrl: 'https://scontent.whatsapp.net/v/t61/908779194',
      }),
    ).toEqual({ kind: 'stored', format: 'IMAGE', storageKey: 'template-images/abc.jpg' });
  });

  it('falls back to the approved copy at the provider, which is all most templates have', () => {
    expect(
      planMediaHeader('nailsevent', {
        headerFormat: 'IMAGE',
        headerImageUrl: 'https://scontent.whatsapp.net/v/t61/908779194',
      }),
    ).toEqual({
      kind: 'approved',
      format: 'IMAGE',
      url: 'https://scontent.whatsapp.net/v/t61/908779194',
    });
  });

  it('reads the format whatever case the provider wrote it in', () => {
    const plan = planMediaHeader('clip', {
      headerFormat: 'video',
      headerImageUrl: 'https://scontent.whatsapp.net/v/t61/clip',
    });
    expect(plan).toMatchObject({ kind: 'approved', format: 'VIDEO' });
  });

  it('refuses, by name, a picture header whose picture we cannot produce', () => {
    const plan = planMediaHeader('nailsevent', { headerFormat: 'IMAGE' });
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toContain('"nailsevent"');
    expect(plan.kind === 'refuse' && plan.reason).toContain('picture');
  });

  it('will not treat an http address as a copy it can use', () => {
    // A plain http address is not something the provider ever returns, so it is
    // a sign of edited metadata rather than a picture to send.
    expect(planMediaHeader('nailsevent', {
      headerFormat: 'IMAGE',
      headerImageUrl: 'http://example.test/header.jpg',
    }).kind).toBe('refuse');
  });

  it('refuses a document header rather than sending the specimen Meta reviewed', () => {
    const plan = planMediaHeader('quotation_pdf_v1', {
      headerFormat: 'DOCUMENT',
      headerImageUrl: 'https://scontent.whatsapp.net/v/t61/847828048',
    });
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toContain('"quotation_pdf_v1"');
    expect(plan.kind === 'refuse' && plan.reason).toContain('attached');
  });

  it('names the template even when the name is missing', () => {
    const plan = planMediaHeader('', { headerFormat: 'IMAGE' });
    expect(plan.kind === 'refuse' && plan.reason).toContain('this template');
  });
});

describe('the media header send component', () => {
  it('names the picture by media id, not by link or creation handle', () => {
    expect(buildMediaHeaderComponent('IMAGE', 'media-1')).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { id: 'media-1' } }],
    });
  });

  it('uses the parameter name the format asks for', () => {
    expect(buildMediaHeaderComponent('DOCUMENT', 'media-2').parameters[0]).toEqual({
      type: 'document',
      document: { id: 'media-2' },
    });
    expect(buildMediaHeaderComponent('VIDEO', 'media-3').parameters[0]).toEqual({
      type: 'video',
      video: { id: 'media-3' },
    });
  });

  it('refuses to build a header around no file', () => {
    expect(() => buildMediaHeaderComponent('IMAGE', '')).toThrow(/media id/);
  });
});

describe('putting the header among the send\'s components', () => {
  it('keeps the body a template already filled in', () => {
    const body = { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] };
    expect(withMediaHeader([body], 'IMAGE', 'media-1')).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
      body,
    ]);
  });

  it('carries a header even when the template has no variables at all', () => {
    // "nailsevent" is exactly this: an image header and an empty body, which is
    // why the broadcast sent no components and reached nobody.
    expect(withMediaHeader(undefined, 'IMAGE', 'media-1')).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
    ]);
  });

  it('replaces a header the caller had already built, because Meta allows one', () => {
    const stale = { type: 'header', parameters: [{ type: 'image', image: { id: 'old' } }] };
    expect(withMediaHeader([stale], 'IMAGE', 'media-1')).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
    ]);
  });
});
