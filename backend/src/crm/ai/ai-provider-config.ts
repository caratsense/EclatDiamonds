import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * One answer to "is the AI configured, and what can it do" (Block 13).
 *
 * ## The bug this closes
 *
 * Two classes read the same four environment variables and disagreed about what
 * they meant.
 *
 * `CrmAiProvider` (signal extraction) defaulted the provider to `anthropic` and
 * the model to a fixed id, so a bare `CRM_AI_API_KEY` made it report itself
 * AVAILABLE. `ProviderAiResponder` (reply drafting) required the provider and
 * the model to be named explicitly and accepted `openai` as well, so the same
 * environment made it report itself NOT CONFIGURED — and it answers a missing
 * configuration by returning null, silently.
 *
 * The two combinations that went wrong:
 *
 *   key only                     extraction on, drafting silently off
 *   provider=openai + key + model  drafting on, extraction silently off
 *
 * Either way a settings screen could say "AI is connected" while half the
 * features it enables did nothing, and nothing in the product said which half.
 * That is the exact shape of dishonesty this codebase refuses elsewhere — a
 * connection reporting itself working because environment variables exist.
 *
 * ## What replaces it
 *
 * This resolves the configuration ONCE and reports per capability, because the
 * capabilities genuinely differ: drafting is implemented for both vendors, while
 * extraction has only ever been written against Anthropic's message API and its
 * JSON contract. Saying so is better than either pretending extraction works on
 * OpenAI or hiding that drafting does.
 *
 * Nothing here contacts a provider. `verified` is deliberately absent: what this
 * answers is whether a call WILL BE ATTEMPTED, and both consumers already
 * degrade honestly when an attempted call fails — extraction falls back to the
 * tenant's own phrase rules, drafting returns nothing and a person answers.
 */

export type AiVendor = 'anthropic' | 'openai';

/** Only where a real request is implemented against that vendor's API. */
const EXTRACTION_VENDORS: readonly AiVendor[] = ['anthropic'];
const DRAFTING_VENDORS: readonly AiVendor[] = ['anthropic', 'openai'];

export interface AiCapability {
  enabled: boolean;
  /** Why not, in words a settings screen can show. Null when enabled. */
  reason: string | null;
}

export interface AiConfigurationView {
  configured: boolean;
  vendor: AiVendor | null;
  /** Null when nothing is configured; never a guessed default. */
  model: string | null;
  baseUrl: string;
  /** Present when `configured` is false. */
  reason: string | null;
  capabilities: {
    /** Pulling the tenant's own signals out of a conversation. */
    extraction: AiCapability;
    /** Proposing a reply for a person to approve. */
    drafting: AiCapability;
  };
}

const DEFAULT_BASE_URL: Record<AiVendor, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** The model used when a vendor is named but a model is not. */
const DEFAULT_MODEL: Record<AiVendor, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
};

@Injectable()
export class AiProviderConfig {
  constructor(private readonly config: ConfigService) {}

  private read(name: string): string {
    return (this.config.get<string>(name) ?? '').trim();
  }

  get apiKey(): string {
    return this.read('CRM_AI_API_KEY');
  }

  /**
   * The vendor, or null.
   *
   * Defaults to Anthropic when a key is present and no vendor is named, which is
   * what the extractor always did and what every existing deployment relies on.
   * An UNRECOGNISED value returns null rather than falling back — a deployment
   * that set `CRM_AI_PROVIDER=gemini` meant something specific, and quietly
   * sending their traffic to Anthropic would be worse than doing nothing.
   */
  get vendor(): AiVendor | null {
    const raw = this.read('CRM_AI_PROVIDER').toLowerCase();
    if (!this.apiKey) return null;
    if (!raw) return 'anthropic';
    return raw === 'anthropic' || raw === 'openai' ? raw : null;
  }

  get model(): string | null {
    const vendor = this.vendor;
    if (!vendor) return null;
    return this.read('CRM_AI_MODEL') || DEFAULT_MODEL[vendor];
  }

  get baseUrl(): string {
    const override = this.read('CRM_AI_BASE_URL');
    if (override) return override;
    return DEFAULT_BASE_URL[this.vendor ?? 'anthropic'];
  }

  /** True when a request will actually be attempted for this capability. */
  can(capability: 'extraction' | 'drafting'): boolean {
    const vendor = this.vendor;
    if (!vendor) return false;
    const allowed = capability === 'extraction' ? EXTRACTION_VENDORS : DRAFTING_VENDORS;
    return allowed.includes(vendor);
  }

  /** Provider and model only. A name that gets logged never carries the key. */
  get name(): string {
    const vendor = this.vendor;
    return vendor ? `${vendor}/${this.model}` : 'none';
  }

  describe(): AiConfigurationView {
    const vendor = this.vendor;
    const raw = this.read('CRM_AI_PROVIDER');

    const notConfigured = !vendor
      ? this.apiKey
        ? `CRM_AI_PROVIDER is set to "${raw}", which is not implemented. ` +
          'Only "anthropic" and "openai" are, and an unrecognised value is refused rather ' +
          'than quietly sent to a vendor you did not choose.'
        : 'No AI provider is configured. Qualification runs on your own keyword rules, which ' +
          'is exact but literal — it only sees the phrases you listed — and no reply drafts ' +
          'are proposed.'
      : null;

    const unsupported = (which: 'extraction' | 'drafting'): AiCapability =>
      this.can(which)
        ? { enabled: true, reason: null }
        : {
            enabled: false,
            reason: vendor
              ? `Signal extraction is only implemented against Anthropic's message API and its ` +
                `JSON contract, so it does not run on ${vendor}. Qualification falls back to ` +
                'your own phrase rules, which is a real qualification and not a simulation.'
              : notConfigured,
          };

    return {
      configured: Boolean(vendor),
      vendor,
      model: this.model,
      baseUrl: this.baseUrl,
      reason: notConfigured,
      capabilities: {
        extraction: unsupported('extraction'),
        drafting: this.can('drafting')
          ? { enabled: true, reason: null }
          : { enabled: false, reason: notConfigured },
      },
    };
  }
}
