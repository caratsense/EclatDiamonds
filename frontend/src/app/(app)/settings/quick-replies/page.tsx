import { QuickRepliesScreen } from "@/components/settings/quick-replies-screen";

/**
 * Settings › Quick replies.
 *
 * The route is a wrapper and nothing else: the screen lives under
 * `components/settings/` so it can be rendered from here and tested without a
 * router, following Export Formats.
 */
export default function QuickRepliesPage() {
  return <QuickRepliesScreen />;
}
