"use client";

import { useMemo } from "react";
import { Download, ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Lead } from "@/lib/mock/crm";

/**
 * What the customer actually typed into a Meta Lead Ads form.
 *
 * The adapter keeps every answer it did not recognise as a standard field, so
 * this is the tenant's own questionnaire — whatever they asked. Nothing here
 * assumes a question exists: a form with no custom questions renders as "no
 * questionnaire", not as a grid of empty rows.
 *
 * The ageing badge is computed from `createdAt` against the same clock the rest
 * of the screen uses. "New" is a claim about how long the lead has been sitting
 * unworked, so it is stated in days rather than as a bare colour.
 */

/** A lead is "new" for its first day; after a week nobody has called it. */
const NEW_WITHIN_DAYS = 1;
const STALE_AFTER_DAYS = 7;

export function leadAgeDays(createdAt: string): number | null {
  const then = new Date(createdAt);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  return days < 0 ? 0 : days;
}

export function LeadAgeBadge({ createdAt }: { createdAt: string }) {
  const days = leadAgeDays(createdAt);
  if (days === null) return null;

  const isNew = days <= NEW_WITHIN_DAYS;
  const isStale = days >= STALE_AFTER_DAYS;
  const label = isNew ? "New lead" : isStale ? `Waiting ${days} days` : `${days} days old`;
  const tone = isNew
    ? "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
    : isStale
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-border bg-muted/60 text-muted-foreground";

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`} title={`Created ${days} day(s) ago`}>
      {label}
    </span>
  );
}

export function MetaFormAnswers({ lead }: { lead: Lead }) {
  // Memoised so the fallback empty array is stable; a fresh `[]` every render
  // would rebuild the CSV on every render too.
  const answers = useMemo(() => lead.formAnswers ?? [], [lead.formAnswers]);

  const csv = useMemo(() => {
    if (!answers.length) return null;
    const rows = [
      ["Question", "Answer"],
      ...answers.map((a) => [a.name, a.values.join("; ")]),
    ];
    // Quote every cell and double any embedded quote — an answer is free text
    // typed by a stranger and will contain commas, quotes and newlines.
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }, [answers]);

  function download() {
    if (!csv) return;
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lead.ref || "lead"}-form-answers.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (lead.source !== "meta_ads") return null;

  return (
    <section className="rounded-md border border-border p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="h-4 w-4" aria-hidden />
          What they filled in
        </h3>
        <div className="flex items-center gap-2">
          <LeadAgeBadge createdAt={lead.createdAt} />
          {csv ? (
            <Button type="button" variant="outline" size="sm" onClick={download}>
              <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              CSV
            </Button>
          ) : null}
        </div>
      </header>

      {!answers.length ? (
        <p className="text-sm text-muted-foreground">
          This form asked no questions beyond name and contact details, so there are no answers
          to show.
        </p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {answers.map((a) => (
            <div key={a.name} className="min-w-0">
              <dt className="truncate text-xs text-muted-foreground" title={a.name}>
                {humanise(a.name)}
              </dt>
              <dd className="break-words text-sm">
                {a.values.length ? a.values.join(", ") : <span className="text-muted-foreground">—</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * Meta sends field names as `what_is_your_budget?`. Tidy them for reading, but
 * keep the raw name in the `title` above so nobody has to guess what was
 * actually asked when the tidied version is ambiguous.
 */
function humanise(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
