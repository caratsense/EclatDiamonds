"use client";

import { useRouter } from "next/navigation";

import { QuoteBuilder } from "@/components/quotation/quote-builder";

/** A new quote, on a screen of its own. */
export default function NewQuotePage() {
  const router = useRouter();
  return <QuoteBuilder onDone={() => router.push("/quotation")} />;
}
