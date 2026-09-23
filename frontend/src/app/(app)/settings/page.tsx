"use client";

import { useState } from "react";
import { Store as StoreIcon } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROLE_LABELS } from "@/lib/types";
import { useChangePassword, useUpdateMe } from "@/lib/queries/auth";
import { useSession } from "@/store/use-session";
import { apiErrorMessage, phoneInputValue } from "@/lib/utils";

export default function SettingsPage() {
  const { user, currentStore, stores } = useSession();
  const role = useSession((s) => s.baseRole);

  // Assigned stores exclude the synthetic "All Stores" aggregate option.
  const assignedStores = stores.filter((s) => !s.isAggregate);

  return (
    <>
      <SectionHeader
        title="Settings"
        purpose="Manage your profile, security, and preferences."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Profile — read-only identity from the session. */}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Your account details.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--gold)] to-primary text-lg font-semibold text-primary-foreground shadow-sm">
                {user.initials}
              </div>
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{user.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {user.email}
                </p>
              </div>
            </div>

            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Role
                </dt>
                <dd className="text-sm font-medium">{ROLE_LABELS[role]}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Email
                </dt>
                <dd className="truncate text-sm font-medium">{user.email}</dd>
              </div>
            </dl>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Assigned stores
              </p>
              {assignedStores.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No stores assigned.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {assignedStores.map((store) => (
                    <li
                      key={store.id}
                      className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
                      {store.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Contact — the only details a person changes themselves. */}
        <ContactCard />

        {/* Security — change password (email/password auth only). */}
        <ChangePasswordCard />

        {/* Preferences — theme only (an editable device preference). */}
        <Card>
          <CardHeader>
            <CardTitle>Preferences</CardTitle>
            <CardDescription>
              Display preferences for this device.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Theme</p>
                <p className="text-xs text-muted-foreground">
                  Switch between light and dark.
                </p>
              </div>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>

        {/* Session — read-only current store context (changed via the top bar). */}
        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>
              The context your screens are currently scoped to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Current store</p>
                <p className="text-xs text-muted-foreground">
                  Switch stores from the store selector in the top bar.
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs">
                <StoreIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {currentStore.name}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ChangePasswordCard() {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  function clearFields() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  function submit() {
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation do not match.");
      return;
    }

    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          toast.success("Password updated");
          clearFields();
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update password — check your current password"),
          ),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security</CardTitle>
        <CardDescription>
          Change your password. Use at least 8 characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={changePassword.isPending}>
            {changePassword.isPending ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * How to reach me. Name, role, store and login ID are head office's to change,
 * so only these two are editable here.
 */
function ContactCard() {
  const user = useSession((s) => s.user);
  const hydrate = useSession((s) => s.hydrate);
  const update = useUpdateMe();
  const [phone, setPhone] = useState(user.phone ?? "");
  const [email, setEmail] = useState(user.contactEmail ?? "");
  const changed = phone !== (user.phone ?? "") || email !== (user.contactEmail ?? "");

  function save(e: React.FormEvent) {
    e.preventDefault();
    update.mutate(
      { phone, contactEmail: email },
      {
        onSuccess: (session) => {
          hydrate(session);
          setPhone(session.user.phone ?? "");
          setEmail(session.user.contactEmail ?? "");
          toast.success("Contact details saved");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not save your details.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact details</CardTitle>
        <CardDescription>
          How the team reaches you. Your name, role and store are set by head office.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="my-phone">Mobile number</Label>
            <Input
              id="my-phone"
              inputMode="numeric"
              maxLength={10}
              autoComplete="tel"
              placeholder="10-digit mobile"
              value={phone}
              onChange={(e) => setPhone(phoneInputValue(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="my-email">Personal email</Label>
            <Input
              id="my-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={!changed || update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
