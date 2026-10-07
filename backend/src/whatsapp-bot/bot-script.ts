/**
 * The words the customer bot says, as something a client can edit.
 *
 * The questions used to live only in `customer-flow.ts`, which meant rewording
 * one was a code change and a deploy. A jeweller should be able to decide how
 * their own shop greets a customer.
 *
 * WHAT IS EDITABLE IS THE WORDING, AND ONLY THE WORDING.
 *
 * Every option carries a stored `value` — `under_50k`, `call_later` — and those
 * values are load-bearing in three places: `next()` branches on them, the
 * free-text answer parser maps synonyms to them, and lead scoring and the
 * customer record read them back. A tenant renaming a label is harmless; a
 * tenant changing a value would silently break the branch logic and orphan
 * every answer already stored against the old one. So labels are editable,
 * values are not, the number of options is not, and the order is not.
 *
 * OVERRIDES ARE SPARSE, NEVER A SNAPSHOT.
 *
 * Only fields the tenant actually changed are stored. An untouched question
 * keeps tracking the product default and improves when the default does. This
 * is deliberate: the lead-scoring policy stores a full copy, and the moment a
 * tenant pressed Save their wording froze — later improvements never reached
 * them and nobody could tell, because the stored policy looked perfectly
 * healthy. Saving a bot script must not quietly opt a shop out of every future
 * improvement to it.
 *
 * A BLANK OVERRIDE FALLS BACK. It never leaves the bot mute: an empty prompt
 * reaching WhatsApp is a conversation that dead-ends in front of a customer.
 */
import { FLOW_STEPS, type FlowStep } from './customer-flow';

/**
 * WhatsApp truncates a list row title past 24 characters, and `renderFor` sends
 * option labels as row titles unchanged. Enforced on save so a client finds out
 * while typing rather than through a half-word in a customer's chat.
 */
export const MAX_OPTION_LABEL = 24;

/** Generous, but short enough that a prompt stays a question and not an essay. */
export const MAX_PROMPT = 300;
export const MAX_HINT = 200;

/** One step's wording, as far as a tenant may change it. */
export interface BotStepOverride {
  prompt?: string;
  hint?: string;
  /** Keyed by the option's stored `value`. The value itself is never editable. */
  options?: Record<string, string>;
}

export interface BotScript {
  /** Keyed by `FlowStep.key`. */
  steps?: Record<string, BotStepOverride>;
  /** The line after "Hi 👋" in the opening message. */
  intro?: string;
  /** The line under it, explaining why questions are coming. */
  introHint?: string;
}

/** The built-in opening lines, so the editor can show what it is overriding. */
export const DEFAULT_INTRO = 'Thanks for reaching out to *Éclat Diamonds*.';
export const DEFAULT_INTRO_HINT =
  'Just a couple of quick questions so I can show you the right pieces. Takes under a minute.';

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // Blank is not an override. Somebody clearing a box means "use the default",
  // not "say nothing" — and saying nothing is what a customer would see.
  return trimmed ? trimmed : undefined;
};

/**
 * Read whatever is stored, tolerating anything.
 *
 * Settings JSON is hand-editable and survives schema changes, so this never
 * throws: a malformed script falls back to the built-in wording rather than
 * taking the bot down. Silence from the bot is a worse failure than ignoring a
 * bad override.
 */
export function resolveBotScript(raw: unknown): BotScript {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const script: BotScript = {};

  const intro = text(input.intro);
  if (intro) script.intro = intro;
  const introHint = text(input.introHint);
  if (introHint) script.introHint = introHint;

  if (input.steps && typeof input.steps === 'object') {
    const steps: Record<string, BotStepOverride> = {};
    for (const step of FLOW_STEPS) {
      const stored = (input.steps as Record<string, unknown>)[step.key];
      if (!stored || typeof stored !== 'object') continue;
      const entry = stored as Record<string, unknown>;
      const override: BotStepOverride = {};

      const prompt = text(entry.prompt);
      if (prompt) override.prompt = prompt;
      const hint = text(entry.hint);
      if (hint) override.hint = hint;

      if (entry.options && typeof entry.options === 'object') {
        const labels: Record<string, string> = {};
        for (const option of step.options) {
          // Keyed by the option's own value, so an override for an option that
          // no longer exists is dropped rather than resurrected.
          const label = text((entry.options as Record<string, unknown>)[option.value]);
          if (label) labels[option.value] = label;
        }
        if (Object.keys(labels).length) override.options = labels;
      }

      if (Object.keys(override).length) steps[step.key] = override;
    }
    if (Object.keys(steps).length) script.steps = steps;
  }

  return script;
}

