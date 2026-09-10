/**
 * Where `/tasks` sends people.
 *
 * A constant rather than a literal inside the page, so the test below can assert
 * the destination without rendering a server component that calls `redirect()`
 * (which throws by design, and asserting on a thrown control-flow signal proves
 * less than asserting on the value that produced it).
 *
 * It must stay a route that exists AND is in the navigation, or the alias sends
 * people to a 404 or to a screen their sidebar cannot get back to.
 */
export const TASKS_CANONICAL_PATH = "/calling";
