"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import {
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  useDepartments,
  useDesignations,
  useSaveEmployee,
  ymd,
  type EmployeeInput,
  type EmployeeRow,
  type EmploymentStatus,
  type EmploymentType,
} from "@/lib/queries/hrms-employees";
import { ROLE_LABELS, type Role, ACTIVE_ROLES } from "@/lib/types";
import { apiErrorMessage, normalizeIndianMobile } from "@/lib/utils";
import { useResetOn } from "@/lib/use-reset-on";
import { useSession } from "@/store/use-session";

/** Radix Select forbids "" as an item value. */
const NONE = "__none";

// Storeperson and area manager are retired; nobody can be given them.
const MANAGER_ROLES: Role[] = ["salesperson", "marketing"];
const GENDERS = [
  { value: "M", label: "Male" },
  { value: "F", label: "Female" },
  { value: "O", label: "Other" },
];
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

type Form = {
  name: string;
  employeeCode: string;
  gender: string;
  dateOfBirth: string;
  bloodGroup: string;
  role: Role;
  storeIds: string[];
  departmentId: string;
  designationId: string;
  employmentType: EmploymentType;
  status: EmploymentStatus;
  shiftCode: string;
  reportingManagerId: string;
  unit: string;
  biometricNo: string;
  dateOfJoining: string;
  dateOfConfirmation: string;
  phone: string;
  personalEmail: string;
  address: string;
};

function toForm(e: EmployeeRow | null, defaultStoreId: string): Form {
  return {
    name: e?.name ?? "",
    employeeCode: e?.employeeCode ?? "",
    gender: e?.gender ?? "",
    dateOfBirth: ymd(e?.dateOfBirth),
    bloodGroup: e?.bloodGroup ?? "",
    role: e?.role ?? "salesperson",
    storeIds: e?.storeIds ?? (defaultStoreId ? [defaultStoreId] : []),
    departmentId: e?.department?.id ?? "",
    designationId: e?.designation?.id ?? "",
    employmentType: e?.employmentType ?? "full_time",
    status: e?.status ?? "active",
    shiftCode: e?.shiftCode ?? "",
    reportingManagerId: e?.reportingManager?.id ?? "",
    unit: e?.unit ?? "",
    biometricNo: e?.biometricNo ?? "",
    dateOfJoining: ymd(e?.dateOfJoining),
    dateOfConfirmation: ymd(e?.dateOfConfirmation),
    phone: e?.phone ?? "",
    personalEmail: e?.personalEmail ?? "",
    address: e?.address ?? "",
  };
}

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const err: Partial<Record<keyof Form, string>> = {};
  if (!f.name.trim()) err.name = "Name is required.";
  if (!f.employeeCode.trim()) err.employeeCode = "Employee code is required.";
  else if (!/^\S{1,30}$/.test(f.employeeCode.trim()))
    err.employeeCode = "No spaces, at most 30 characters.";
  if (f.role !== "head_office" && f.storeIds.length === 0)
    err.storeIds = "Pick at least one store.";
  if (f.phone.trim() && !normalizeIndianMobile(f.phone))
    err.phone = "Enter a valid 10-digit Indian mobile.";
  if (f.personalEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.personalEmail.trim()))
    err.personalEmail = "Enter a valid email.";
  const today = new Date().toISOString().slice(0, 10);
  if (f.dateOfBirth && f.dateOfBirth >= today) err.dateOfBirth = "Must be in the past.";
  if (f.dateOfBirth && f.dateOfJoining && f.dateOfJoining <= f.dateOfBirth)
    err.dateOfJoining = "Must be after the date of birth.";
  if (f.dateOfConfirmation && f.dateOfJoining && f.dateOfConfirmation < f.dateOfJoining)
    err.dateOfConfirmation = "Cannot be before the joining date.";
  return err;
}

/** Blank string → null so a cleared field is actually cleared server-side. */
const orNull = (v: string) => (v.trim() ? v.trim() : null);

/**
 * Add / edit an employee. `employee` null = new; a row with `hasProfile:false`
 * opens as "Create profile" for an existing CaratOS login.
 */
