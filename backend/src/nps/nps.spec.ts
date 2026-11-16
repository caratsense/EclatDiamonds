import { NPS_STAGE_LABELS, NPS_STAGES, npsReplyState, npsStage } from './nps-stage';
import {
  matchNpsResponse,
  normaliseNpsPhone,
  npsImportKey,
  parseRecommendScore,
} from './nps-match';

const AT = (iso: string) => new Date(iso);
const NOW = AT('2026-11-16T12:00:00Z');

describe('NPS stage', () => {
  it('labels every stage', () => {
    for (const s of NPS_STAGES) expect(NPS_STAGE_LABELS[s]).toBeTruthy();
  });

  it('is pending before anything goes out', () => {
    expect(npsStage({}, NOW)).toBe('pending_initial');
  });

  it('is sent once the provider took it', () => {
    expect(npsStage({ sentAt: AT('2026-11-15T10:00:00Z') }, NOW)).toBe('initial_sent');
  });

  describe('a WhatsApp reply is not a form submission', () => {
    // The single most important rule in the client's brief: "Do not mark a form
    // complete just because a customer replied on WhatsApp."
    const replied = {
      sentAt: AT('2026-11-15T10:00:00Z'),
      repliedAt: AT('2026-11-15T10:05:00Z'),
    };

    it('leaves the ask awaiting a response', () => {
      expect(npsStage(replied, NOW)).toBe('awaiting_response');
    });

    it('reports the reply as a reply, not a submission', () => {
      expect(npsReplyState(replied)).toBe('replied');
    });

    it('only a submitted form completes it', () => {
      expect(npsStage({ ...replied, respondedAt: NOW }, NOW)).toBe('completed');
      expect(npsReplyState({ ...replied, respondedAt: NOW })).toBe('submitted');
    });

    it('a matched sheet response completes it too', () => {
      expect(npsStage({ ...replied, hasMatchedResponse: true }, NOW)).toBe('completed');
    });
  });

  describe('reminders', () => {
    const sent = { sentAt: AT('2026-11-14T10:00:00Z') };

    it('falls due only once the time has passed', () => {
      expect(npsStage({ ...sent, reminderDueAt: AT('2026-11-17T10:00:00Z') }, NOW)).toBe('initial_sent');
      expect(npsStage({ ...sent, reminderDueAt: AT('2026-11-15T10:00:00Z') }, NOW)).toBe('reminder_due');
    });

    it('is never due when the initial message never went', () => {
      // Reminding somebody of a message they never got is the worst outcome
      // available, so the stage refuses to ask for it.
      expect(npsStage({ reminderDueAt: AT('2026-11-15T10:00:00Z') }, NOW)).toBe('pending_initial');
    });

    it('moves on once it is sent', () => {
      expect(
        npsStage({ ...sent, reminderDueAt: AT('2026-11-15T10:00:00Z'), reminderSentAt: NOW }, NOW),
      ).toBe('reminder_sent');
    });
  });

  describe('precedence', () => {
    it('a completed form outranks a failed send', () => {
      // They answered anyway; the failure no longer needs anybody's attention.
      expect(npsStage({ failed: true, respondedAt: NOW }, NOW)).toBe('completed');
    });

    it('a failure outranks everything else, so it is never hidden', () => {
      expect(npsStage({ failed: true, sentAt: AT('2026-11-15T10:00:00Z') }, NOW)).toBe('failed');
    });
  });
});

describe('phone normalisation', () => {
  it('adds the country code to a bare Indian mobile', () => {
    expect(normaliseNpsPhone('8888155700')).toBe('918888155700');
  });

  it('survives the number arriving as a float from the sheet', () => {
    // Sheets and Excel hand numbers back as doubles. String(8888155700.0) is
    // "8888155700.0", and stripping non-digits gives an 11-digit number that
    // matches nothing — this is the real bug from the supplied workbook.
    expect(normaliseNpsPhone(8888155700.0)).toBe('918888155700');
    expect(normaliseNpsPhone(8006040909.0)).toBe('918006040909');
  });

  it.each([
    ['+91 88881 55700', '918888155700'],
    ['088881 55700', '918888155700'],
    ['918888155700', '918888155700'],
    ['  8888-155-700 ', '918888155700'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseNpsPhone(input)).toBe(expected);
  });

  it('keeps a foreign number rather than forcing it to India', () => {
    expect(normaliseNpsPhone('+1 415 555 2671')).toBe('14155552671');
  });

  it.each([null, undefined, '', 'not a number', '123'])('refuses %s', (bad) => {
    expect(normaliseNpsPhone(bad)).toBeNull();
  });
});

