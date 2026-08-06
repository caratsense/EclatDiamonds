"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { DonutChart } from "@/components/chart/echart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINRCompact } from "@/lib/format";
import type { PaymentSource } from "@/lib/mock/reporting";

/** Payment-source breakdown (Cash / Card / UPI / Net Banking). Taps through to Payments. */
export function PaymentPie({ data, href = "/payments" }: { data: PaymentSource[]; href?: string }) {
  return (
    <Link href={href} className="block">
      <Card className="group transition-shadow hover:shadow-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Payment Sources
            <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </CardTitle>
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
    </Link>
  );
}