export function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
  people,
  isHeadOffice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeRow | null;
  /** Candidates for "reporting manager". */
  people: EmployeeRow[];
  isHeadOffice: boolean;
}) {
  const { stores, currentStore } = useSession();
  const realStores = stores.filter((s) => !s.isAggregate);
  const defaultStoreId = currentStore.isAggregate ? "" : currentStore.id;
  const departments = useDepartments();
  const designations = useDesignations();
  const save = useSaveEmployee();

  const [form, setForm] = useState<Form>(() => toForm(employee, defaultStoreId));
  const [touched, setTouched] = useState(false);
  useResetOn(open ? (employee?.userId ?? "new") : null, () => {
    setForm(toForm(employee, defaultStoreId));
    setTouched(false);
  });

  const isNew = !employee;
  // Role and store moves are head-office decisions (the API enforces the same).
  const canMove = isNew || isHeadOffice;
  const errors = validate(form);
  const shown = touched ? errors : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    setTouched(true);
    if (Object.keys(errors).length) {
      toast.error("Fix the highlighted fields.");
      return;
    }
    const body: EmployeeInput & { userId?: string } = {
      userId: employee?.userId,
      name: form.name.trim(),
      employeeCode: form.employeeCode.trim(),
      phone: form.phone.trim() ? normalizeIndianMobile(form.phone) : null,
      personalEmail: orNull(form.personalEmail),
      departmentId: form.departmentId || null,
      designationId: form.designationId || null,
      unit: orNull(form.unit),
      gender: form.gender || null,
      dateOfBirth: form.dateOfBirth || null,
      dateOfJoining: form.dateOfJoining || null,
      dateOfConfirmation: form.dateOfConfirmation || null,
      employmentType: form.employmentType,
      bloodGroup: form.bloodGroup || null,
      address: orNull(form.address),
      biometricNo: orNull(form.biometricNo),
      shiftCode: orNull(form.shiftCode),
      reportingManagerId: form.reportingManagerId || null,
      // Separation has its own flow (exit date + reason); only active/inactive here.
      ...(employee?.status !== "separated" ? { status: form.status } : {}),
      ...(canMove ? { role: form.role, storeIds: form.storeIds } : {}),
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(isNew ? `${body.name} added` : `${body.name} updated`, {
          description: isNew
            ? "The login stays inactive until head office issues it."
            : undefined,
        });
        onOpenChange(false);
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Could not save the employee.")),
    });
  }

  const roleOptions: Role[] = isHeadOffice ? ACTIVE_ROLES : MANAGER_ROLES;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Add employee" : employee.hasProfile ? `Edit ${employee.name}` : `Create profile for ${employee.name}`}
          </DialogTitle>
          <DialogDescription>
            Fields marked <span className="text-destructive">*</span> are required.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          noValidate
        >
          <Group title="Identity">
            <Field label="Full name" required error={shown.name}>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus />
            </Field>
            <Field label="Employee code" required error={shown.employeeCode} hint="e.g. ED003">
              <Input
                value={form.employeeCode}
                onChange={(e) => set("employeeCode", e.target.value)}
                className="num"
              />
            </Field>
            <Field label="Gender">
              <OptSelect
                value={form.gender}
                onChange={(v) => set("gender", v)}
                options={GENDERS}
              />
            </Field>
            <Field label="Blood group">
              <OptSelect
                value={form.bloodGroup}
                onChange={(v) => set("bloodGroup", v)}
                options={BLOOD_GROUPS.map((b) => ({ value: b, label: b }))}
              />
            </Field>
          </Group>

          <Group title="Job">
            <Field label="Role" required hint={canMove ? undefined : "Only head office can change roles."}>
              <Select value={form.role} onValueChange={(v) => set("role", v as Role)} disabled={!canMove}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Keep the current role visible even if this user may not assign it. */}
                  {(roleOptions.includes(form.role) ? roleOptions : [form.role, ...roleOptions]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Employment type">
              <Select
                value={form.employmentType}
                onValueChange={(v) => set("employmentType", v as EmploymentType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Department">
              <OptSelect
                value={form.departmentId}
                onChange={(v) => set("departmentId", v)}
                options={(departments.data ?? [])
                  .filter((d) => d.isActive || d.id === form.departmentId)
                  .map((d) => ({ value: d.id, label: d.name }))}
                placeholder={departments.isLoading ? "Loading…" : undefined}
              />
            </Field>
            <Field label="Designation">
              <OptSelect
                value={form.designationId}
                onChange={(v) => set("designationId", v)}
                options={(designations.data ?? [])
                  .filter((d) => d.isActive || d.id === form.designationId)
                  .map((d) => ({ value: d.id, label: d.name }))}
                placeholder={designations.isLoading ? "Loading…" : undefined}
              />
            </Field>
            <Field label="Reporting manager">
              <OptSelect
                value={form.reportingManagerId}
                onChange={(v) => set("reportingManagerId", v)}
                options={people
                  .filter((p) => p.userId !== employee?.userId && p.status !== "separated")
                  .map((p) => ({ value: p.userId, label: p.name }))}
              />
            </Field>
            <Field label="Status" hint={employee?.status === "separated" ? "Use Reactivate to bring a separated employee back." : undefined}>
              <Select
                value={form.status}
                onValueChange={(v) => set("status", v as EmploymentStatus)}
                disabled={employee?.status === "separated"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(EMPLOYMENT_STATUS_LABELS) as EmploymentStatus[]).map((s) => (
                    <SelectItem key={s} value={s} disabled={s === "separated"}>
                      {EMPLOYMENT_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Stores"
                required={form.role !== "head_office"}
                error={shown.storeIds}
                hint={canMove ? undefined : "Only head office can move an employee between stores."}
              >
                <div className="flex flex-wrap gap-2" role="group" aria-label="Stores">
                  {realStores.map((s) => {
                    const on = form.storeIds.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:checked]:border-gold has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!canMove}
                          onChange={() =>
                            set(
                              "storeIds",
                              on ? form.storeIds.filter((x) => x !== s.id) : [...form.storeIds, s.id],
                            )
                          }
                        />
                        {s.name}
                      </label>
                    );
                  })}
                </div>
              </Field>
            </div>
          </Group>

          <Group title="Dates">
            <Field label="Date of birth" error={shown.dateOfBirth}>
              <Input type="date" value={form.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} />
            </Field>
            <Field label="Date of joining" error={shown.dateOfJoining}>
              <Input type="date" value={form.dateOfJoining} onChange={(e) => set("dateOfJoining", e.target.value)} />
            </Field>
            <Field label="Date of confirmation" error={shown.dateOfConfirmation}>
              <Input
                type="date"
                value={form.dateOfConfirmation}
                onChange={(e) => set("dateOfConfirmation", e.target.value)}
              />
            </Field>
            {employee?.exitDate ? (
              <Field label="Exit date" hint={employee.exitReason ?? undefined}>
                <Input type="date" value={ymd(employee.exitDate)} disabled />
              </Field>
            ) : null}
          </Group>

          <Group title="Contact">
            <Field label="Mobile" error={shown.phone}>
              <Input
                type="tel"
                inputMode="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="98xxxxxxxx"
              />
            </Field>
            <Field label="Personal email" error={shown.personalEmail}>
              <Input
                type="email"
                value={form.personalEmail}
                onChange={(e) => set("personalEmail", e.target.value)}
              />
            </Field>
            {employee?.loginEmail ? (
              <Field label="Login" hint="Managed in Settings → Team.">
                <Input value={employee.loginEmail} disabled />
              </Field>
            ) : null}
            <div className="sm:col-span-2">
              <Field label="Address">
                <Textarea rows={2} value={form.address} onChange={(e) => set("address", e.target.value)} />
              </Field>
            </div>
          </Group>

          <Group title="Other">
            <Field label="Shift code" hint="EzAttendance code: S, G, 6HR, F…">
              <Input value={form.shiftCode} onChange={(e) => set("shiftCode", e.target.value)} className="num" />
            </Field>
            <Field label="Legacy attendance ID (optional)">
              <Input
                value={form.biometricNo}
                onChange={(e) => set("biometricNo", e.target.value)}
                className="num"
                placeholder="Imported terminal identifier"
              />
            </Field>
            <Field label="Unit" hint="City / legal unit">
              <Input value={form.unit} onChange={(e) => set("unit", e.target.value)} />
            </Field>
          </Group>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              {isNew ? "Add employee" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {title}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Optional select with a "—" (none) choice. */
function OptSelect({
  value,
  onChange,
  options,
  placeholder = "—",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>—</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
