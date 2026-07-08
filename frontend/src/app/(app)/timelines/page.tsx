"use client";

import { SectionHeader } from "@/components/section/section-header";
import { OrdersTimelineView } from "@/components/timelines/orders-timeline-view";

export default function TimelinesPage() {
  return (
    <>
      <SectionHeader
        title="Timelines & Status"
        purpose="Order booking and the real-time production engine for custom and stock orders. Now part of Quotation & Orders — reachable here too."
      />
      <OrdersTimelineView />
    </>
  );
}
