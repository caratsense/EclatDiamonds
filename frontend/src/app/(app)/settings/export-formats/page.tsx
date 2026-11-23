import { ExportFormatsScreen } from "@/components/settings/export-formats-screen";

/**
 * Settings › Export formats.
 *
 * The route is a wrapper and nothing else: the screen itself lives under
 * `components/settings/` so it can be rendered from here and tested without a
 * router, which is how the other settings screens with real state are built.
 */
export default function ExportFormatsPage() {
  return <ExportFormatsScreen />;
}
