/**
 * The customer bot's wording, as a tenant may change it.
 *
 * Pure functions, so these run without a database or WhatsApp. What is being
 * protected here is not the happy path — it is that a tenant can only ever
 * change WORDS. Every stored `value` is load-bearing: `next()` branches on it,
 * the free-text parser maps synonyms to it, and lead scoring and the customer
 * record read it back. A rename that reached a value would break branching and
 * orphan every answer already stored against the old one.
 */
import { FLOW_STEPS, parseChoice, resolveNext, stepByKey } from '../src/whatsapp-bot/customer-flow';
import {
  DEFAULT_INTRO,
  DEFAULT_INTRO_HINT,
  MAX_OPTION_LABEL,
  applyScript,
  describeBotScript,
  resolveBotScript,
  scriptedGreeting,
  scriptedSteps,
  validateBotScript,
} from '../src/whatsapp-bot/bot-script';

const budget = () => stepByKey('budget')!;

describe('customer bot script', () => {
  describe('what a tenant may change', () => {
    it('rewords a question without touching what is stored', () => {
      const script = resolveBotScript({
        steps: { budget: { prompt: 'Roughly what would you like to spend?' } },
      });
      const step = applyScript(budget(), script);

      expect(step.prompt).toBe('Roughly what would you like to spend?');
      // The values, the order and the count are exactly as the code declares.
      expect(step.options.map((o) => o.value)).toEqual(budget().options.map((o) => o.value));
      expect(step.key).toBe('budget');
    });

    it('renames an answer label while the stored value stays put', () => {
      const script = resolveBotScript({
        steps: { budget: { options: { under_50k: 'Up to 50 thousand' } } },
      });
      const step = applyScript(budget(), script);
      const option = step.options.find((o) => o.value === 'under_50k')!;

      expect(option.label).toBe('Up to 50 thousand');
      expect(option.value).toBe('under_50k');
    });

    it('keeps branching working after a rewording', () => {
      const script = resolveBotScript({
        steps: {
          call: {
            prompt: 'Shall we ring you?',
            options: { call_later: 'Ring me later' },
          },
        },
      });
      const call = applyScript(stepByKey('call')!, script);

      // 'call_later' is the one answer that opens a fifth question. Renaming
      // its label must not change where it goes.
      expect(resolveNext(call, 'call_later', {})).toBe('call_time');
      expect(resolveNext(call, 'call_now', {})).toBeNull();
    });

    it('still understands a customer typing the original words', () => {
      const script = resolveBotScript({
        steps: { budget: { options: { under_50k: 'Up to 50 thousand' } } },
      });
      const step = applyScript(budget(), script);

      // Synonyms are keyed to the VALUE, not the label, so the parser is
      // unaffected by what this shop decided to call it.
      expect(parseChoice(step, 'under 50k')).toBe('under_50k');
    });
  });

  describe('what it refuses to store', () => {
    it('ignores an override for a step that does not exist', () => {
      const script = resolveBotScript({ steps: { diamond_shape: { prompt: 'Which shape?' } } });
      expect(script.steps).toBeUndefined();
    });

    it('ignores an override for an option that does not exist', () => {
      const script = resolveBotScript({
        steps: { budget: { options: { under_10k: 'Tiny budget' } } },
      });
      expect(script.steps).toBeUndefined();
    });

    it('survives a malformed script rather than taking the bot down', () => {
      for (const rubbish of [null, undefined, 'a string', 42, [], { steps: 'nonsense' }]) {
        expect(() => resolveBotScript(rubbish)).not.toThrow();
        expect(resolveBotScript(rubbish).steps).toBeUndefined();
      }
    });

    it('rejects an answer label WhatsApp would truncate', () => {
      const tooLong = 'x'.repeat(MAX_OPTION_LABEL + 1);
      const problems = validateBotScript(
        resolveBotScript({ steps: { budget: { options: { under_50k: tooLong } } } }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0].field).toBe('steps.budget.options.under_50k');
    });

    it('accepts a label exactly at the limit', () => {
      const exact = 'x'.repeat(MAX_OPTION_LABEL);
      expect(
        validateBotScript(resolveBotScript({ steps: { budget: { options: { under_50k: exact } } } })),
      ).toHaveLength(0);
    });
  });

  describe('a blank override means "use the default"', () => {
    it('never leaves a question empty', () => {
      const script = resolveBotScript({ steps: { budget: { prompt: '   ' } } });
      expect(applyScript(budget(), script).prompt).toBe(budget().prompt);
    });

    it('never leaves the greeting empty', () => {
      const script = resolveBotScript({ intro: '', introHint: '   ' });
      const greeting = scriptedGreeting('Priya', script);
      expect(greeting).toContain(DEFAULT_INTRO);
      expect(greeting).toContain(DEFAULT_INTRO_HINT);
      expect(greeting).toContain('Hi Priya');
    });

    it('greets without a name when there is none', () => {
      expect(scriptedGreeting(undefined, {})).toContain('Hi 👋');
    });
  });

  describe('the greeting can be switched off entirely', () => {
    it('stores only the explicit false, and anything else keeps greeting', () => {
      expect(resolveBotScript({ greeting: false }).greeting).toBe(false);
      expect(resolveBotScript({ greeting: true }).greeting).toBeUndefined();
      expect(resolveBotScript({ greeting: 'no' }).greeting).toBeUndefined();
      expect(resolveBotScript({}).greeting).toBeUndefined();
    });

    it('says nothing before question 1 while off, and the editor is told', () => {
      const script = resolveBotScript({ greeting: false });
      expect(scriptedGreeting('Priya', script)).toBeUndefined();
      expect(describeBotScript(script).greeting.enabled).toBe(false);
      expect(describeBotScript({}).greeting.enabled).toBe(true);
    });
  });

  describe('overrides are sparse, not a snapshot', () => {
    /*
     * The lead-scoring policy stores a full copy, so the moment a tenant saved
     * it their wording froze and later improvements never reached them — with
     * nothing to show anything was wrong. Saving one reworded question here
     * must not opt a shop out of every future improvement to the other three.
     */
    it('stores only what was actually changed', () => {
      const script = resolveBotScript({
        steps: { budget: { prompt: 'Your budget?' } },
      });

      expect(Object.keys(script.steps ?? {})).toEqual(['budget']);
      expect(script.steps!.budget).toEqual({ prompt: 'Your budget?' });
      // The hint and every option are absent, so they still follow the code.
      expect(script.steps!.budget.options).toBeUndefined();
    });

    it('leaves every untouched step tracking the built-in wording', () => {
      const script = resolveBotScript({ steps: { budget: { prompt: 'Your budget?' } } });
      const scripted = scriptedSteps(script);

      for (const step of FLOW_STEPS) {
        if (step.key === 'budget') continue;
        expect(scripted.find((s) => s.key === step.key)!.prompt).toBe(step.prompt);
      }
    });

    it('returns the step object untouched when nothing is overridden', () => {
      expect(applyScript(budget(), {})).toBe(budget());
    });
  });

  describe('what the editing screen is given', () => {
    it('sends the default beside the override, so a blank box is explainable', () => {
      const view = describeBotScript(resolveBotScript({ steps: { budget: { prompt: 'Your budget?' } } }));
      const budgetView = view.steps.find((s) => s.key === 'budget')!;

      expect(budgetView.defaultPrompt).toBe(budget().prompt);
      expect(budgetView.prompt).toBe('Your budget?');

      const untouched = view.steps.find((s) => s.key === 'timeline')!;
      expect(untouched.prompt).toBeUndefined();
      expect(untouched.defaultPrompt).toBe(stepByKey('timeline')!.prompt);
    });

    it('describes every step the bot actually asks', () => {
      const view = describeBotScript({});
      expect(view.steps.map((s) => s.key)).toEqual(FLOW_STEPS.map((s) => s.key));
      expect(view.limits.optionLabel).toBe(MAX_OPTION_LABEL);
    });
  });
});
