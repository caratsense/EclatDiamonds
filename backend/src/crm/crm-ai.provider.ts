import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fetchJson } from '../integrations/integrations.util';
import { AiProviderConfig } from './ai/ai-provider-config';
import type { QualificationPolicy, SignalResult } from './qualification-policy';

/**
 * The CRM text-AI boundary (Phase A9).
 *
 * WHY THIS IS NOT `MlInferenceService`. That one is the vision pipeline: it
 * takes image bytes and returns embedding vectors from a self-hosted DINOv2 +
 * SigLIP service. This one takes conversation text and returns extracted
 * signals from a hosted language model. Different input, different output,
 * different deployment, different failure modes. Sharing a client between them
 * would tie the catalogue's photo search to an LLM vendor's availability — so
 * the two stay apart, exactly as the architecture requires.
 *
 * WHAT IT IS ALLOWED TO DECIDE: nothing. It reports which of the TENANT'S
 * signals it found and the evidence for each. Scoring, banding and escalation
 * all happen afterwards in `qualification-policy.ts`, over rules the tenant
 * owns. A model that returned a score would be a business rule nobody can edit.
 *
 * UNCONFIGURED IS A FIRST-CLASS STATE. With no `CRM_AI_API_KEY` the service
 * reports `available: false` and callers fall back to deterministic phrase
 * matching, which is a real qualification and not a simulation. It NEVER
 * invents an extraction.
 */

export interface ExtractionResult {
  signals: SignalResult[];
  /** Only what the text actually said. A field nobody mentioned stays absent. */
  requirements: Record<string, string>;
  summary: string | null;
  /** 0-1, the model's own stated confidence. */
  confidence: number | null;
  provider: string;
  model: string;
}

@Injectable()
export class CrmAiProvider {
  private readonly log = new Logger(CrmAiProvider.name);

  /**
   * The configuration is read from ONE place, shared with the reply drafter.
   *
   * It used to be read here with its own defaults and there with its own rules,
   * and the two disagreed: a bare `CRM_AI_API_KEY` made this report itself
   * available while drafting silently did nothing, and naming OpenAI did the
   * reverse. See `ai/ai-provider-config.ts` for the whole of it.
   */
  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiProviderConfig,
  ) {}

  private get apiKey(): string {
    return this.ai.apiKey;
  }
  private get providerName(): string {
    return this.ai.vendor ?? '';
  }
  private get model(): string {
    return this.ai.model ?? '';
  }
  private get baseUrl(): string {
    return this.ai.baseUrl;
  }

  get available(): boolean {
    return this.ai.can('extraction');
  }

  /** Why it is unavailable, in words a settings screen can show verbatim. */
  get unavailableReason(): string | null {
    const state = this.ai.describe();
    return state.capabilities.extraction.reason;
  }

  /**
   * Ask the model which of the tenant's signals appear in this conversation.
   *
   * The prompt is built FROM THE POLICY, so a tenant that renames a signal or
   * adds one gets a model that looks for the new thing with no code change. The
   * model is given the signal keys and told to return only those — it cannot
   * invent a category the tenant has not defined.
   *
   * Returns null on any failure. The caller then falls back to phrase matching,
   * so a provider outage degrades the quality of the extraction rather than
   * taking qualification away entirely.
   */
  async extract(
    policy: QualificationPolicy,
    transcript: string,
  ): Promise<ExtractionResult | null> {
    if (!this.available) return null;

    const signalSpec = policy.signals
      .map((s) => `- ${s.key}: ${s.label}${s.hint ? ` (${s.hint})` : ''}. Examples: ${s.phrases.slice(0, 5).join('; ')}`)
      .join('\n');
    const requirementSpec = policy.questions
      .map((q) => `- ${q.requirement}: ${q.prompt}`)
      .join('\n');

    const system = [
      'You extract structured facts from a customer conversation for a CRM.',
      'You do NOT score, rank or judge the lead. Scoring is done elsewhere by rules the business owns.',
      'Only report a signal if the conversation genuinely supports it, and quote the exact text as evidence.',
      'Never infer a requirement that was not stated. Omit it instead.',
      'Respond with JSON only, no commentary.',
    ].join(' ');

    const prompt = [
      'Signals to look for:',
      signalSpec,
      '',
      'Requirements to extract if explicitly stated:',
      requirementSpec,
      '',
      'Conversation:',
      '"""',
      transcript.slice(0, 12000),
      '"""',
      '',
      'Return JSON of exactly this shape:',
      '{"signals":[{"key":"<one of the signal keys above>","evidence":"<exact quote>"}],',
      ' "requirements":{"<requirement key>":"<value as stated>"},',
      ' "summary":"<two sentences, factual>",',
      ' "confidence":<0..1 — how well the conversation supported this extraction>}',
    ].join('\n');

    try {
      const res = await fetchJson(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const text = (res?.content ?? [])
        .filter((c: { type?: string }) => c?.type === 'text')
        .map((c: { text?: string }) => c.text ?? '')
        .join('');
      const parsed = parseJsonBlock(text);
      if (!parsed) {
        this.log.warn('CRM AI returned no parseable JSON — falling back to phrase matching.');
        return null;
      }

      // Only signals the POLICY defines are accepted. A model that returns a key
      // the tenant never configured is returning something the tenant cannot see
      // or edit, so it is dropped rather than surfaced as a mystery signal.
      const byKey = new Map(policy.signals.map((s) => [s.key, s]));
      const returned = new Map<string, string>();
      for (const s of Array.isArray(parsed.signals) ? parsed.signals : []) {
        if (s && typeof s.key === 'string' && byKey.has(s.key)) {
          returned.set(s.key, typeof s.evidence === 'string' ? s.evidence : '');
        }
      }

      const signals: SignalResult[] = policy.signals.map((sig) => ({
        key: sig.key,
        label: sig.label,
        weight: sig.weight,
        matched: returned.has(sig.key),
        ...(returned.has(sig.key) ? { evidence: returned.get(sig.key) || sig.label } : {}),
      }));

      const requirements: Record<string, string> = {};
      const allowed = new Set(policy.questions.map((q) => q.requirement));
      if (parsed.requirements && typeof parsed.requirements === 'object') {
        for (const [k, v] of Object.entries(parsed.requirements as Record<string, unknown>)) {
          if (allowed.has(k) && typeof v === 'string' && v.trim()) requirements[k] = v.trim();
        }
      }

      return {
        signals,
        requirements,
        summary: typeof parsed.summary === 'string' ? parsed.summary : null,
        confidence:
          typeof parsed.confidence === 'number' &&
          Number.isFinite(parsed.confidence) &&
          parsed.confidence >= 0 &&
          parsed.confidence <= 1
            ? parsed.confidence
            : null,
        provider: this.providerName,
        model: this.model,
      };
    } catch (err) {
      // Logged, not thrown: qualification is an enrichment, and it must never be
      // the reason a message fails to be filed.
      this.log.warn(
        `CRM AI extraction failed (${err instanceof Error ? err.message : String(err)}) — falling back to phrase matching.`,
      );
      return null;
    }
  }
}

/** Pull the first JSON object out of a model response that may have prose around it. */
function parseJsonBlock(text: string): {
  signals?: { key?: string; evidence?: string }[];
  requirements?: unknown;
  summary?: unknown;
  confidence?: number;
} | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
