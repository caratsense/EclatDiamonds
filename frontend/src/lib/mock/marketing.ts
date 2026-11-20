/**
 * Mock seed data for Module 16 — Marketing Management.
 * Agency collaboration portal + jewelry campaign planner.
 * Replace with API hooks in Phase 2. Amounts in ₹, dates ISO.
 */

export type CampaignStatus =
  | "planning"
  | "in_review"
  | "live"
  | "completed";

export type CampaignType =
  | "bridal"
  | "festive"
  | "catalog"
  | "always_on";

export interface CampaignTypeMeta {
  key: CampaignType;
  label: string;
}

export const CAMPAIGN_TYPES: CampaignTypeMeta[] = [
  { key: "bridal", label: "Bridal Season" },
  { key: "festive", label: "Festive Promo" },
  { key: "catalog", label: "Catalog Distribution" },
  { key: "always_on", label: "Always-On" },
];

export interface Campaign {
  id: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  /** ISO start/end for the planner timeline. */
  start: string;
  end: string;
  budget: number;
  spent: number;
  owner: string;
  agency: string;
  /** Stores the campaign runs across. */
  stores: string[];
  channels: string[];
}

export const CAMPAIGNS: Campaign[] = [
  {
    id: "c-bridal-26",
    name: "Eternal Vows — Bridal '26",
    type: "bridal",
    status: "live",
    start: "2026-05-15",
    end: "2026-08-31",
    budget: 85_00_000,
    spent: 41_20_000,
    owner: "Ananya Iyer",
    agency: "Lotus Creative",
    stores: ["Surat — Main", "Mumbai — Bandra", "Ahmedabad — C.G. Road"],
    channels: ["WhatsApp", "Instagram", "In-store", "OOH"],
  },
  {
    id: "c-akshaya",
    name: "Akshaya Tritiya Gold Rush",
    type: "festive",
    status: "completed",
    start: "2026-04-20",
    end: "2026-05-05",
    budget: 32_00_000,
    spent: 30_75_000,
    owner: "Karan Malhotra",
    agency: "Lotus Creative",
    stores: ["Surat — Main", "Mumbai — Bandra"],
    channels: ["WhatsApp", "SMS", "Radio"],
  },
  {
    id: "c-dhanteras",
    name: "Dhanteras Festive Drop",
    type: "festive",
    status: "planning",
    start: "2026-10-25",
    end: "2026-11-12",
    budget: 60_00_000,
    spent: 0,
    owner: "Karan Malhotra",
    agency: "Pixel & Print",
    stores: ["Surat — Main", "Mumbai — Bandra", "Ahmedabad — C.G. Road"],
    channels: ["WhatsApp", "Instagram", "OOH", "Newspaper"],
  },
  {
    id: "c-catalog-aw",
    name: "Autumn/Winter Catalog Drop",
    type: "catalog",
    status: "in_review",
    start: "2026-07-01",
    end: "2026-07-20",
    budget: 18_00_000,
    spent: 6_40_000,
    owner: "Ananya Iyer",
    agency: "Pixel & Print",
    stores: ["Mumbai — Bandra", "Ahmedabad — C.G. Road"],
    channels: ["WhatsApp", "Email", "In-store"],
  },
  {
    id: "c-always",
    name: "Gold Scheme Always-On",
    type: "always_on",
    status: "live",
    start: "2026-01-01",
    end: "2026-12-31",
    budget: 24_00_000,
    spent: 11_90_000,
    owner: "Ananya Iyer",
    agency: "In-house",
    stores: ["Surat — Main", "Mumbai — Bandra", "Ahmedabad — C.G. Road"],
    channels: ["WhatsApp", "SMS"],
  },
];

export type AgencyTaskStatus =
  | "awaiting_brief"
  | "in_progress"
  | "submitted"
  | "approved"
  | "changes_requested";

export interface AgencyTask {
  id: string;
  title: string;
  agency: string;
  campaignId: string;
  assignee: string;
  dueDate: string;
  status: AgencyTaskStatus;
  /** Number of shared assets attached. */
  assetCount: number;
}

export const AGENCY_TASKS: AgencyTask[] = [
  {
    id: "at-1",
    title: "Bridal hero film — 30s cut",
    agency: "Lotus Creative",
    campaignId: "c-bridal-26",
    assignee: "Devika (Lotus)",
    dueDate: "2026-06-22",
    status: "changes_requested",
    assetCount: 4,
  },
  {
    id: "at-2",
    title: "Instagram carousel set — necklace edit",
    agency: "Lotus Creative",
    campaignId: "c-bridal-26",
    assignee: "Devika (Lotus)",
    dueDate: "2026-06-19",
    status: "submitted",
    assetCount: 9,
  },
  {
    id: "at-3",
    title: "A/W catalog layout & print proofs",
    agency: "Pixel & Print",
    campaignId: "c-catalog-aw",
    assignee: "Rohan (Pixel)",
    dueDate: "2026-06-28",
    status: "in_progress",
    assetCount: 2,
  },
  {
    id: "at-4",
    title: "Dhanteras OOH key-visual concepts",
    agency: "Pixel & Print",
    campaignId: "c-dhanteras",
    assignee: "Rohan (Pixel)",
    dueDate: "2026-07-15",
    status: "awaiting_brief",
    assetCount: 0,
  },
  {
    id: "at-5",
    title: "WhatsApp broadcast creative pack",
    agency: "Lotus Creative",
    campaignId: "c-bridal-26",
    assignee: "Sahil (Lotus)",
    dueDate: "2026-06-16",
    status: "approved",
    assetCount: 6,
  },
];

export interface SharedAsset {
  id: string;
  name: string;
  kind: "video" | "image" | "pdf" | "copy";
  campaignId: string;
  agency: string;
  updatedAt: string;
  approved: boolean;
}

export const SHARED_ASSETS: SharedAsset[] = [
  { id: "as-1", name: "bridal_hero_v3.mp4", kind: "video", campaignId: "c-bridal-26", agency: "Lotus Creative", updatedAt: "2026-06-15", approved: false },
  { id: "as-2", name: "necklace_carousel_01-09.zip", kind: "image", campaignId: "c-bridal-26", agency: "Lotus Creative", updatedAt: "2026-06-14", approved: false },
  { id: "as-3", name: "whatsapp_pack_final.zip", kind: "image", campaignId: "c-bridal-26", agency: "Lotus Creative", updatedAt: "2026-06-12", approved: true },
  { id: "as-4", name: "aw_catalog_proof.pdf", kind: "pdf", campaignId: "c-catalog-aw", agency: "Pixel & Print", updatedAt: "2026-06-13", approved: false },
  { id: "as-5", name: "dhanteras_keyline_copy.docx", kind: "copy", campaignId: "c-dhanteras", agency: "Pixel & Print", updatedAt: "2026-06-10", approved: false },
];