/**
 * A step as this tenant words it.
 *
 * Returns the step unchanged when nothing is overridden, so the common path
 * allocates nothing and the identity of the default steps is preserved.
 */
export function applyScript(step: FlowStep, script: BotScript | undefined): FlowStep {
  const override = script?.steps?.[step.key];
  if (!override) return step;

  const options = override.options
    ? step.options.map((o) =>
        override.options?.[o.value] ? { ...o, label: override.options[o.value] } : o,
      )
    : step.options;

  return {
    ...step,
    prompt: override.prompt ?? step.prompt,
    hint: override.hint ?? step.hint,
    options,
  };
}

/** Every step, worded for this tenant. */
export function scriptedSteps(script: BotScript | undefined): FlowStep[] {
  return FLOW_STEPS.map((step) => applyScript(step, script));
}

/** The opening message, worded for this tenant. */
export function scriptedGreeting(firstName: string | undefined, script: BotScript | undefined): string {
  return [
    firstName ? `Hi ${firstName} 👋` : 'Hi 👋',
    '',
    script?.intro ?? DEFAULT_INTRO,
    '',
    script?.introHint ?? DEFAULT_INTRO_HINT,
  ].join('\n');
}

/** A problem a person can act on, naming the field it is about. */
export interface BotScriptProblem {
  field: string;
  message: string;
}

/**
 * Check a script before it is stored.
 *
 * Length is the whole of it. Nothing here can make the bot unsafe — values and
 * branching are not exposed — so the only real failure mode is wording that
 * WhatsApp will truncate or refuse, and the caller should hear about that while
 * they are still looking at the box they typed it in.
 */
export function validateBotScript(script: BotScript): BotScriptProblem[] {
  const problems: BotScriptProblem[] = [];
  const tooLong = (value: string | undefined, max: number, field: string, what: string) => {
    if (value && value.length > max) {
      problems.push({ field, message: `${what} is ${value.length} characters; the limit is ${max}.` });
    }
  };

  tooLong(script.intro, MAX_PROMPT, 'intro', 'The opening line');
  tooLong(script.introHint, MAX_HINT, 'introHint', 'The line under the opening');

  for (const step of FLOW_STEPS) {
    const override = script.steps?.[step.key];
    if (!override) continue;
    tooLong(override.prompt, MAX_PROMPT, `steps.${step.key}.prompt`, 'The question');
    tooLong(override.hint, MAX_HINT, `steps.${step.key}.hint`, 'The hint');
    for (const [value, label] of Object.entries(override.options ?? {})) {
      tooLong(
        label,
        MAX_OPTION_LABEL,
        `steps.${step.key}.options.${value}`,
        `The answer "${label}"`,
      );
    }
  }

  return problems;
}

/** One step, as the editor needs to draw it: the default, and any override. */
export interface BotScriptStepView {
  key: string;
  defaultPrompt: string;
  defaultHint?: string;
  prompt?: string;
  hint?: string;
  options: { value: string; defaultLabel: string; label?: string }[];
}

/**
 * Everything the editing screen needs, in one shape.
 *
 * Defaults travel alongside the overrides so the screen can show the built-in
 * wording as placeholder text. That is what makes "clear the box to go back to
 * the default" an obvious action rather than a destructive-looking one.
 */
export function describeBotScript(script: BotScript): {
  intro: { default: string; value?: string };
  introHint: { default: string; value?: string };
  steps: BotScriptStepView[];
  limits: { prompt: number; hint: number; optionLabel: number };
} {
  return {
    intro: { default: DEFAULT_INTRO, value: script.intro },
    introHint: { default: DEFAULT_INTRO_HINT, value: script.introHint },
    steps: FLOW_STEPS.map((step) => {
      const override = script.steps?.[step.key];
      return {
        key: step.key,
        defaultPrompt: step.prompt,
        defaultHint: step.hint,
        prompt: override?.prompt,
        hint: override?.hint,
        options: step.options.map((o) => ({
          value: o.value,
          defaultLabel: o.label,
          label: override?.options?.[o.value],
        })),
      };
    }),
    limits: { prompt: MAX_PROMPT, hint: MAX_HINT, optionLabel: MAX_OPTION_LABEL },
  };
}
