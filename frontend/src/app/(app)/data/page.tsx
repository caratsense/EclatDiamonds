"use client";

import { useState } from "react";
import { Database, FileSpreadsheet, History, Scale } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImportWizard } from "@/components/data/import-wizard";
import { SourcePanel } from "@/components/data/source-panel";
import { ConnectAgents } from "@/components/data/connect-agents";
import { KnowledgePanel } from "@/components/data/knowledge-panel";
import { useImportHistory, type FileImportOrigin } from "@/lib/queries/imports";
import {
  useConnectorRuntime,
  useJobs,
  useOriginReconciliation,
} from "@/lib/queries/tenant-config";

/**
 * Data & Imports (Phase A7, surfaced in A11).
 *
 * One screen for the question "where does our data come from, and what
 * happened to it?" — sources, the file-import wizard, what each run did, and a
 * reconciliation that answers the go-live question honestly.
 */
export default function DataPage() {
  const [tab, setTab] = useState("sources");
  const [entity, setEntity] = useState<string | undefined>(undefined);
  const [importOrigin, setImportOrigin] = useState<FileImportOrigin>("spreadsheet");
  const { data: sources } = useConnectorRuntime();

  // Importable entities come from the connector registry, so adding an importer
  // server-side makes it selectable here with no frontend change.
  const importEntities =
    sources?.find((s) => s.intakeMode === "file_upload")?.entities ?? [];

  return (
    <div>
      <SectionHeader
        title="Data & Imports"
        purpose="Bring your existing records in, see what each source has delivered, and check what came from where."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="import">Import a file</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="knowledge">AI knowledge</TabsTrigger>
          <TabsTrigger value="reconcile">Where data came from</TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-4 space-y-6">
          <SourcePanel
            onImportFile={(e, origin = "spreadsheet") => {
              setEntity(e);
              setImportOrigin(origin);
              setTab("import");
            }}
          />
          {/* The agents behind the push-based sources above. Kept on the same
              tab because "is my data arriving?" and "is the agent running?" are
              the same question asked twice. */}
          <ConnectAgents />
        </TabsContent>

        <TabsContent value="import" className="mt-4">
          {importEntities.length === 0 ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ImportWizard
              key={`${importOrigin}:${entity ?? "default"}`}
              entities={importEntities}
              initialEntity={entity}
              initialSourceSystem={importOrigin}
            />
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-4">
          <ImportHistory />
          <BackgroundJobs />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <KnowledgePanel />
        </TabsContent>

        <TabsContent value="reconcile" className="mt-4">
          <Reconciliation />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ImportHistory() {
  const { data, isLoading, isError } = useImportHistory();

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError) {
    return (
      <EmptyState icon={History} title="Could not load import history" />
    );
  }
  if (!data?.length) {
    return (
      <EmptyState
        icon={FileSpreadsheet}
        title="No imports yet"
        description="Every file you import is listed here with exactly what it did."
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import runs</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">File</th>
              <th className="pb-2 pr-3 font-medium">Source</th>
              <th className="pb-2 pr-3 font-medium">Records</th>
              <th className="pb-2 pr-3 font-medium">When</th>
              <th className="pb-2 pr-3 font-medium">New</th>
              <th className="pb-2 pr-3 font-medium">Updated</th>
              <th className="pb-2 pr-3 font-medium">Duplicate</th>
              <th className="pb-2 pr-3 font-medium">Failed</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className="border-b last:border-0">
                <td className="max-w-[180px] truncate py-2 pr-3">
                  {b.fileName ?? "—"}
                </td>
                <td className="py-2 pr-3 uppercase text-muted-foreground">
                  {b.sourceSystem}
                </td>
                <td className="py-2 pr-3 text-muted-foreground">{b.entity}</td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {new Date(b.createdAt).toLocaleString()}
                </td>
                <td className="num py-2 pr-3">{b.imported}</td>
                <td className="num py-2 pr-3">{b.updated}</td>
                <td className="num py-2 pr-3">{b.duplicate}</td>
                <td className="num py-2 pr-3">{b.failed}</td>
                <td className="py-2">
                  {/* A run interrupted mid-way stays "running" — the honest
                      state. It is shown rather than rounded up to completed. */}
                  <Badge
                    variant={
                      b.status === "completed"
                        ? "secondary"
                        : b.status === "running"
                          ? "outline"
                          : "destructive"
                    }
                  >
                    {b.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function BackgroundJobs() {
  const { data, isLoading } = useJobs();
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Background work</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {data.slice(0, 15).map((j) => (
          <div
            key={j.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
          >
            <span className="flex items-center gap-2">
              <Badge variant="outline">{j.kind}</Badge>
              <span className="text-muted-foreground">
                attempt {j.attempts} of {j.maxAttempts}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {j.lastError && (
                <span className="max-w-[280px] truncate text-xs text-destructive">
                  {j.lastError}
                </span>
              )}
              <Badge
                variant={
                  j.status === "done"
                    ? "secondary"
                    : j.status === "dead" || j.status === "failed"
                      ? "destructive"
                      : "outline"
                }
              >
                {j.status}
              </Badge>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Reconciliation() {
  const { data, isLoading, isError } = useOriginReconciliation();

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError || !data) {
    return <EmptyState icon={Scale} title="Could not load the origin breakdown" />;
  }

  const rows = Object.entries(data.byOrigin);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where your records came from</CardTitle>
          <p className="text-xs text-muted-foreground">
            Counted from each record&apos;s own provenance — not from a comparison with
            your old system, which CaratOS cannot read directly.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records yet.</p>
          ) : (
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">Record type</th>
                  <th className="pb-2 pr-3 font-medium">Came from your system</th>
                  <th className="pb-2 font-medium">Entered in CaratOS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([model, c]) => (
                  <tr key={model} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium capitalize">
                      {model.replace(/([A-Z])/g, " $1")}
                    </td>
                    <td className="num py-2 pr-3">{c.fromCustomer}</td>
                    <td className="num py-2">{c.local}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import totals</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tally label="Runs" value={data.imports.batches} />
          <Tally label="Rows read" value={data.imports.discovered} />
          <Tally label="New" value={data.imports.imported} />
          <Tally label="Updated" value={data.imports.updated} />
          <Tally label="Duplicate" value={data.imports.duplicate} />
          <Tally label="Failed" value={data.imports.failed} />
        </CardContent>
      </Card>

      {/* Outstanding provenance work, surfaced rather than buried in a comment. */}
      {data.remainingMigration && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-muted-foreground" />
              Known limitation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {data.remainingMigration}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num text-lg font-semibold">{value}</p>
    </div>
  );
}
