"use client";

import QuotationPage from "../page";

/**
 * The New-quote form became a dialog over the quote list (client mockup,
 * 13 Oct), but this deep link predates that and is bookmarked / linked from
 * chats — so it renders the list, which reads this path and opens the dialog
 * at once instead of 404ing. Closing it rewrites the URL back to /quotation.
 */
export default function NewQuotePage() {
  return <QuotationPage />;
}
