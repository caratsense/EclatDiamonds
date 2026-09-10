import { redirect } from "next/navigation";

import { TASKS_CANONICAL_PATH } from "./canonical";

/**
 * `/tasks` — an alias that sends you to the real screen.
 *
 * ## Why it exists
 *
 * The floor app's bottom bar used to link here while the screen lived at
 * `/calling`, so the Tasks tab 404'd. That tab is now a native mobile queue
 * inside `/instore` and no longer links out at all — but the path has been
 * handed around, and "Tasks" is what people call the thing, so it stays
 * reachable.
 *
 * ## Why a redirect and not a re-export
 *
 * It used to be `export { default } from "../calling/page"`, which is a second
 * route rendering the same screen. Two URLs for one page means the sidebar
 * highlights neither, a back button lands on whichever one you arrived through,
 * and any future per-route work — a title, an entitlement prefix, a saved filter
 * — has to be remembered in two places. There is one screen, so there is one
 * URL, and this points at it.
 */
export default function TasksAliasPage() {
  redirect(TASKS_CANONICAL_PATH);
}