describe('matching a response to a visit', () => {
  const submitted = AT('2026-11-13T13:08:59Z');
  const visit = (id: string, iso: string, name = 'A'): Parameters<typeof matchNpsResponse>[2][number] => ({
    checkInId: id,
    partyId: `party-${id}`,
    visitAt: AT(iso),
    customerName: name,
  });

  it('matches a single prior visit on the number', () => {
    const r = matchNpsResponse(submitted, '918888155700', [visit('v1', '2026-11-10T15:43:00Z')]);
    expect(r.state).toBe('matched');
    expect(r.checkInId).toBe('v1');
  });

  it('matches the NEAREST prior visit when somebody came more than once', () => {
    const r = matchNpsResponse(submitted, '918888155700', [
      visit('old', '2026-10-01T10:00:00Z'),
      visit('recent', '2026-11-12T10:00:00Z'),
    ]);
    expect(r.state).toBe('matched');
    expect(r.checkInId).toBe('recent');
    expect(r.note).toContain('2 prior visits');
  });

  it('never matches on a name', () => {
    // The workbook's own case: the response says "Ronit Gurav", the register
    // row on that number says "VIKAS JEWELLERS". The number is what decides.
    const r = matchNpsResponse(submitted, '918888155700', [
      visit('v1', '2026-11-10T15:43:00Z', 'VIKAS JEWELLERS'),
    ]);
    expect(r.state).toBe('matched');
    expect(r.checkInId).toBe('v1');
  });

  it('leaves a response with no number unmatched and visible', () => {
    const r = matchNpsResponse(submitted, null, [visit('v1', '2026-11-10T10:00:00Z')]);
    expect(r.state).toBe('unmatched');
    expect(r.note).toContain('matching by name is not allowed');
  });

  it('leaves a response with no visit unmatched', () => {
    expect(matchNpsResponse(submitted, '919999999999', []).state).toBe('unmatched');
  });

  it('is ambiguous when two visits sit at the same moment', () => {
    const r = matchNpsResponse(submitted, '918888155700', [
      visit('a', '2026-11-10T10:00:00Z'),
      visit('b', '2026-11-10T10:00:00Z'),
    ]);
    expect(r.state).toBe('ambiguous');
    expect(r.checkInId).toBeNull();
  });

  it('is ambiguous when every visit is after the submission', () => {
    const r = matchNpsResponse(submitted, '918888155700', [visit('later', '2026-11-20T10:00:00Z')]);
    expect(r.state).toBe('ambiguous');
    expect(r.note).toContain('after this submission');
  });
});

describe('recommend score', () => {
  it.each([
    ['10 - Extremely likely', 10],
    ['0 - Not at all likely', 0],
    [9, 9],
    ['7', 7],
  ])('reads %s as %s', (input, expected) => {
    expect(parseRecommendScore(input)).toBe(expected);
  });

  it.each(['Extremely likely', '', null, undefined, '11', -1])(
    'returns null for %s rather than guessing',
    (bad) => {
      expect(parseRecommendScore(bad)).toBeNull();
    },
  );
});

describe('import key', () => {
  it('is stable for the same row, so a re-import updates', () => {
    const a = npsImportKey('org', AT('2026-11-13T13:08:59Z'), '918888155700');
    const b = npsImportKey('org', AT('2026-11-13T13:08:59Z'), '918888155700');
    expect(a).toBe(b);
  });

  it('separates a follow-up from a response submitted at the same instant', () => {
    const at = AT('2026-11-15T12:21:53Z');
    expect(npsImportKey('org', at, '918815940695', 'response')).not.toBe(
      npsImportKey('org', at, '918815940695', 'followup'),
    );
  });

  it('separates tenants', () => {
    const at = AT('2026-11-13T13:08:59Z');
    expect(npsImportKey('org-a', at, '91888', 'response')).not.toBe(
      npsImportKey('org-b', at, '91888', 'response'),
    );
  });
});
