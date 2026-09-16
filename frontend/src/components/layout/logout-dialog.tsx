"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  LogOut,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import { api, setStoredStoreId, setStoredToken } from "@/lib/api";
import { useCheckOut, useMyAttendance } from "@/lib/queries/hrms";
import { useSession } from "@/store/use-session";
import { FaceScannerDialog } from "@/components/biometrics/face-scanner-dialog";

interface LogoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LogoutDialog({ open, onOpenChange }: LogoutDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, clear } = useSession();
  const month = React.useMemo(() => new Date().toISOString().slice(0, 7), []);
  const { data: attendance } = useMyAttendance(month);
  const checkOutMutation = useCheckOut();

  const [verifyMode, setVerifyMode] = React.useState<"password" | "face">("password");
  const [password, setPassword] = React.useState("");
  const [faceScannerOpen, setFaceScannerOpen] = React.useState(false);
  const [faceVerified, setFaceVerified] = React.useState(false);
  const [isVerifying, setIsVerifying] = React.useState(false);
  const [autoPunchOut, setAutoPunchOut] = React.useState(true);

  // Retrieve enrolled face photo from localStorage
  const enrolledPhoto = React.useMemo(() => {
    if (typeof window === "undefined" || !user?.id) return null;
    return localStorage.getItem(`eclat_face_photo_${user.id}`);
  }, [user?.id]);

  // Compute active time spent today
  const timeSpentToday = React.useMemo(() => {
    const checkIn = attendance?.today?.checkInAt;
    if (checkIn) {
      const start = new Date(checkIn).getTime();
      const now = Date.now();
      const diffMs = Math.max(0, now - start);
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      if (hours > 0) return `${hours} hr ${mins} min`;
      return `${mins} min`;
    }
    return "Full Shift";
  }, [attendance?.today?.checkInAt]);

  const isCheckedIn = !!attendance?.today?.checkInAt && !attendance?.today?.checkOutAt;

  async function performSignOut() {
    setIsVerifying(true);
    try {
      // 1. If user chose password verification and is not face-verified
      if (verifyMode === "password" && !faceVerified) {
        if (!password.trim()) {
          toast.error("Please enter your password to sign out.");
          setIsVerifying(false);
          return;
        }
        // Verify credentials with backend
        try {
          await api.post("/auth/login", {
            email: user.email,
            password,
          });
        } catch {
          toast.error("Incorrect password. Please try again or use Face verify.");
          setIsVerifying(false);
          return;
        }
      }

      // 2. Punch out if user is currently checked in and opted to auto-punch out
      if (isCheckedIn && autoPunchOut) {
        try {
          await checkOutMutation.mutateAsync({
            note: "Automatic check-out on staff logout",
          });
        } catch {
          // Non-blocking punch-out attempt
        }
      }

      // 3. Clear session and redirect
      setStoredToken(null);
      setStoredStoreId(null);
      clear();
      queryClient.clear();
      onOpenChange(false);
      toast.success("See you tomorrow! 👋", {
        description: `Logged out successfully. Great work today, ${user.name}.`,
      });
      router.replace("/login");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Could not sign out. Try again.");
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <LogOut className="h-6 w-6" />
            </div>
            <DialogTitle className="text-center text-xl font-bold">
              Ready to wrap up, {user.name?.split(" ")[0] || "there"}?
            </DialogTitle>
            <DialogDescription className="text-center">
              Verify your identity to complete today&apos;s shift and sign out securely.
            </DialogDescription>
          </DialogHeader>

          {/* Time spent & Farewell Banner */}
          <div className="rounded-2xl border border-indigo-200/70 dark:border-indigo-500/20 bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent p-4 text-center shadow-xs">
            <div className="flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              <Clock className="h-4 w-4" />
              Time Spent Today
            </div>
            <div className="mt-1 font-mono text-3xl font-extrabold text-slate-900 dark:text-white">
              {timeSpentToday}
            </div>
            <div className="mt-2.5 flex items-center justify-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              <Sparkles className="h-4 w-4" />
              See you tomorrow! 👋
            </div>
          </div>

          {/* Employee Badge */}
          <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-2.5">
            <Avatar className="h-10 w-10 border border-border">
              {enrolledPhoto ? (
                <img
                  src={enrolledPhoto}
                  alt={user.name}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <AvatarFallback>{user.initials}</AvatarFallback>
              )}
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
            {faceVerified ? (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Face Verified
              </span>
            ) : null}
          </div>

          {/* Verification Method Tabs */}
          {!faceVerified ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-1">
                <button
                  type="button"
                  onClick={() => setVerifyMode("password")}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    verifyMode === "password"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Enter Password
                </button>
                <button
                  type="button"
                  onClick={() => setVerifyMode("face")}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    verifyMode === "face"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Camera className="h-3.5 w-3.5" /> Face Verify
                </button>
              </div>

              {verifyMode === "password" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="logout-pw" className="text-xs">Password</Label>
                  <Input
                    id="logout-pw"
                    type="password"
                    placeholder="Enter your password to confirm"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void performSignOut();
                    }}
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed p-4 text-center">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFaceScannerOpen(true)}
                    className="w-full gap-2 border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100"
                  >
                    <Camera className="h-4 w-4 text-indigo-500" />
                    Open Camera &amp; Verify Face
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {/* Optional Auto Punch-out toggle */}
          {isCheckedIn ? (
            <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={autoPunchOut}
                onChange={(e) => setAutoPunchOut(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Also record today&apos;s attendance check-out automatically
            </label>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isVerifying}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={performSignOut}
              disabled={isVerifying}
              className="bg-indigo-600 text-white hover:bg-indigo-700"
            >
              {isVerifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…
                </>
              ) : (
                "Confirm & Sign Out"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Biometric Face Scanner for Logout */}
      <FaceScannerDialog
        open={faceScannerOpen}
        onOpenChange={setFaceScannerOpen}
        title="Verify Your Face to Sign Out"
        onCapture={() => {
          setFaceVerified(true);
          toast.success("Face verified successfully!");
        }}
      />
    </>
  );
}
