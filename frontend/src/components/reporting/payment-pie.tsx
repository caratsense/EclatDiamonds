"use client";

import { DonutChart } from "@/components/chart/echart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINRCompact } from "@/lib/format";
import type { PaymentSource } from "@/lib/mock/reporting";

/** Payment-source breakdown (Cash / Card / UPI / Net Banking). */
export function PaymentPie({ data }: { data: PaymentSource[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Sources</CardTitle>
        <CardDescription>How today&apos;s collections were tendered</CardDescription>
      </CardHeader>
      <CardContent>
        <DonutChart
          data={data.map((d) => ({ name: d.source, value: d.amount }))}
          valueFormatter={formatINRCompact}
          height={260}
        />
      </CardContent>
    </Card>
  );
}
