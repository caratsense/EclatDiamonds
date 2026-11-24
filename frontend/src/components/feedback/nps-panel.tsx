"use client";

import { useState } from "react";
import { Gauge, Inbox, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type NpsImportResult,
  type NpsResponseRow,
  type NpsSheetImportSummary,
  type NpsStage,
  type NpsUpdateRow,
  useImportNpsSheet,
  useNpsResponses,
  useNpsUpdates,
} from "@/lib/queries/nps";
import { apiErrorMessage, cn } from "@/lib/utils";

/**
 * The two NPS tables, lifted out of their own screen.
 *
 * The client asked for NPS to live inside Feedback Requests rather than beside
 * it: "I told you to club NPS and feedback request into feedback request."
 * Asking a customer how it went and asking them to score us are the same job
 * to the person doing it, and two sidebar entries made it look like two.
 *
 * So the tables moved here and both screens render them — Feedback as its NPS
 * tabs, and `/nps` itself, which stays a working URL for anyone who bookmarked
 * it or was granted that screen alone. Nothing about what NPS does changed;
 * this is where it is shown.
 */

/** Stage colour follows meaning, not decoration: red needs a person. */
const STAGE_TONE: Record<NpsStage, string> = {
  pending_initial: "bg-muted text-muted-foreground",
  initial_sent: "bg-accent-soft text-accent-solid",
  awaiting_response: "bg-accent-soft text-accent-solid",
  reminder_due: "bg-warning/15 text-warning",
  reminder_sent: "bg-accent-soft text-accent-solid",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * Getting the sheet in.
 *
 * NPS answers are not ours to create: a customer fills the client's Google
 * Form, the answers land in her workbook, and somebody uploads the export.
 * Until this existed there was no route in at all — the model, the matcher,
 * both screens and the Excel export shipped, and production held zero
 * responses.
 *
 * It belongs on NPS Responses and nowhere else. It used to sit above BOTH
 * tables, and the client's first look at Updates was "also in updates why have
 * u put that sheet": Updates is a register of visits and asks, uploading a
 * workbook creates no row in it, so a file picker at the top of it answered a
 * question that screen does not ask. Responses IS the list of what the
 * workbook holds, so the upload sits there and Updates says where to find it.
 */
function NpsSheetUpload() {
  const [file, setFile] = useState<File | null>(null);
  // Bumped after a successful upload: clearing the File state alone leaves the
  // browser's own "chosen file" label behind, which reads as a queued upload.
  const [pickerKey, setPickerKey] = useState(0);
  const [result, setResult] = useState<NpsImportResult | null>(null);
  const importSheet = useImportNpsSheet();

  function submit() {
    if (!file) return;
    importSheet.mutate(
      { file },
      {
        onSuccess: (data) => {
          setResult(data);
          setFile(null);
          setPickerKey((key) => key + 1);
          const sheets = summaries(data);
          const read = sheets.reduce((total, sheet) => total + sheet.received, 0);
          toast.success(
            sheets.length
              ? `${read} row${read === 1 ? "" : "s"} read from ${sheets
                  .map((sheet) => sheet.sheet)
                  .join(" and ")}.`
              : "Nothing to import in that file.",
          );
        },
        onError: (error) =>
          toast.error(apiErrorMessage(error, "The sheet could not be imported.")),
      },
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            key={pickerKey}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="max-w-sm"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <Button onClick={submit} disabled={!file || importSheet.isPending}>
            {importSheet.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Import sheet
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Upload the NPS workbook exported from the form — the “NPS Responses” and “Followup
          answers” tabs are read by name, so the rest of the file is left alone. Uploading the
          same export again updates the rows it already has instead of duplicating them.
        </p>
        {result ? <ImportSummary result={result} /> : null}
      </CardContent>
    </Card>
  );
}

const summaries = (result: NpsImportResult): NpsSheetImportSummary[] =>
  [result.responses, result.followups].filter(
    (sheet): sheet is NpsSheetImportSummary => sheet != null,
  );

/**
 * What the upload actually did.
 *
 * The unmatched count is the headline, not a footnote. A submission matches a
 * visit only by phone number — never by name — so an import where 40 of 50
 * rows reached nobody is a real finding about the register, and burying it
 * under "50 imported" would be the one dishonest thing this screen could do.
 */
function ImportSummary({ result }: { result: NpsImportResult }) {
  const sheets = summaries(result);
  if (!sheets.length) return null;
  const otherTabs = result.sheetNames.filter(
    (name) => !sheets.some((sheet) => sheet.sheet === name),
  );

  return (
    <div className="space-y-3 border-t pt-3">
      {sheets.map((sheet) => (
        <div key={sheet.sheet} className="space-y-1">
          <div className="text-sm font-medium">{sheet.sheet}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{sheet.received} rows read</span>
            <span>{sheet.created} added</span>
            <span>{sheet.updated} updated</span>
            <span className="text-success">{sheet.matched} matched to a visit</span>
            {sheet.ambiguous > 0 ? (
              <span className="text-warning">{sheet.ambiguous} need a person to decide</span>
            ) : null}
          </div>
          {sheet.unmatched > 0 ? (
            <p className="text-xs font-medium text-destructive">
              {sheet.unmatched} of {sheet.received} could not be matched to a visit — no walk-in
              is recorded against that number. They are listed under NPS Responses for somebody
              to reconcile.
            </p>
          ) : null}
          {sheet.skipped.length ? (
            <p className="text-xs text-muted-foreground">
              {sheet.skipped.length} row{sheet.skipped.length === 1 ? "" : "s"} skipped —{" "}
              {sheet.skipped
                .slice(0, 3)
                .map((row) => `row ${row.row}: ${row.reason}`)
                .join(" ")}
            </p>
          ) : null}
          {sheet.ignoredColumns.length ? (
            <p className="text-xs text-muted-foreground">
              Columns not recognised and left out: {sheet.ignoredColumns.join(", ")}.
            </p>
          ) : null}
        </div>
      ))}
      {otherTabs.length ? (
        <p className="text-xs text-muted-foreground">
          Other tabs in the file were not read: {otherTabs.join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Visits listed, but not one of them has been asked or has answered — so every
 * column after the stage can only be a dash.
 *
 * That is the state production is actually in: one walk-in on the register, no
 * ask ever sent, no workbook ever uploaded. A wide table of dashes with
 * nothing said about it reads as a broken screen rather than as an empty one,
 * and the register is not empty, so an empty state would be a lie.
 *
 * Exported because it decides whether the explanation is shown, and getting it
 * backwards fails quietly in both directions: a register that has started
 * filling would keep being told nobody was asked, and an untouched one would
 * go on showing dashes with no reason given.
 */
export function nothingAskedYet(rows: NpsUpdateRow[]): boolean {
  if (!rows.length) return false;
  return rows.every(
    (r) =>
      !r.initialSentAt &&
      !r.reminderSentAt &&
      !r.repliedAt &&
      !r.submittedAt &&
      !r.followups.length,
  );
}

export function NpsUpdates() {
  const { data, isLoading } = useNpsUpdates({ take: 200 });
  const rows = data?.rows ?? [];
  const nothingAsked = nothingAskedYet(rows);

  return (
    <div className="space-y-4">
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !rows.length ? (
        <EmptyState
          icon={Gauge}
          title="No visits yet"
          description="Every checked-in customer appears here, whether or not they answered."
        />
      ) : (
        <>
          {nothingAsked ? <NothingAskedYet /> : null}
          <UpdatesTable rows={rows} total={data?.total ?? rows.length} />
        </>
      )}
    </div>
  );
}

/**
 * What is missing, in words, above the register.
 *
 * Stated as the two separate things that fill the two halves of the table,
 * because they are filled by two different people doing two different jobs:
 * the branch sending the ask, and whoever uploads the client's workbook. The
 * upload itself is not repeated here — putting it on this screen is what the
 * client objected to — so this names where it lives instead.
 */
function NothingAskedYet() {
  return (
    <Card>
      <CardContent className="space-y-1.5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Nobody has been asked yet
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The visits below are listed so a branch can see who is still owed an ask. The message,
          reminder and reply columns fill in once the after-visit request starts going out, which
          a manager switches on under Feedback Requests › Ask after a visit. The score and
          follow-up columns fill in when somebody uploads the NPS workbook under{" "}
          <span className="font-medium text-foreground">NPS Responses</span> — that upload is the
          only way form answers reach this screen.
        </p>
      </CardContent>
    </Card>
  );
}

function UpdatesTable({ rows, total }: { rows: NpsUpdateRow[]; total: number }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3">Customer</th>
                <th className="p-3">Store / visit</th>
                <th className="p-3">Stage</th>
                <th className="p-3">Message sent</th>
                <th className="p-3">Reminder</th>
                <th className="p-3">Replied</th>
                <th className="p-3">Form submitted</th>
                <th className="p-3">Follow-up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.checkInId} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t p-3 text-xs text-muted-foreground">
          Showing {rows.length} of {total}. The Excel export carries every authorised record,
          not just this page.
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ r }: { r: NpsUpdateRow }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="p-3">
        <div className="font-medium">{r.customerName ?? "—"}</div>
        <div className="text-xs text-muted-foreground">{r.phone ?? "no number"}</div>
      </td>
      <td className="p-3">
        <div>{r.store ?? "—"}</div>
        <div className="text-xs text-muted-foreground">
          {when(r.visitAt)}
          {r.salesperson ? ` · ${r.salesperson}` : ""}
        </div>
      </td>
      <td className="p-3">
        <Badge className={cn("font-medium", STAGE_TONE[r.stage])}>{r.stageLabel}</Badge>
        {r.failureNote ? (
          <div className="mt-1 max-w-[18rem] text-xs text-destructive">{r.failureNote}</div>
        ) : null}
      </td>
      <td className="p-3 text-xs">{when(r.initialSentAt)}</td>
      <td className="p-3 text-xs">
        <div>due {when(r.reminderDueAt)}</div>
        <div className="text-muted-foreground">sent {when(r.reminderSentAt)}</div>
      </td>
      {/* Replied and submitted are separate columns, deliberately: a WhatsApp
          reply is not a completed form. */}
      <td className="p-3 text-xs">{when(r.repliedAt)}</td>
      <td className="p-3 text-xs">
        {when(r.submittedAt)}
        {r.score != null ? <div className="font-medium">score {r.score}</div> : null}
      </td>
      <td className="p-3 text-xs">
        {r.followups.length
          ? r.followups.map((f) => (
              <div key={f.id} className="max-w-[16rem] truncate">
                {f.response ?? "—"}
              </div>
            ))
          : "—"}
      </td>
    </tr>
  );
}

export function NpsResponses() {
  const { data, isLoading } = useNpsResponses();
  const rows = data?.rows ?? [];
  return (
    <div className="space-y-4">
      <NpsSheetUpload />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !rows.length ? (
        <EmptyState
          icon={Inbox}
          title="No submissions yet"
          description="Upload the NPS workbook above and every submission in it appears here."
        />
      ) : (
        <ResponsesTable rows={rows} />
      )}
    </div>
  );
}

function ResponsesTable({ rows }: { rows: NpsResponseRow[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3">Submitted</th>
                <th className="p-3">Name / number</th>
                <th className="p-3">Score</th>
                <th className="p-3">Match</th>
                <th className="p-3">Liked</th>
                <th className="p-3">Could improve</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="p-3 text-xs">{when(r.submittedAt)}</td>
                  <td className="p-3">
                    <div className="font-medium">{r.rawName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.rawNumber ?? "—"}</div>
                  </td>
                  <td className="p-3">
                    <div className="font-medium">{r.score ?? "—"}</div>
                    <div className="max-w-[12rem] truncate text-xs text-muted-foreground">
                      {r.recommendAnswer ?? ""}
                    </div>
                  </td>
                  <td className="p-3">
                    {/* An unmatched or ambiguous response stays visible for a
                        person to reconcile — never quietly dropped. */}
                    <Badge
                      className={cn(
                        "font-medium",
                        r.matchState === "matched"
                          ? "bg-success/15 text-success"
                          : r.matchState === "ambiguous"
                            ? "bg-warning/15 text-warning"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {r.matchState}
                    </Badge>
                    <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                      {r.party?.name ?? r.matchNote ?? ""}
                    </div>
                  </td>
                  <td className="p-3 max-w-[16rem] text-xs">{r.likedMost ?? "—"}</td>
                  <td className="p-3 max-w-[16rem] text-xs">{r.couldImprove ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
