import { redirect } from "next/navigation";

/**
 * AI image search now lives in ONE place — the Catalogue's "AI image search"
 * card (same DINOv2 + SigLIP engine, same TOP-10 result set). This standalone
 * page is retired; any old link/bookmark lands on the Catalogue.
 */
export default function FindSimilarRedirect() {
  redirect("/catalogue");
}
