"use client";

import * as React from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAllSchemePlans,
  useCreateSchemePlan,
  useDeleteSchemePlan,
  useUpdateSchemePlan,
  type SchemePlanInput,
} from "@/lib/queries/loyalty";
import type { SchemePlan } from "@/lib/mock/loyalty";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Head-Office management for gold-savings scheme plans (Module 17).
 *
 * Nothing here ships pre-seeded: the business defines its own scheme. The
 * templates below are only shortcuts that pre-fill the form with the common
 * Indian jewellery structures — the user still names it and saves it, so every
 * live plan is client-authored.
 */

interface Template {
  key: string;
  label: string;
  hint: string;
  values: SchemePlanInput;
}

const TEMPLATES: Template[] = [
  {
    key: "10+1",
    label: "10 + 1",
    hint: "Customer pays 10 months, store funds 1 bonus installment.",
    values: {
      name: "10 + 1 Gold Scheme",
      tenureMonths: 10,
      bonusMonths: 1,
      bonusLabel: "Pay 10 months, 1 bonus month on maturity",
      defaultInstallment: 5000,
    },
  },
  {
    key: "10+2",
    label: "10 + 2",
    hint: "Customer pays 10 months, store funds 2 bonus installments.",
    values: {
      name: "10 + 2 Gold Scheme",
      tenureMonths: 10,
      bonusMonths: 2,
      bonusLabel: "Pay 10 months, 2 bonus months on maturity",
      defaultInstallment: 5000,
    },
  },
  {
    key: "11+1",
    label: "11 + 1",
    hint: "Customer pays 11 months, the store funds the 12th.",
    values: {
      name: "11 + 1 Gold Scheme",
      tenureMonths: 11,
      bonusMonths: 1,
      bonusLabel: "Pay 11 months, the 12th is on us",
      defaultInstallment: 5000,
    },
  },
  {
    key: "12+1",
    label: "12 + 1",
    hint: "A full year of payments with one bonus installment.",
    values: {
      name: "12 + 1 Gold Scheme",
      tenureMonths: 12,
      bonusMonths: 1,
      bonusLabel: "One bonus installment on maturity",
      defaultInstallment: 5000,
    },
  },
  {
    key: "24+3",
    label: "24 + 3",
    hint: "A two-year plan with a larger maturity bonus.",
    values: {
      name: "24 + 3 Gold Scheme",
      tenureMonths: 24,
      bonusMonths: 3,
      bonusLabel: "Three bonus installments on maturity",
      defaultInstallment: 5000,
    },
  },
  {
    key: "flexi",
    label: "No bonus",
    hint: "A plain savings plan with no store-funded bonus.",
    values: {
      name: "Monthly Savings Plan",
      tenureMonths: 12,
      bonusMonths: 0,
      bonusLabel: "",
      defaultInstallment: undefined,
    },
  },
];


const EMPTY: SchemePlanInput = {
  name: "",
  tenureMonths: 11,
  bonusMonths: 0,
  bonusLabel: "",
  defaultInstallment: undefined,
  isActive: true,
};

