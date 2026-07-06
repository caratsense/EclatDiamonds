import type { Store, User } from "@/lib/types";

/** Synthetic aggregate option for multi-store roles. */
export const ALL_STORES: Store = {
  id: "all",
  name: "All Stores",
  city: "Pan-India",
  isAggregate: true,
};

export const MOCK_STORES: Store[] = [
  { id: "surat-main", name: "Surat — Main", city: "Surat" },
  { id: "mumbai-bandra", name: "Mumbai — Bandra", city: "Mumbai" },
  { id: "ahmedabad-cg", name: "Ahmedabad — C.G. Road", city: "Ahmedabad" },
  ALL_STORES,
];

export const MOCK_USER: User = {
  id: "u-001",
  name: "Aarav Mehta",
  email: "aarav.mehta@caratsense.in",
  initials: "AM",
};
