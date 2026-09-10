import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * The calling / follow-up workspace.
 *
 * The summary is fetched SEPARATELY from the queue on purpose. They are two
 * endpoints because they answer two different questions: how much work exists,
 * and which page of it am I looking at. Deriving the first from the second is
 * the bug this whole screen is built to avoid.
 */

export type CallingBucket = "overdue" | "today" | "upcoming" | "completed";

export interface CallingSummary {
  overdue: number;
  dueToday: number;
  upcoming: number;
  completed: number;
  completedWithinDays: number;
  dayStart: string;
  dayEnd: string;
}

export interface QueueTask {
  id: string;
  title: string;
  detail: string | null;
  priority: string;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  storeId: string | null;
  assignee: { id: string | null; name: string } | null;
  customer: {
    id: string;
    name: string;
    customerId: string | null;
    contact: string | null;
  } | null;
  lead: {
    id: string;
    ref: string | null;
    stage: string;
    source: string;
    interest: string | null;
  } | null;
  overdueMinutes: number | null;
}

export interface CallRow {
  id: string;
  direction: string;
  provider: string;
  disposition: string | null;
  notes: string | null;
  startedAt: string;
  durationSec: number | null;
  from: string | null;
  to: string | null;
  recording: { url: string; expiresAt: string | null } | null;
  recordingState: "none" | "expired" | "available";
  transcript: string | null;
  transcriptSource: string | null;
  summary: string | null;
  summarySource: string | null;
}

export interface CallingWorkspace {
  task: {
    id: string;
    title: string;
    detail: string | null;
    priority: string;
    status: string;
    dueDate: string | null;
    completedAt: string | null;
    storeId: string | null;
    assignee: string | null;
    assigneeId: string | null;
  };
  customer: {
    id: string;
    name: string;
    customerId: string | null;
    contact: string | null;
    city: string | null;
    customerSince: string;
    blocked: boolean;
    totalOrders: number;
    /** null when there is no order history at all — never a fabricated zero. */
    totalSpend: string | null;
    totalVisits: number;
    lastVisitAt: string | null;
    lastVisitStore: { id: string; name: string } | null;
    lastAttendedBy: { id: string; name: string } | null;
  } | null;
  lead: {
    id: string;
    ref: string | null;
    stage: string;
    source: string;
    interest: string | null;
    value: string | null;
    createdAt: string;
    store: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
  } | null;
  notes: { id: string; body: string; createdAt: string }[];
  activity: {
    id: string;
    type: string;
    summary: string;
    channel: string | null;
    occurredAt: string;
  }[];
  calls: CallRow[];
}

/**
 * Dispositions every business shares. A tenant can send any string, so this is
 * a starting list rather than a closed set — "prescription collected" means
 * nothing to a jeweller and "ring resized" means nothing to a clinic.
 */
export const CALL_DISPOSITIONS = [
  { value: "connected", label: "Spoke to them" },
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy" },
  { value: "callback", label: "Asked to call back" },
  { value: "not_interested", label: "Not interested" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "do_not_contact", label: "Asked not to be contacted" },
];

export function useCallingSummary(params: { mine?: boolean; storeId?: string } = {}) {
  return useQuery({
    queryKey: ["calling", "summary", params],
    queryFn: async () => {
      const { data } = await api.get<CallingSummary>("/calling/summary", { params });
      return data;
    },
  });
}

export function useCallingQueue(params: {
  bucket?: CallingBucket;
  mine?: boolean;
  storeId?: string;
  priority?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ["calling", "queue", params],
    queryFn: async () => {
      const { data } = await api.get<{ items: QueueTask[]; nextCursor: string | null }>(
        "/calling/queue",
        { params: { ...params, limit: 50 } },
      );
      return data;
    },
  });
}

export function useCallingWorkspace(taskId: string | undefined) {
  return useQuery({
    queryKey: ["calling", "task", taskId],
    enabled: Boolean(taskId),
    queryFn: async () => {
      const { data } = await api.get<CallingWorkspace>(`/calling/tasks/${taskId}`);
      return data;
    },
  });
}

export function useLogCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      taskId,
      ...body
    }: {
      taskId: string;
      disposition: string;
      direction?: string;
      notes?: string;
      durationSec?: number;
      then?: "complete" | "reschedule" | "leave";
      rescheduleTo?: string;
    }) => {
      const { data } = await api.post<{
        callId: string;
        taskStatus: string;
        rescheduledTo: string | null;
      }>(`/calling/tasks/${taskId}/calls`, body);
      return data;
    },
    onSuccess: () => {
      // Both, because logging a call changes the queue AND every KPI above it.
      void qc.invalidateQueries({ queryKey: ["calling"] });
    },
  });
}
