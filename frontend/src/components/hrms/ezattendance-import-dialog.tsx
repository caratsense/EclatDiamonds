"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, Loader2, UserX } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/hrms/confirm-dialog";
import {
  useBulkEmployees,
  useEzAttendanceImport,
  type ImportResult,
} from "@/lib/queries/hrms-employees";
import { ROLE_LABELS, type Store } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useResetOn } from "@/lib/use-reset-on";
import { useSession } from "@/store/use-session";

const NONE = "__none";
type Step = "files" | "map" | "preview" | "done";

/** Minimal RFC-4180 CSV reader (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Distinct DEPARTMENT values, grouped case-insensitively (first spelling wins,
 * as the backend does). The header may sit below export title rows.
 */
export function departmentsIn(text: string): string[] {
  const rows = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const h = rows.findIndex((r) => r.some((c) => c.trim().toUpperCase() === "DEPARTMENT"));
  if (h < 0) return [];
  const col = rows[h].findIndex((c) => c.trim().toUpperCase() === "DEPARTMENT");
  const seen = new Map<string, string>();
  for (const r of rows.slice(h + 1)) {
    const v = (r[col] ?? "").trim();
    if (v && v.toLowerCase() !== "null" && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/**
 * Best store for a department name, or "" (head office / none).
 * ponytail: substring + shared-word heuristic; good enough for a handful of
 * branch names, the user confirms every row anyway.
 */
export function guessStore(dept: string, stores: Pick<Store, "id" | "name" | "city">[]): string {
  const d = norm(dept);
  if (!d) return "";
  let best = { id: "", score: 0 };
  for (const s of stores) {
    const n = norm(s.name);
    let score = 0;
    if (n === d) score = 100;
    else if (n.includes(d) || d.includes(n)) score = 50;
    else {
      const sw = new Set([...words(s.name), ...words(s.city ?? "")]);
      score = words(dept).filter((w) => sw.has(w)).length * 10;
    }
    if (score > best.score) best = { id: s.id, score };
  }
  return best.id;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Import from EzAttendance: files → department→store mapping → dry-run preview
 * → apply → summary. Head office only (the endpoint is @Roles('head_office')).
 */
export function EzAttendanceImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const run = useEzAttendanceImport();

  const [step, setStep] = useState<Step>("files");
  const [employees, setEmployees] = useState<File | null>(null);
  const [leaveBalances, setLeaveBalances] = useState<File | null>(null);
  const [todaysPunch, setTodaysPunch] = useState<File | null>(null);
  const [attendanceDate, setAttendanceDate] = useState(todayLocal);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useResetOn(open, () => {
    if (!open) return;
    setStep("files");
    setEmployees(null);
    setLeaveBalances(null);
    setTodaysPunch(null);
    setAttendanceDate(todayLocal());
    setMapping({});
    setResult(null);
  });

  async function toMapping() {
    if (!employees) return;
    setReading(true);
    try {
      const depts = departmentsIn(await employees.text());
      if (depts.length === 0) {
        toast.error("No DEPARTMENT column found. Is this the Employee Master export?");
        return;
      }
      setMapping(Object.fromEntries(depts.map((d) => [d, mapping[d] ?? guessStore(d, stores)])));
      setStep("map");
    } catch {
      toast.error("Could not read that file.");
    } finally {
      setReading(false);
    }
  }

  function submit(dryRun: boolean) {
    if (!employees) return;
    run.mutate(
      {
        employees,
        leaveBalances,
        todaysPunch,
        attendanceDate: todaysPunch ? attendanceDate : undefined,
        departmentStores: Object.fromEntries(
          Object.entries(mapping).map(([k, v]) => [k, v || null]),
        ),
        dryRun,
      },
      {
        onSuccess: (res) => {
          setResult(res);
          setStep(dryRun ? "preview" : "done");
          if (!dryRun) toast.success("EzAttendance import applied");
        },
        onError: (e) => toast.error(apiErrorMessage(e, dryRun ? "Preview failed." : "Import failed.")),
      },
    );
  }

  const stepNo = { files: 1, map: 2, preview: 3, done: 4 }[step];

  return (
    <Dialog open={open} onOpenChange={(o) => !run.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from EzAttendance</DialogTitle>
          <DialogDescription>
            Step {Math.min(stepNo, 3)} of 3 ·{" "}
            {
              {
                files: "Choose the exported files",
                map: "Match each department to a store",
                preview: "Check what will change — nothing is saved yet",
                done: "Import applied",
              }[step]
            }
          </DialogDescription>
        </DialogHeader>

        {step === "files" ? (
          <div className="space-y-4">
            <FilePick
              label="Employee master CSV"
              hint="Employee-Master-Full.csv"
              required
              file={employees}
              onChange={setEmployees}
            />
            <FilePick
              label="Leave balance CSV"
              hint="Leave-Balance-2026.csv (optional)"
              file={leaveBalances}
              onChange={setLeaveBalances}
            />
            <FilePick
              label="Today's punch CSV"
              hint="Todays-Punch-*.csv (optional)"
              file={todaysPunch}
              onChange={setTodaysPunch}
            />
            {todaysPunch ? (
              <div className="grid gap-1.5 sm:w-56">
                <Label htmlFor="ez-date">Attendance date of the punch file</Label>
                <Input
                  id="ez-date"
                  type="date"
                  value={attendanceDate}
                  max={todayLocal()}
                  onChange={(e) => setAttendanceDate(e.target.value)}
                />
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              These files hold personal data. They are sent straight to the server and not kept in the
              browser.
            </p>
          </div>
        ) : null}

        {step === "map" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              EzAttendance used departments for branches. Pre-filled by name — check every row.
            </p>
            {Object.keys(mapping).map((d) => (
              <div
                key={d}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium">{d}</span>
                <Select
                  value={mapping[d] || NONE}
                  onValueChange={(v) => setMapping((m) => ({ ...m, [d]: v === NONE ? "" : v }))}
                >
                  <SelectTrigger className="sm:w-64" aria-label={`Store for ${d}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Head office / none</SelectItem>
                    {stores.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        ) : null}

        {(step === "preview" || step === "done") && result ? <ResultView result={result} /> : null}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === "map" || step === "preview" ? (
            <Button
              variant="outline"
              disabled={run.isPending}
              onClick={() => setStep(step === "map" ? "files" : "map")}
            >
              <ArrowLeft /> Back
            </Button>
          ) : null}
          {step === "files" ? (
            <Button disabled={!employees || reading} onClick={toMapping}>
              {reading ? <Loader2 className="animate-spin" /> : null}
              Next
            </Button>
          ) : step === "map" ? (
            <Button disabled={run.isPending} onClick={() => submit(true)}>
              {run.isPending ? <Loader2 className="animate-spin" /> : null}
              Preview changes
            </Button>
          ) : step === "preview" ? (
            <Button variant="gold" disabled={run.isPending} onClick={() => submit(false)}>
              {run.isPending ? <Loader2 className="animate-spin" /> : null}
              Apply import
            </Button>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilePick({
  label,
  hint,
  required,
  file,
  onChange,
}: {
  label: string;
  hint: string;
  required?: boolean;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const id = `ez-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <label
        htmlFor={id}
        className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm hover:bg-muted/40"
      >
        <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {file ? file.name : <span className="text-muted-foreground">{hint}</span>}
        </span>
        {file ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.preventDefault();
              onChange(null);
            }}
          >
            Remove
          </Button>
        ) : null}
      </label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        // Reset the value so picking the same file again still fires onChange.
        onClick={(e) => ((e.target as HTMLInputElement).value = "")}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function ResultView({ result: r }: { result: ImportResult }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = r.employees.rows.filter((x) => showUnchanged || x.action !== "unchanged");
  const skipped = [
    ...r.leaveBalances.skipped.map((s) => ({ ...s, file: "Leave balance" })),
    ...r.attendance.skipped.map((s) => ({ ...s, file: "Punch" })),
  ];
  return (
    <div className="space-y-5">
      {!r.dryRun ? (
        <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 text-success" /> Saved. Running the same files again changes
          nothing.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Count label="New" value={r.employees.created} />
        <Count label="Updated" value={r.employees.updated} />
        <Count label="Unchanged" value={r.employees.unchanged} />
        <Count label="Leave balances" value={r.leaveBalances.upserted} />
        <Count label="Attendance rows" value={r.attendance.upserted} />
      </div>

      {r.departments.created.length || r.designations.created.length ? (
        <p className="text-sm">
          {r.departments.created.length ? (
            <>New departments: {r.departments.created.join(", ")}. </>
          ) : null}
          {r.designations.created.length ? (
            <>New designations: {r.designations.created.join(", ")}.</>
          ) : null}
        </p>
      ) : null}

      <Section
        title="Employees"
        action={
          r.employees.unchanged ? (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(e) => setShowUnchanged(e.target.checked)}
              />
              Show unchanged
            </label>
          ) : null
        }
      >
        {rows.length === 0 ? (
          <Empty>Nothing to change.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((x) => (
                <TableRow key={`${x.code}-${x.name}`}>
                  <TableCell className="num">{x.code}</TableCell>
                  <TableCell>{x.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={x.action === "create" ? "success" : x.action === "update" ? "gold" : "secondary"}
                    >
                      {x.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {x.changes.length ? x.changes.join("; ") : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={`Data issues (${r.exceptions.length})`} warn={r.exceptions.length > 0}>
        {r.exceptions.length === 0 ? (
          <Empty>No issues found.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Issue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.exceptions.map((x, i) => (
                <TableRow key={i}>
                  <TableCell className="num">{x.code}</TableCell>
                  <TableCell>{x.field}</TableCell>
                  <TableCell className="text-xs">{x.issue}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {skipped.length ? (
        <Section title={`Skipped rows (${skipped.length})`}>
          <ul className="space-y-1 text-xs">
            {skipped.map((s, i) => (
              <li key={i}>
                <span className="num">{s.code}</span> · {s.file}: {s.reason}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <NotInSource people={r.notInSource} />
    </div>
  );
}

/** CaratOS staff absent from the EzAttendance file — optionally deactivate. */
function NotInSource({ people }: { people: ImportResult["notInSource"] }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const bulk = useBulkEmployees();
  const left = people.filter((p) => !done.has(p.userId));

  function deactivate() {
    const userIds = [...picked];
    bulk.mutate(
      { userIds, action: "deactivate" },
      {
        onSuccess: () => {
          toast.success(`Deactivated ${userIds.length}`);
          setDone((d) => new Set([...d, ...userIds]));
          setPicked(new Set());
          setConfirming(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not deactivate.")),
      },
    );
  }

  return (
    <Section
      title={`In CaratOS but not in EzAttendance (${left.length})`}
      action={
        picked.size ? (
          <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
            <UserX /> Deactivate {picked.size}
          </Button>
        ) : null
      }
    >
      {left.length === 0 ? (
        <Empty>Everyone in CaratOS is in the file.</Empty>
      ) : (
        <ul className="divide-y rounded-lg border">
          {left.map((p) => (
            <li key={p.userId}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(p.userId)}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(p.userId)) n.delete(p.userId);
                      else n.add(p.userId);
                      return n;
                    })
                  }
                />
                <span className="flex-1">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  {ROLE_LABELS[p.role] ?? p.role}
                  {p.storeNames.length ? ` · ${p.storeNames.join(", ")}` : ""}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Deactivate ${picked.size} ${picked.size === 1 ? "person" : "people"}?`}
        description="Their logins stop working and they drop out of attendance counts. History is kept; you can reactivate them from the Employees list."
        confirmLabel="Deactivate"
        pending={bulk.isPending}
        onConfirm={deactivate}
      />
    </Section>
  );
}

function Section({
  title,
  warn,
  action,
  children,
}: {
  title: string;
  warn?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {warn ? (
            <AlertTriangle className="h-4 w-4 text-warning" />
          ) : null}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="num text-xl font-semibold">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">{children}</p>
  );
}
