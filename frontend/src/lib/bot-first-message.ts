import type { CampaignQuestion } from "@/lib/queries/crm-ai";

/**
 * What the bot actually sends FIRST, so the editor can show it.
 *
 * The client, 28 Nov: "the bot is not sending the message as we have set on the
 * bot script". Her three live bridal campaigns have an empty first reply, no
 * questions and only a closing message — so the first message every customer
 * receives is that closing message, which is exactly what the sender does. The
 * screen was the thing that lied: a box headed "First reply — sent exactly as
 * written", left empty, with nothing anywhere saying that empty does not mean
 * silent.
 *
 * The twin of `firstCustomerMessage` in
 * `backend/src/whatsapp-bot/campaign-bot.service.ts`, which is where the matrix
 * is derived from the sender path by path and where it is authoritative. It is
 * copied rather than imported for the same reason `adIdFromLink` is: the editor
 * has to recompute this on every keystroke of an unsaved draft, and there is no
 * module boundary between the two apps to import across. Both sides are tested
 * on the same cases, so a change to one that is not made to the other fails.
 */
export type FirstCustomerMessageSource =
  /** The owner's first reply, verbatim, with its first question when it has one. */
  | "firstReply"
  /** No first reply: the first question IS the opener. */
  | "question"
  /** No first reply and no questions: the closing line opens and closes at once. */
  | "closingMessage"
  /** No first reply and AI replies on: the assistant writes it from the brief. */
  | "assistant"
  /** Configured, but what would go out is blank — the customer gets an empty line. */
  | "blank"
  /** Nothing is filled in, so the server reads the rule as unconfigured. */
  | "none"
  /** A script that will never be sent, because the rule is switched off. */
  | "off"
  /** The same, because its enquiries go straight to a person by choice. */
  | "humanOnly";

export interface FirstCustomerMessage {
  source: FirstCustomerMessageSource;
  /** The exact text the customer receives, or null when it cannot be known. */
  text: string | null;
}

/** A conversation as the editor holds it — a campaign rule or the walk-in form. */
export interface BotScriptDraft {
  enabled?: boolean;
  handling?: "ai" | "human";
  firstReply?: string | null;
  questions?: CampaignQuestion[] | null;
  closingMessage?: string | null;
  aiReplies?: boolean;
}

/** One question as the customer reads it: choices inside the sentence, never a menu. */
function phraseQuestion(question: CampaignQuestion): string {
  const text = question.text.trim();
  if (!question.options?.length) return text;
  return `${text.replace(/\?\s*$/, "")} — ${question.options.join(", ")}?`;
}

/** Is any of the editor's fields filled in? A rule with none never speaks at all. */
function hasConfiguredConversation(rule: BotScriptDraft): boolean {
  return !!(rule.firstReply?.trim() || rule.questions?.length || rule.closingMessage?.trim());
}

/**
 * The first thing a customer receives from this conversation, exactly as sent.
 *
 *   first reply filled in   → that text, verbatim, with the first question
 *                             appended after a blank line unless the reply
 *                             already ends by asking something
 *   no first reply, AI on   → whatever the assistant writes from the brief
 *   no first reply, AI off,
 *     questions filled in   → the first question, which becomes the opener
 *   no first reply, AI off,
 *     no questions          → the closing message, and the thread goes to a
 *                             colleague on that same turn
 *   nothing filled in       → nothing at all; the rule is read as unconfigured
 *
 * `enabled` and `handling` absent mean live and bot-handled: the walk-in
 * conversation is shaped like a rule but carries no routing of its own.
 */
export function firstCustomerMessage(rule: BotScriptDraft): FirstCustomerMessage {
  // Off and human-only are told apart from unconfigured on purpose: all three
  // send nothing, but the first two are a WRITTEN script that will never go
  // out, which is a different thing to tell the person who wrote it.
  if (rule.enabled === false) return { source: "off", text: null };
  if (rule.handling === "human") return { source: "humanOnly", text: null };
  if (!hasConfiguredConversation(rule)) return { source: "none", text: null };

  // Truthiness, not trimmed, because that is the test the sender applies: a
  // first reply of nothing but spaces goes out as it stands, and "blank" is
  // how the editor gets to say so.
  if (rule.firstReply) {
    const first = rule.questions?.[0];
    const question = first ? phraseQuestion(first) : null;
    const text =
      question && !rule.firstReply.trimEnd().endsWith("?")
        ? `${rule.firstReply}\n\n${question}`
        : rule.firstReply;
    return { source: text.trim() ? "firstReply" : "blank", text };
  }

  // AI replies on with no opener to send first: there is no turn left for the
  // questions to be asked on their own, so the model answers the customer's
  // first message from the brief and no exact text can be shown.
  if (rule.aiReplies === true) return { source: "assistant", text: null };

  const first = rule.questions?.[0];
  if (first) {
    const text = phraseQuestion(first);
    return { source: text.trim() ? "question" : "blank", text };
  }

  const closing = rule.closingMessage?.trim();
  return closing ? { source: "closingMessage", text: closing } : { source: "none", text: null };
}

/**
 * The sentence under the preview, naming WHY that is what goes out.
 *
 * Worded for the person who wrote the script and expected something else, so
 * each one says which field the text came from and what happens next.
 */
export function firstCustomerMessageNote(first: FirstCustomerMessage): string {
  switch (first.source) {
    case "firstReply":
      return "This is the first reply, sent word for word the moment the enquiry arrives.";
    case "question":
      return "There is no first reply, so the first question opens the conversation instead.";
    case "closingMessage":
      return "There is no first reply and no questions, so the closing message is the ONLY message — it is sent straight away and the thread goes to a colleague.";
    case "assistant":
      return "There is no first reply, and AI replies are on: the assistant answers the customer's first message from the brief, so the exact words cannot be shown here.";
    case "blank":
      return "The first message would arrive BLANK — the customer gets an empty WhatsApp message.";
    case "none":
      return "Nothing is filled in, so the bot sends nothing at all — the enquiry goes to a person instead.";
    case "off":
      return "This campaign is switched off, so none of what is written here is sent.";
    case "humanOnly":
      return "This campaign goes straight to a person, so none of what is written here is sent.";
  }
}

/**
 * Does the customer actually receive something readable?
 *
 * False is the state the editor has to shout about: a conversation somebody
 * wrote and saved that reaches nobody, or reaches them empty.
 */
export function firstCustomerMessageSends(first: FirstCustomerMessage): boolean {
  return (
    first.source !== "none" &&
    first.source !== "off" &&
    first.source !== "humanOnly" &&
    first.source !== "blank"
  );
}
