"use client";

import { useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";

/**
 * "Download as Excel" for a data-collection screen (client, 7 Oct: everywhere
 * data is collected, the sheet must be downloadable).
 *
 * `responseType: "blob"` matters: without it the XLSX bytes are read as text
 * and the saved file will not open. The filename comes from the server's
 * Content-Disposition so what a person saves matches what the server logged.
 */
export function ExcelExportButton({ path, fallbackName }: { path: string; fallbackName: string }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const res = await api.get<Blob>(path, { responseType: "blob" });
      const disposition = String(res.headers?.["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? fallbackName;
      const rows = res.headers?.["x-export-rows"];

      const url = URL.createObjectURL(res.data);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      toast.success(rows != null ? `${filename} — ${rows} rows` : filename);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not build the Excel file."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={download} disabled={busy}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
      Excel
    </Button>
  );
}
