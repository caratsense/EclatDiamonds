"use client";

import { SectionHeader } from "@/components/section/section-header";
import { OrdersTimelineView } from "@/components/timelines/orders-timeline-view";

export default function TimelinesPage() {
  return (
    <>
      <SectionHeader
        title="Timelines & Status"
        purpose="Track custom and stock orders through production. Also available within Quotation & Orders."
      />
      <OrdersTimelineView />
    </>
  );
}
