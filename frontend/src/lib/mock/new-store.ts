/**
 * Mock seed data for Module 11 — Departmental Setup for New Stores.
 * Realistic Indian multi-store jewelry launch project. Replace with API
 * hooks in Phase 2. All amounts in ₹, dates ISO (yyyy-MM-dd).
 */

export type DepartmentKey =
  | "it"
  | "inventory"
  | "interiors"
  | "hr"
  | "marketing";

export interface DepartmentMeta {
  key: DepartmentKey;
  label: string;
  /** Short owning-team caption. */
  owner: string;
}

export const DEPARTMENTS: DepartmentMeta[] = [
  { key: "it", label: "IT & Network", owner: "Infra Team" },
  { key: "inventory", label: "Inventory & Production", owner: "Merchandising" },
  { key: "interiors", label: "Interiors & Fit-out", owner: "Projects" },
  { key: "hr", label: "HR & Hiring", owner: "People Ops" },
  { key: "marketing", label: "Marketing & Launch", owner: "Brand Team" },
];

export type ChecklistStatus = "done" | "in_progress" | "blocked" | "todo";

export interface ChecklistTask {
  id: string;
  label: string;
  status: ChecklistStatus;
  /** Optional task this depends on (id), for dependency chains. */
  dependsOn?: string;
}

export interface DepartmentChecklist {
  key: DepartmentKey;
  tasks: ChecklistTask[];
}

export type MilestoneMarker = "T-90" | "T-60" | "T-30" | "Launch";
export type MilestoneState = "complete" | "current" | "upcoming" | "at_risk";

export interface Milestone {
  marker: MilestoneMarker;
  /** Target date for the milestone. */
  date: string;
  title: string;
  summary: string;
  state: MilestoneState;
}

export type VendorStatus =
  | "on_track"
  | "at_risk"
  | "delayed"
  | "completed";

export interface VendorAssignment {
  id: string;
  task: string;
  department: DepartmentKey;
  vendor: string;
  contact: string;
  dueDate: string;
  amount: number;
  status: VendorStatus;
}

export interface NewStoreProject {
  id: string;
  name: string;
  city: string;
  launchDate: string;
  /** Overall completion 0-100, derived for the demo. */
  overallProgress: number;
  budget: number;
  spent: number;
  leadName: string;
  checklists: DepartmentChecklist[];
  milestones: Milestone[];
  vendors: VendorAssignment[];
}

