import { parseSegmentDefinition } from './audience-segment.dsl';
import {
  ALREADY_RECEIVED_REASON,
  REACHED_STATUSES,
  audienceSnapshotWith,
  suppressedTemplateFrom,
} from './campaign-suppression';

/**
 * "These many people have already received this template, do you want to send
 * again? If no, exclude them."
 *
 * The client's sentence, and the half worth testing is "exclude them": the
 * answer has to survive every write that touches the audience snapshot, because
 * the snapshot is rebuilt on edit AND again on approval. A suppression that
 * quietly disappeared at approval would send the broadcast to exactly the
 * people she chose to leave out, at the one moment nobody is watching.
 */

const RULES = parseSegmentDefinition({
  match: 'all',
  conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }],
});

describe('an audience that leaves out people who already had the template', () => {
  it('remembers which template, not merely that something was suppressed', () => {
    // By name, because the suppression means "people who have had this
    // wording". Swapping the campaign's template must not leave it suppressing
    // the previous one's history.
    const snapshot = audienceSnapshotWith(RULES, 'nails_event');
    expect(suppressedTemplateFrom(snapshot)).toBe('nails_event');
  });

  it('leaves the rules readable by the audience compiler', () => {
    const snapshot = audienceSnapshotWith(RULES, 'nails_event');
    expect(parseSegmentDefinition(snapshot)).toEqual(RULES);
  });

  it('survives the rebuild that approval does', () => {
    const atCreate = audienceSnapshotWith(RULES, 'nails_event');
    const atApproval = audienceSnapshotWith(
      parseSegmentDefinition(atCreate),
      suppressedTemplateFrom(atCreate),
    );
    expect(suppressedTemplateFrom(atApproval)).toBe('nails_event');
    expect(parseSegmentDefinition(atApproval)).toEqual(RULES);
  });

  it('writes nothing at all when the answer was "send to everyone"', () => {
    const snapshot = audienceSnapshotWith(RULES, null);
    expect(suppressedTemplateFrom(snapshot)).toBeNull();
    expect(Object.keys(snapshot).sort()).toEqual(['conditions', 'match']);
  });

  it('can carry the answer for a campaign built from a saved audience', () => {
    // Those have no inline rules, so the snapshot is the suppression alone.
    const snapshot = audienceSnapshotWith(null, 'nails_event');
    expect(suppressedTemplateFrom(snapshot)).toBe('nails_event');
  });
});

describe('reading a snapshot that was written before any of this existed', () => {
  it('treats an untouched snapshot as no suppression', () => {
    expect(suppressedTemplateFrom(RULES)).toBeNull();
  });

  it('treats a missing snapshot as no suppression', () => {
    expect(suppressedTemplateFrom(null)).toBeNull();
    expect(suppressedTemplateFrom(undefined)).toBeNull();
  });

  it('refuses a malformed value rather than stopping an expansion', () => {
    // A Json column that has held three shapes over the product's life. The
    // safe reading of nonsense here is "send to everyone", never a crash in the
    // job that builds the recipient list.
    expect(suppressedTemplateFrom({ suppressTemplateAlreadySent: 42 })).toBeNull();
    expect(suppressedTemplateFrom({ suppressTemplateAlreadySent: '  ' })).toBeNull();
    expect(suppressedTemplateFrom(['nails_event'])).toBeNull();
    expect(suppressedTemplateFrom('nails_event')).toBeNull();
  });
});

describe('what counts as having already received it', () => {
  it('is having been messaged, never merely having been targeted', () => {
    // A broadcast that failed for somebody has not given them the message, and
    // suppressing them from the next one would guarantee they never get it.
    expect([...REACHED_STATUSES].sort()).toEqual(['delivered', 'read', 'sent']);
    for (const missed of ['pending', 'queued', 'failed', 'dead', 'excluded', 'cancelled']) {
      expect(REACHED_STATUSES).not.toContain(missed);
    }
  });

  it('records a stable reason code rather than a sentence', () => {
    // The wording on screen can be improved later without rewriting history.
    expect(ALREADY_RECEIVED_REASON).toBe('already_received_template');
  });
});
