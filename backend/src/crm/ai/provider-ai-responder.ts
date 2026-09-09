import { Injectable, Logger } from '@nestjs/common';

import { AiReply, AiReplyContext, AiResponder } from '../ai-responder';
import {
  POLICY_VERSION,
  PROVIDER_TIMEOUT_MS,
  systemPrompt,
  untrustedBlock,
} from './policy';

/**
 * A real, provider-backed responder.
 *
 * ## Configuration is server-side, and absence is not an error
 *
 *   CRM_AI_PROVIDER   anthropic | openai        (empty => not configured)
 *   CRM_AI_MODEL      the model id
 *   CRM_AI_API_KEY    the credential
 *   CRM_AI_BASE_URL   optional override, for an OpenAI-compatible gateway
 *
 * With any of the first three missing, `isConfigured()` returns false and the
 * gate hands conversations to people. That is the whole point of the flag: an
 * unconfigured tenant degrades to a visible human queue, never to silence and
 * never to a guess.
 *
 * ## Why two shapes and no SDK
 *
 * Both providers are one HTTPS POST with a JSON body. Adding a vendor SDK would
 * add a dependency, a release cadence and a second place credentials live, to
 * save about thirty lines. `fetch` is in the runtime.
 *
 * ## What this class deliberately does NOT do
 *
 * It does not retrieve, it does not decide whether the assistant is allowed to
 * answer, and it does not write anything to the database. Those are policy, and
 * policy lives in the gate — so a provider swap cannot quietly change who is
 * allowed to be answered by a machine.
 */
@Injectable()
export class ProviderAiResponder implements AiResponder {
  private readonly logger = new Logger(ProviderAiResponder.name);

  private readonly provider = (process.env.CRM_AI_PROVIDER ?? '').trim().toLowerCase();
  private readonly model = (process.env.CRM_AI_MODEL ?? '').trim();
  private readonly apiKey = (process.env.CRM_AI_API_KEY ?? '').trim();
  private readonly baseUrl = (process.env.CRM_AI_BASE_URL ?? '').trim();

  /** Provider and model only. The key is never part of a name that gets logged. */
  get name(): string {
    return this.isConfigured() ? `${this.provider}/${this.model}` : 'none';
  }

  isConfigured(): boolean {
    return (
      (this.provider === 'anthropic' || this.provider === 'openai') &&
      this.model.length > 0 &&
      this.apiKey.length > 0
    );
  }

  async propose(context: AiReplyContext): Promise<AiReply | null> {
    if (!this.isConfigured()) return null;

    const started = Date.now();
    const system = systemPrompt(context.businessName ?? 'this business');

    // Both untrusted inputs are fenced and labelled as data. The reference
    // material is presented BEFORE the customer message so the last thing the
    // model reads is the question, not somebody's document.
    const user = [
      context.knowledgeText
        ? untrustedBlock('REFERENCE_MATERIAL', context.knowledgeText)
        : '<<<REFERENCE_MATERIAL>>>\n(none supplied)\n<<<END_REFERENCE_MATERIAL>>>',
      '',
      untrustedBlock('CUSTOMER_MESSAGE', context.inboundText ?? ''),
      '',
      'Draft a reply following your rules. Reply with the JSON object only.',
    ].join('\n');

    let raw: string;
    try {
      raw =
        this.provider === 'anthropic'
          ? await this.callAnthropic(system, user)
          : await this.callOpenAi(system, user);
    } catch (err) {
      // Rethrow: the gate turns a provider failure into a visible handoff. It is
      // not this class's job to decide what a failure means.
      this.logger.warn(
        `AI provider call failed (${this.provider}/${this.model}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }

    const latencyMs = Date.now() - started;
    const parsed = parseReply(raw);
    if (!parsed) {
      // A provider that did not return the contract is a provider that failed.
      // Guessing at prose here is how an unvalidated blob reaches a customer.
      this.logger.warn(`AI provider returned unparseable output (${this.provider}/${this.model}).`);
      return {
        text: '',
        confidence: 0,
        handoffReason: 'The assistant returned a malformed answer.',
        provider: this.provider,
        model: this.model,
        latencyMs,
        policyVersion: POLICY_VERSION,
      };
    }

    return {
      text: parsed.reply,
      confidence: parsed.confidence,
      handoffReason: parsed.needsHuman
        ? parsed.handoffReason || 'The assistant asked for a person.'
        : undefined,
      provider: this.provider,
      model: this.model,
      latencyMs,
      policyVersion: POLICY_VERSION,
    };
  }

  /** One request, with a deadline. A hung provider must not hold a webhook open. */
  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Status only. A provider error body can echo the prompt back, which
        // would put customer text into the log.
        throw new Error(`provider responded ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropic(system: string, user: string): Promise<string> {
    const json = (await this.post(
      `${this.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: user }],
      },
    )) as { content?: { type?: string; text?: string }[] };
    return (json.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim();
  }

  private async callOpenAi(system: string, user: string): Promise<string> {
    const json = (await this.post(
      `${this.baseUrl || 'https://api.openai.com/v1'}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    )) as { choices?: { message?: { content?: string } }[] };
    return (json.choices?.[0]?.message?.content ?? '').trim();
  }
}

/**
 * Validate the model's output against the contract.
 *
 * Returns null for anything that is not a usable answer. A model that returns
 * prose, or a confidence of "high", or a reply that is not a string, has not
 * answered — and the caller turns that into a handoff. Nothing here coerces a
 * malformed response into a plausible-looking one.
 */
export function parseReply(
  raw: string,
): { reply: string; confidence: number; needsHuman: boolean; handoffReason: string } | null {
  if (!raw) return null;

  // Providers sometimes wrap JSON in a code fence even when asked not to.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();

  // Fall back to the outermost object if the model added a sentence around it.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const o = obj as Record<string, unknown>;
  const reply = typeof o.reply === 'string' ? o.reply.trim() : '';
  const needsHuman = o.needsHuman === true;
  const handoffReason = typeof o.handoffReason === 'string' ? o.handoffReason.trim() : '';

  // Confidence must be a real number in range. A missing or non-numeric value is
  // treated as zero, not as "probably fine".
  const rawConfidence = typeof o.confidence === 'number' ? o.confidence : Number.NaN;
  const confidence = Number.isFinite(rawConfidence) ? Math.min(Math.max(rawConfidence, 0), 1) : 0;

  // A draft with no text is not a draft, unless the model is explicitly asking
  // for a person — in which case the empty text is the correct answer.
  if (!reply && !needsHuman) return null;

  return { reply, confidence, needsHuman, handoffReason };
}