export function SchemePlansManager() {
  const { data: plans = [], isLoading } = useAllSchemePlans();
  const create = useCreateSchemePlan();
  const update = useUpdateSchemePlan();
  const remove = useDeleteSchemePlan();

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SchemePlan | null>(null);
  const [form, setForm] = React.useState<SchemePlanInput>(EMPTY);

  function openNew(values: SchemePlanInput = EMPTY) {
    setEditing(null);
    setForm({ ...values });
    setOpen(true);
  }

  function openEdit(plan: SchemePlan) {
    setEditing(plan);
    setForm({
      name: plan.name,
      tenureMonths: plan.tenureMonths,
      bonusMonths: plan.bonusMonths,
      bonusLabel: plan.bonusLabel ?? "",
      defaultInstallment: plan.defaultInstallment ?? undefined,
      isActive: plan.isActive ?? true,
    });
    setOpen(true);
  }

  async function save() {
    if (!form.name.trim() || form.name.trim().length < 2) {
      toast.error("Give the plan a name");
      return;
    }
    if (!form.tenureMonths || form.tenureMonths < 1) {
      toast.error("Tenure must be at least 1 month");
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, ...form });
        toast.success(`Updated "${form.name}"`);
      } else {
        await create.mutateAsync(form);
        toast.success(`Created "${form.name}"`);
      }
      setOpen(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not save the plan"));
    }
  }

  async function toggleActive(plan: SchemePlan) {
    const next = !(plan.isActive ?? true);
    try {
      await update.mutateAsync({ id: plan.id, isActive: next });
      toast.success(next ? `"${plan.name}" is live` : `"${plan.name}" retired`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not update the plan"));
    }
  }

  async function destroy(plan: SchemePlan) {
    try {
      await remove.mutateAsync(plan.id);
      toast.success(`Deleted "${plan.name}"`);
    } catch (err) {
      // The API refuses to delete a plan that members are enrolled on.
      toast.error(apiErrorMessage(err, "Could not delete the plan"));
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Scheme plans</CardTitle>
          <CardDescription>
            Define your own gold-savings scheme. Start from a template below or
            build one from scratch — you set the tenure, the bonus and the monthly
            amount.
          </CardDescription>
        </div>
        <Button onClick={() => openNew()} className="shrink-0">
          <Plus className="h-4 w-4" /> New plan
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Templates — shortcuts that only pre-fill the form. */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Start from a template
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => openNew(t.values)}
                className="rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent"
              >
                <div className="num text-sm font-semibold">{t.label}</div>
                <div className="mt-1 text-xs leading-snug text-muted-foreground">
                  {t.hint}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Existing plans */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading plans…
          </div>
        ) : plans.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm font-medium">No scheme plans yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The gold-savings scheme is not running until you create a plan.
              Pick a template above or create your own.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Structure</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      {p.bonusLabel ? (
                        <div className="text-xs text-muted-foreground">
                          {p.bonusLabel}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="num">
                      {p.tenureMonths}
                      {p.bonusMonths > 0 ? ` + ${p.bonusMonths}` : ""} months
                    </TableCell>
                    <TableCell className="num">
                      {p.defaultInstallment != null
                        ? `₹${p.defaultInstallment.toLocaleString("en-IN")}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggleActive(p)}
                        title={
                          p.isActive ?? true
                            ? "Retire this plan (hidden from new enrollments)"
                            : "Make this plan live"
                        }
                      >
                        <Badge variant={p.isActive ?? true ? "default" : "secondary"}>
                          {p.isActive ?? true ? "Live" : "Retired"}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(p)}
                        aria-label={`Edit ${p.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => destroy(p)}
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Create / edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit plan" : "New scheme plan"}</DialogTitle>
            <DialogDescription>
              These terms are shown to staff at enrollment and drive the
              installment schedule.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="plan-name">Plan name</Label>
              <Input
                id="plan-name"
                value={form.name}
                placeholder="e.g. 11 + 1 Gold Scheme"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="plan-tenure">Paying months</Label>
                <Input
                  id="plan-tenure"
                  type="number"
                  min={1}
                  max={120}
                  value={form.tenureMonths}
                  onChange={(e) =>
                    setForm({ ...form, tenureMonths: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan-bonus">Bonus months</Label>
                <Input
                  id="plan-bonus"
                  type="number"
                  min={0}
                  max={24}
                  value={form.bonusMonths ?? 0}
                  onChange={(e) =>
                    setForm({ ...form, bonusMonths: Number(e.target.value) })
                  }
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="plan-amount">
                Suggested monthly amount (optional)
              </Label>
              <Input
                id="plan-amount"
                type="number"
                min={0}
                placeholder="e.g. 5000"
                value={form.defaultInstallment ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    defaultInstallment:
                      e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Pre-filled at enrollment. Leave blank to enter it per customer.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="plan-label">Customer-facing note (optional)</Label>
              <Input
                id="plan-label"
                value={form.bonusLabel ?? ""}
                placeholder="e.g. Pay 11 months, the 12th is on us"
                onChange={(e) => setForm({ ...form, bonusLabel: e.target.value })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {editing ? "Save changes" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
