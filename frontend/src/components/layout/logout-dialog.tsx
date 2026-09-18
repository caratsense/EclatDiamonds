"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setStoredStoreId, setStoredToken } from "@/lib/api";
import { clearAttendanceHandled } from "@/lib/attendance-gate";
import { useMyAttendance } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";

/**
 * End the app session: drop the token and store, clear cached data, go to
 * /login. It never touches attendance: signing out is not checking out.
 */
export function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const clear = useSession((s) => s.clear);
  return React.useCallback(() => {
    setStoredToken(null);
    setStoredStoreId(null);
    clearAttendanceHandled();
    clear();
    queryClient.clear();
    router.replace("/login");
  }, [router, queryClient, clear]);
}

interface LogoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sign-out confirmation. No identity check here: the person is already signed
 * in, and a camera frame is evidence, not verification, so it must never be
 * presented as "face verified".
 */
export function LogoutDialog({ open, onOpenChange }: LogoutDialogProps) {
  const signOut = useSignOut();
  const month = React.useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data: attendance } = useMyAttendance(month);
  const stillCheckedIn = !!attendance?.today?.checkInAt && !attendance?.today?.checkOutAt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign out?</DialogTitle>
          <DialogDescription>You&apos;ll need your password to sign in again.</DialogDescription>
        </DialogHeader>

        {stillCheckedIn ? (
          <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            You&apos;re still checked in. Signing out does not check you out. If your shift is over,
            check out on the attendance screen first.
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false);
              signOut();
            }}
          >
            <LogOut /> Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
