"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, MessageCircleQuestion, Send, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useAskAssistant,
  useAssistantSuggestions,
  type AssistantAnswer,
} from "@/lib/queries/assistant";

/** One exchange in the transcript. */
interface Turn {
  id: string;
  question: string;
  answer?: AssistantAnswer;
  pending?: boolean;
}

const TONE_CLASS: Record<string, string> = {
  ok: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
  neutral: "text-muted-foreground",
};

/**
 * The in-app assistant — a floating panel for asking what's waiting on you.
 *
 * Answers come from the server's intent matcher, not a language model: every
 * reply is a store-scoped, role-filtered query, so it is instant, costs nothing
 * per question, and cannot be confidently wrong about money or approvals. The
 * suggestion chips are the discoverable surface — they double as the list of
 * what it can actually answer, which keeps expectations honest.
 */
export function AssistantPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnSeq = useRef(0);

  const { data: suggestions = [] } = useAssistantSuggestions();
  const ask = useAskAssistant();

  // The chips to offer next: whatever the last answer suggested, else the
  // role-filtered opening set.
  const chips = turns.length
    ? (turns[turns.length - 1]?.answer?.suggestions ?? suggestions)
    : suggestions;

  function send(question: string) {
    const q = question.trim();
    if (!q || ask.isPending) return;
    // A monotonic counter rather than Date.now(): the id only has to be unique
    // within this transcript, and a clock read is an impure call the React
    // compiler (rightly) refuses in a component body.
    turnSeq.current += 1;
    const id = `turn-${turnSeq.current}`;
    setTurns((t) => [...t, { id, question: q, pending: true }]);
    setText("");

    ask.mutate(q, {
      onSuccess: (answer) => {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, answer, pending: false } : x)));
        // Scroll after the answer renders.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        });
      },
      onError: () => {
        setTurns((t) =>
          t.map((x) =>
            x.id === id
              ? {
                  ...x,
                  pending: false,
                  answer: {
                    intent: "error",
                    answer: "I couldn't reach the server. Try again in a moment.",
                    items: [],
                    suggestions: [],
                  },
                }
              : x,
          ),
        );
      },
    });
  }

  if (!open) {
    return (
      /*
       * The POSITIONING lives on this wrapper, not on the Button.
       *
       * Putting `fixed` on the Button silently did nothing: the `gold` variant
       * carries `.facet-top`, and that rule sets `position: relative` from
       * globals.css, which beats Tailwind's `.fixed` utility. The launcher was
       * therefore never floating at all — it sat in normal page flow near the
       * end of the document. A wrapper sidesteps the specificity fight entirely
       * and keeps working whatever variant the button uses.
       *
       * Offsets: the mobile tab bar is `fixed bottom-0 h-16` at this same z-40,
       * so below `md` the button lifts 5rem clear of it (plus the device
       * safe-area inset for gesture bars) and drops back to 1.25rem on desktop
       * where there is no tab bar. `--tour-inset` keeps it clear of the welcome
       * guide while that is open.
       */
      <div
        style={{
          bottom:
            "calc(var(--assistant-offset, 5rem) + env(safe-area-inset-bottom, 0px) + var(--tour-inset, 0px))",
        }}
        className="fixed right-5 z-40 md:[--assistant-offset:1.25rem]"
      >
        <Button
          variant="gold"
          size="icon"
          onClick={() => setOpen(true)}
          className="h-12 w-12 rounded-full shadow-lg"
          aria-label="Open assistant"
        >
          <Bot className="h-5 w-5" />
        </Button>
      </div>
    );
  }

  return (
    <div
      /* Same clearance as the launcher, and the height is capped against the
         viewport so the panel can't run off the top of a short screen. */
      style={{
        bottom:
          "calc(var(--assistant-offset, 5rem) + env(safe-area-inset-bottom, 0px) + var(--tour-inset, 0px))",
      }}
      className="fixed right-5 z-40 flex h-[min(32rem,calc(100dvh-9rem))] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl md:h-[min(32rem,calc(100dvh-6rem))] md:[--assistant-offset:1.25rem]"
    >
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-gold-strong" />
          Assistant
        </p>
        <button
          type="button"
          aria-label="Close assistant"
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => setOpen(false)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <MessageCircleQuestion className="h-4 w-4 text-muted-foreground" />
              What would you like to check?
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              I can look up anything waiting on you, anything you&apos;ve raised,
              and where your branches&apos; requests got to.
            </p>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-secondary px-2.5 py-1.5 text-sm">
              {turn.question}
            </p>

            {turn.pending ? (
              <p className="text-xs text-muted-foreground">Looking…</p>
            ) : turn.answer ? (
              <div className="space-y-2">
                <p className="text-sm">{turn.answer.answer}</p>
                {turn.answer.items.length > 0 ? (
                  <ul className="space-y-1.5">
                    {turn.answer.items.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          disabled={!item.href}
                          onClick={() => item.href && router.push(item.href)}
                          className={cn(
                            "w-full rounded-lg border bg-card px-2.5 py-2 text-left transition-colors",
                            item.href && "hover:bg-accent",
                          )}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium">
                              {item.title}
                            </span>
                            {item.meta ? (
                              <span
                                className={cn(
                                  "num shrink-0 text-[11px]",
                                  TONE_CLASS[item.tone ?? "neutral"],
                                )}
                              >
                                {item.meta}
                              </span>
                            ) : null}
                          </div>
                          {item.subtitle ? (
                            <p className="truncate text-xs text-muted-foreground">
                              {item.subtitle}
                            </p>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t px-3 py-2">
          {chips.slice(0, 4).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => send(c)}
              disabled={ask.isPending}
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="flex gap-2 border-t px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about approvals, requests, orders…"
          aria-label="Ask the assistant"
        />
        <Button type="submit" size="sm" disabled={!text.trim() || ask.isPending}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
