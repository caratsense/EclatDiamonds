"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { MaturityCalculator } from "@/components/loyalty/maturity-calculator";
import { ReferralProgram } from "@/components/loyalty/referral-program";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InstallmentProgress } from "@/components/loyalty/installment-progress";
import { formatINR } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { SCHEME_STATUS_LABELS, type SchemeStatus } from "@/lib/mock/loyalty";
import {
  useEnrollMember,
  useSchemeMembers,
  useSchemePlans,
} from "@/lib/queries/loyalty";
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { SchemePlansManager } from "@/components/loyalty/scheme-plans-manager";
import {
  apiErrorMessage,
  capIndianPhone,
  isRealName,
  normalizeIndianMobile,
} from "@/lib/utils";
import { useResetOn } from "@/lib/use-reset-on";

const STATUS_VARIANT: Record<
  SchemeStatus,
  "default" | "secondary" | "destructive" | "success" | "outline"
> = {
  active: "success",
  matured: "default",
  defaulted: "destructive",
  closed: "outline",
};

export default function LoyaltyPage() {
  const nav = getNavItem("loyalty");
  const { currentStore } = useSession();
  const role = useSession((s) => s.role);
  const { data: rows = [], isLoading, isError } = useSchemeMembers();
  const { data: plans = [] } = useSchemePlans();
  const enroll = useEnrollMember();

  // Controlled tab so the header action can jump to the enrollment card.
  const [tab, setTab] = React.useState("scheme");
  const customerRef = React.useRef<HTMLInputElement>(null);

  // Header primary action: reveal the scheme tab, then scroll to + focus the
  // enrollment form's first field.
  function focusEnrollment() {
    setTab("scheme");
    setTimeout(() => {
      customerRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      customerRef.current?.focus();
    }, 0);
  }

  // Enrollment form state.
  const [customer, setCustomer] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [chosenPlanId, setPlanId] = React.useState("");
  const [installment, setInstallment] = React.useState(10000);
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // Derived, not stored: an unmade choice MEANS the first plan, so there is no
  // frame in which the select renders empty and then corrects itself.
  const planId = chosenPlanId || plans[0]?.id || "";

  // Pre-fill the monthly amount from the selected plan's suggested installment
  // (e.g. a "₹5,000 × 11 months" scheme) so staff are not retyping it. This one
  // IS state — the staff member may overwrite it — so it is re-seeded when the
  // plan changes, during render rather than a frame later.
  useResetOn(planId, () => {
    const suggested = plans.find((p) => p.id === planId)?.defaultInstallment;
    if (suggested != null) setInstallment(suggested);
  });

  const atRisk = rows.filter(
    (m) => m.missedMonths > 0 && m.status !== "matured",
  );

  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? "—";

  const { targetStoreId, pickedStoreId, setPickedStoreId } = useStoreScope();

  function submit() {
    if (!targetStoreId) {
      toast.error("Select a store to enroll this customer at.");
      return;
    }
    const next: Record<string, string> = {};
    if (!customer.trim()) next.customer = "Customer name is required.";
    else if (!isRealName(customer))
      next.customer = "Enter a real name (letters, not just a number).";
    // Phone is optional here; only validate/normalise when one is entered.
    const normalizedPhone = phone.trim() ? normalizeIndianMobile(phone) : null;
    if (phone.trim() && !normalizedPhone)
      next.phone = "Enter a valid 10-digit mobile number.";
    if (!planId) next.plan = "Select a plan.";
    if (installment < 0) next.installment = "Amount can't be negative.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    enroll.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        phone: normalizedPhone ?? undefined,
        planId,
        installment,
      },
      {
        onSuccess: (m) => {
          toast.success("Customer enrolled", {
            description: `${m.ref} · ${planName(m.planId)}`,
          });
          setCustomer("");
          setPhone("");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not enroll customer.")),
      },
    );
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Loyalty & Gold Scheme"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction}
        onPrimaryAction={focusEnrollment}
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="scheme">Gold savings scheme</TabsTrigger>
          <TabsTrigger value="referral">Earn with Éclat</TabsTrigger>
        </TabsList>

        <TabsContent value="scheme" className="space-y-4">
      {/* Head Office defines the business's own scheme plans (Module 17). */}
      {role === "head_office" ? <SchemePlansManager /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* enrollment */}
        <Card>
          <CardHeader>
            <CardTitle>Scheme enrollment</CardTitle>
            <CardDescription>
              Onboard a customer onto a monthly gold-savings plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cust">
                  Customer <span className="text-destructive">*</span>
                </Label>
                <Input
                  ref={customerRef}
                  id="cust"
                  placeholder="Name"
                  value={customer}
                  aria-invalid={!!errors.customer}
                  onChange={(e) => {
                    setCustomer(e.target.value);
                    clearError("customer");
                  }}
                />
                {errors.customer ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.customer}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  placeholder="+91 …"
                  inputMode="tel"
                  value={phone}
                  aria-invalid={!!errors.phone}
                  onChange={(e) => {
                    setPhone(capIndianPhone(e.target.value));
                    clearError("phone");
                  }}
                />
                {errors.phone ? (
                  <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plan">
                  Plan <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={planId}
                  onValueChange={(v) => {
                    setPlanId(v);
                    clearError("plan");
                  }}
                  disabled={plans.length === 0}
                >
                  <SelectTrigger id="plan">
                    <SelectValue placeholder="Select a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.plan ? (
                  <p className="mt-1 text-xs text-destructive">{errors.plan}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inst">Monthly installment (₹)</Label>
                <Input
                  id="inst"
                  type="number"
                  min={0}
                  value={installment}
                  aria-invalid={!!errors.installment}
                  onChange={(e) => {
                    setInstallment(Number(e.target.value) || 0);
                    clearError("installment");
                  }}
                />
                {errors.installment ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.installment}
                  </p>
                ) : null}
              </div>
            </div>
            <Button
              className="w-full"
              onClick={submit}
              disabled={enroll.isPending}
            >
              {enroll.isPending ? "Enrolling…" : "Enroll customer"}
            </Button>
          </CardContent>
        </Card>

        {/* maturity calculator */}
        <Card>
          <CardHeader>
            <CardTitle>Maturity calculator</CardTitle>
            <CardDescription>
              Months × installment → maturity value with store bonus.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MaturityCalculator />
          </CardContent>
        </Card>
      </div>

      {/* default-risk flags */}
      {atRisk.length > 0 ? (
        <Card className="mb-4 border-warning/30">
          <CardContent className="flex flex-col gap-2 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-warning">
              <AlertTriangle className="h-4 w-4" />
              {atRisk.length} account{atRisk.length === 1 ? "" : "s"} with missed
              payments
            </div>
            <div className="flex flex-wrap gap-1.5">
              {atRisk.map((m) => (
                <Badge
                  key={m.id}
                  variant={m.status === "defaulted" ? "destructive" : "warning"}
                >
                  {m.customer} — {m.missedMonths} missed
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* member list */}
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {rows.length} scheme account{rows.length === 1 ? "" : "s"} for{" "}
            {currentStore.name}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
              Couldn&apos;t load scheme accounts. Check your connection and try
              again.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Installment</TableHead>
                  <TableHead className="w-[200px]">Installments</TableHead>
                  <TableHead className="text-right">Maturity</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => {
                  const maturity =
                    m.installment * (m.tenureMonths + m.bonusMonths);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">
                        <span className="num">{m.ref}</span>
                      </TableCell>
                      <TableCell>
                        <div>{m.customer}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.phone}
                        </div>
                      </TableCell>
                      <TableCell>{planName(m.planId)}</TableCell>
                      <TableCell className="text-right">
                        <span className="num">{formatINR(m.installment)}</span>
                      </TableCell>
                      <TableCell>
                        <InstallmentProgress
                          paidMonths={m.paidMonths}
                          tenureMonths={m.tenureMonths}
                          missedMonths={m.missedMonths}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">{formatINR(maturity)}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[m.status]}>
                          {SCHEME_STATUS_LABELS[m.status]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No members yet. Enroll a customer above.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="referral">
          <ReferralProgram />
        </TabsContent>
      </Tabs>
    </>
  );
}
