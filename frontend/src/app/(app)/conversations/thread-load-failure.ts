import { AxiosError } from "axios";

import { API_TIMEOUT_MS } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Why the thread pane is empty, said so that the next screenshot is diagnosable.
 *
 * ## The incident this exists for
 *
 * On 28 Nov the client sent a screenshot of the inbox: the list had rendered a
 * thread, and the pane beside it read "Could not open thread." with a Retry.
 * That sentence is the FALLBACK — `apiErrorMessage` returns it only when the
 * failure carried no server message at all. So the screenshot already ruled out
 * every refusal the backend can make: a thread outside the caller's scope comes
 * back "Conversation not found", a branch outside it "Store not in your scope",
 * an unhandled fault "Internal server error". None of those is what she saw.
 *
 * What she saw was a request that never completed — a timeout, a dropped
 * connection, or a gateway that gave up on the Railway hop. Three different
 * problems, and the screen said the same six words for all of them, which is
 * why a day went into checking whether the list and the detail query disagreed
 * about which threads exist. (They do not; `conversations-thread-access.spec.ts`
 * now pins that.)
 *
 * So this says WHICH. Nothing here is a diagnosis of the network — only an
 * honest report of how far the request got, which is the part the browser
 * actually knows. The server's own words are still preferred wherever there are
 * any: a refusal explains itself better than we can paraphrase it.
 */
export function threadLoadFailure(error: unknown): string {
  if (error instanceof AxiosError) {
    /*
     * No response at all. `ECONNABORTED` is what axios reports when its own
     * timeout fires; anything else here is the connection failing before a
     * reply — offline, DNS, a dropped shop wifi.
     */
    if (!error.response) {
      const seconds = Math.round(API_TIMEOUT_MS / 1000);
      return error.code === "ECONNABORTED" || error.code === "ETIMEDOUT"
        ? `The server did not answer within ${seconds} seconds. The thread is still there — press Retry.`
        : "Could not reach the server. Check the connection and press Retry.";
    }

    /*
     * A gateway status, not the API's. The browser talks to the frontend's own
     * origin and Next rewrites `/_api` to the backend (next.config.ts), so a
     * 502/503/504 is that hop failing or timing out — never a decision anything
     * in this product made about this thread. Their bodies are HTML, which is
     * the other reason these arrived as the bare fallback.
     */
    const status = error.response.status;
    if (status === 502 || status === 503 || status === 504) {
      return `The server did not answer in time (${status}). The thread is still there — press Retry.`;
    }
  }

  return apiErrorMessage(error, "Could not open thread.");
}
