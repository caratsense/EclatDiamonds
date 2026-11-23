"use client";

import { useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ExportRangeDialog } from "@/components/common/export-range-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type ExportRange, describeRange, rangeParams } from "@/lib/queries/exports";
import { apiErrorMessage } from "@/lib/utils";

/**
 * "Download as Excel" for a data-collection screen (client, 7 Oct: everywhere
 * data is collected, the sheet must be downloadable).
 *
 * Since 21 Nov it ASKS FIRST: "wherever we are downloading an Excel sheet, there
 * should be an option to download from this to this date, like a pop-up should
 * open when you click on Excel". The pop-up lands on All time, so the download
 * she does every day is still Excel → Download and nothing typed.
 *
 * `responseType: "blob"` matters: without it the XLSX bytes are read as text
 * and the saved file will not open. The filename comes from the server's
 * Content-Disposition so what a person saves matches what the server logged —
 * and the server puts the range in that name, so two downloads of the same
 * screen are told apart on the desktop rather than by opening them.
 */
export function ExcelExportButton({
  path,
  fallbackName,
  /**
   * Which date the server filters on, in a person's words. Passed in by the
   * screen because only the screen knows: a lead is dated by when it arrived,
   * a walk-in by when the customer came in, a quote by when it was raised.
   */
  rangedOn,
  /** What the file's columns are, when the tenant can change them. */
  formatNote,
}: {
  path: string;
  fallbackName: string;
  rangedOn: string;
  formatNote?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  async function download(range: ExportRange) {
    setBusy(true);
    try {
      const res = await api.get<Blob>(path, {
        params: rangeParams(range),
        responseType: "blob",
      });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? fallbackName;
      /*
       * Two header names because two eras of export route. The newer ones send
       * X-Export-Rows; the NPS route has always sent X-Row-Count, and reading
       * only the first meant its toast never showed a count at all — the one
       * number that tells somebody a narrow range came back nearly empty.
       */
      const rows = res.headers?.["x-export-rows"] ?? res.headers?.["x-row-count"];

      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setAsking(false);
      toast.success(filename, {
        description:
          rows != null
            ? `${rows} rows — ${describeRange(range)}`
            : describeRange(range),
      });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not build the Excel file."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setAsking(true)} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <FileSpreadsheet className="h-3.5 w-3.5" />
        )}
        Excel
      </Button>
      <ExportRangeDialog
        open={asking}
        onOpenChange={(next) => {
          // Never close out from under a download in flight: the file would
          // still arrive, with nothing on screen having asked for it.
          if (!busy) setAsking(next);
        }}
        title="Download as Excel"
        rangedOn={rangedOn}
        formatNote={formatNote}
        busy={busy}
        onDownload={download}
      />
    </>
  );
}