export const NEW_STORE_PROJECT: NewStoreProject = {
  id: "ns-pune-kp",
  name: "Pune — Koregaon Park",
  city: "Pune",
  launchDate: "2026-09-15",
  overallProgress: 58,
  budget: 4_20_00_000,
  spent: 2_18_50_000,
  leadName: "Rhea Kulkarni",
  checklists: [
    {
      key: "it",
      tasks: [
        { id: "it-1", label: "Lease line + 4G failover provisioned", status: "done" },
        { id: "it-2", label: "POS terminals & billing rack installed", status: "in_progress", dependsOn: "it-1" },
        { id: "it-3", label: "CCTV & burglar alarm wiring", status: "in_progress" },
        { id: "it-4", label: "Legacy attendance device connected", status: "todo", dependsOn: "it-2" },
        { id: "it-5", label: "CaratOS terminal onboarding", status: "blocked", dependsOn: "it-2" },
      ],
    },
    {
      key: "inventory",
      tasks: [
        { id: "inv-1", label: "Opening stock plan (22K/18K mix) approved", status: "done" },
        { id: "inv-2", label: "Bridal collection transfer from Mumbai HO", status: "in_progress", dependsOn: "inv-1" },
        { id: "inv-3", label: "Hallmarking & BIS tagging of intake", status: "todo", dependsOn: "inv-2" },
        { id: "inv-4", label: "Showcase merchandising plan", status: "todo" },
      ],
    },
    {
      key: "interiors",
      tasks: [
        { id: "int-1", label: "Civil work & false ceiling", status: "done" },
        { id: "int-2", label: "Display showcases & vault installation", status: "in_progress", dependsOn: "int-1" },
        { id: "int-3", label: "Lighting & gold-tone branding", status: "in_progress" },
        { id: "int-4", label: "Signage & facade", status: "todo", dependsOn: "int-3" },
        { id: "int-5", label: "Fire & safety clearance", status: "todo" },
      ],
    },
    {
      key: "hr",
      tasks: [
        { id: "hr-1", label: "Store manager hired & onboarded", status: "done" },
        { id: "hr-2", label: "6 sales associates recruited", status: "in_progress" },
        { id: "hr-3", label: "Product & POS training batch", status: "todo", dependsOn: "hr-2" },
        { id: "hr-4", label: "Security & housekeeping staffing", status: "todo" },
      ],
    },
    {
      key: "marketing",
      tasks: [
        { id: "mkt-1", label: "Launch creative & invites approved", status: "done" },
        { id: "mkt-2", label: "Local press & influencer outreach", status: "in_progress" },
        { id: "mkt-3", label: "Pre-launch gold-scheme campaign", status: "in_progress" },
        { id: "mkt-4", label: "Inauguration event logistics", status: "todo", dependsOn: "mkt-1" },
      ],
    },
  ],
  milestones: [
    {
      marker: "T-90",
      date: "2026-06-17",
      title: "Foundation locked",
      summary: "Lease, civil work, and opening-stock plan signed off.",
      state: "complete",
    },
    {
      marker: "T-60",
      date: "2026-07-17",
      title: "Build-out & hiring",
      summary: "Fit-out, IT install, and 80% staffing in progress.",
      state: "current",
    },
    {
      marker: "T-30",
      date: "2026-08-16",
      title: "Stock & dry-run",
      summary: "Hallmarked inventory in vault, POS dry-run, staff trained.",
      state: "at_risk",
    },
    {
      marker: "Launch",
      date: "2026-09-15",
      title: "Inauguration",
      summary: "Muhurat opening with festive campaign live.",
      state: "upcoming",
    },
  ],
  vendors: [
    {
      id: "v-1",
      task: "Display showcases & strong-room vault",
      department: "interiors",
      vendor: "Shreeji Fixtures Pvt Ltd",
      contact: "Nikhil Shah",
      dueDate: "2026-07-10",
      amount: 38_50_000,
      status: "on_track",
    },
    {
      id: "v-2",
      task: "POS terminals & network rack",
      department: "it",
      vendor: "NetSecure Solutions",
      contact: "Arjun Rao",
      dueDate: "2026-07-05",
      amount: 12_20_000,
      status: "at_risk",
    },
    {
      id: "v-3",
      task: "Facade signage & gold-tone branding",
      department: "interiors",
      vendor: "Pixel Signage Co.",
      contact: "Meera Joshi",
      dueDate: "2026-08-01",
      amount: 8_75_000,
      status: "delayed",
    },
    {
      id: "v-4",
      task: "Inauguration event & catering",
      department: "marketing",
      vendor: "Celebrations Unlimited",
      contact: "Sanjay Patil",
      dueDate: "2026-09-10",
      amount: 15_00_000,
      status: "on_track",
    },
    {
      id: "v-5",
      task: "Hallmarking & BIS tagging drive",
      department: "inventory",
      vendor: "Assured Assay Centre",
      contact: "Vivek Nair",
      dueDate: "2026-08-12",
      amount: 4_30_000,
      status: "on_track",
    },
    {
      id: "v-6",
      task: "Staff product & POS training",
      department: "hr",
      vendor: "RetailEdge Academy",
      contact: "Priya Deshmukh",
      dueDate: "2026-08-20",
      amount: 3_60_000,
      status: "completed",
    },
  ],
};

/** Progress (0-100) for a department from its checklist. */
export function departmentProgress(list: DepartmentChecklist): number {
  if (list.tasks.length === 0) return 0;
  const score = list.tasks.reduce((acc, t) => {
    if (t.status === "done") return acc + 1;
    if (t.status === "in_progress") return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((score / list.tasks.length) * 100);
}
