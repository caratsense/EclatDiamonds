import type { IndustryPack } from './types';
import type { OrgSettings } from '../org-settings';

/**
 * Remembering the wording the industry pack itself wrote, so a later pack can
 * correct it without overwriting the tenant.
 *
 * ## What still lives here, and what no longer does
 *
 * The CRM funnel used to be tracked here too, because `Pipeline` and
 * `PipelineStage` had no `packCode` column. They have one now
 * (20260908190000_pipeline_pack_ownership), ownership sits beside the row it
 * describes, and the `pipeline` half of this record was dropped by that
 * migration. What remains is the QUALIFICATION QUESTIONS, which are stored as
 * objects inside `settings.crmQualification` and so have no row of their own to
 * stamp.
 *
 * ## Why a record rather than a guess
 *
 * The tempting fix is to compare a stored prompt against the OUTGOING pack's
 * prompt and update when they match. That is a guess dressed as a check: it
 * cannot tell "the tenant never touched this" from "the tenant typed the same
 * words", and it breaks entirely once a tenant has been through three packs. So
 * the record holds the exact strings the last successful apply wrote; a question
 * that still equals what we recorded is ours to update, and anything else
 * belongs to the tenant and is left alone.
 *
 * ## What "no record" means
 *
 * A tenant provisioned before this existed has no `packManaged` block. Their
 * questions are then treated as TENANT-OWNED and never rewritten. That is the
 * safe reading — the same "leave it alone" the layer promised all along, and it
 * is what keeps Eclat's wording untouched by any of this. New tenants get a
 * record from their very first apply, so they converge from then on.
 */

export interface PackManagedRecord {
  /** The pack that wrote the values below. */
  packCode: string;
  packVersion: number;
  /** qualification question key -> the prompt this pack wrote. */
  qualificationPrompts?: Record<string, string>;
}

/** The question shape stored in `settings.crmQualification.questions`. */
export interface ManagedQuestion {
  key: string;
  prompt: string;
  requirement: string;
  required?: boolean;
}

/** The wording a pack gives a qualification field. Shared with signup. */
export function qualificationPromptFor(key: string): string {
  const label = key.replace(/_/g, ' ');
  return `What did the customer say about ${label}?`;
}

/** The questions a pack seeds for its qualification fields. */
export function packQuestions(pack: IndustryPack): ManagedQuestion[] {
  return (pack.onboarding?.qualificationFields ?? []).map((field) => ({
    key: field,
    prompt: qualificationPromptFor(field),
    requirement: field,
  }));
}

/** The record to store after applying `pack`. */
export function recordFor(pack: IndustryPack): PackManagedRecord {
  return {
    packCode: pack.code,
    packVersion: pack.version,
    qualificationPrompts: Object.fromEntries(
      packQuestions(pack).map((q) => [q.key, q.prompt]),
    ),
  };
}

/** Read the previous record, if this tenant has one. */
export function readRecord(settings: OrgSettings): PackManagedRecord | null {
  const raw = settings.packManaged;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Partial<PackManagedRecord>;
  return typeof rec.packCode === 'string' ? (rec as PackManagedRecord) : null;
}

/**
 * Merge a pack's questions into the tenant's, honouring the ownership record.
 *
 * Rules, in order:
 *  - a question the tenant reworded, or added themselves, is kept verbatim;
 *  - a question still matching what the previous pack wrote is replaced by the
 *    new pack's wording, or dropped if the new pack has no such field;
 *  - the new pack's remaining questions are appended.
 *
 * Order is preserved for everything that survives, because a reordered
 * questionnaire reads like a changed one.
 */
export function mergeQuestions(
  existing: ManagedQuestion[],
  pack: IndustryPack,
  previous: PackManagedRecord | null,
): ManagedQuestion[] {
  const incoming = packQuestions(pack);
  const incomingByKey = new Map(incoming.map((q) => [q.key, q]));
  const previouslyOurs = previous?.qualificationPrompts ?? {};

  const out: ManagedQuestion[] = [];
  const placed = new Set<string>();

  for (const question of existing) {
    const wasOurs = previouslyOurs[question.key] === question.prompt;
    if (!wasOurs) {
      // Tenant wording (or a tenant-invented question). Untouchable.
      out.push(question);
      placed.add(question.key);
      continue;
    }
    const replacement = incomingByKey.get(question.key);
    if (replacement) {
      out.push(replacement);
      placed.add(question.key);
    }
    // else: ours, and the new industry does not ask it. Drop it.
  }

  for (const question of incoming) {
    if (!placed.has(question.key)) out.push(question);
  }
  return out;
}
