import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";

import { API_TIMEOUT_MS } from "@/lib/api";

import { threadLoadFailure } from "./thread-load-failure";

/**
 * The thread pane has to say which kind of failure it was.
 *
 * 28 Nov: a screenshot of the inbox with the list showing a thread and the pane
 * beside it reading "Could not open thread." Six words that covered a timeout,
 * a dead connection, a gateway giving up and a genuine refusal — so the first
 * place anybody looked was the one place it could not have been, the query that
 * decides which threads a person may read.
 *
 * Each case below is a failure that used to read identically to the others.
 */

/** An axios error shaped the way axios shapes them, with or without a reply. */
function axiosError(
  options: { code?: string; status?: number; body?: unknown } = {},
): AxiosError {
  const error = new AxiosError(
    "boom",
    options.code,
    { headers: new AxiosHeaders() },
    undefined,
    options.status === undefined
      ? undefined
      : {
          status: options.status,
          statusText: "",
          data: options.body,
          headers: {},
          config: { headers: new AxiosHeaders() },
        },
  );
  return error;
}

describe("why the thread pane is empty", () => {
  it("names the wait when the request timed out, and the number comes from the client", () => {
    // Hardcoding "15 seconds" here would let the two drift the first time
    // somebody tuned the timeout, and the sentence would then be a lie.
    const seconds = Math.round(API_TIMEOUT_MS / 1000);

    expect(threadLoadFailure(axiosError({ code: "ECONNABORTED" }))).toBe(
      `The server did not answer within ${seconds} seconds. The thread is still there — press Retry.`,
    );
    expect(threadLoadFailure(axiosError({ code: "ETIMEDOUT" }))).toContain(`${seconds} seconds`);
  });

  it("says the server was unreachable when the connection never produced a reply", () => {
    // A shop's wifi dropping is not the same event as a slow query, and the
    // person reading this is the one who can do something about the first.
    expect(threadLoadFailure(axiosError({ code: "ERR_NETWORK" }))).toBe(
      "Could not reach the server. Check the connection and press Retry.",
    );
  });

  it("blames the hop, not the thread, on a gateway status", () => {
    /*
     * The browser calls this app's own origin and Next rewrites /_api to the
     * Railway backend. A 502/503/504 is that hop, and its body is HTML — which
     * is the other reason these used to arrive as the bare fallback.
     */
    for (const status of [502, 503, 504]) {
      expect(threadLoadFailure(axiosError({ status }))).toBe(
        `The server did not answer in time (${status}). The thread is still there — press Retry.`,
      );
    }
  });

  it("prefers the server's own refusal over anything written here", () => {
    // A thread outside the caller's scope is a 404 that explains itself, and a
    // paraphrase would only make it vaguer.
    expect(
      threadLoadFailure(axiosError({ status: 404, body: { message: "Conversation not found" } })),
    ).toBe("Conversation not found");
    expect(
      threadLoadFailure(axiosError({ status: 403, body: { message: "Store not in your scope" } })),
    ).toBe("Store not in your scope");
    expect(
      threadLoadFailure(axiosError({ status: 500, body: { message: "Internal server error" } })),
    ).toBe("Internal server error");
  });

  it("falls back for a 4xx that carried no message, and for nothing at all", () => {
    expect(threadLoadFailure(axiosError({ status: 400 }))).toBe("Could not open thread.");
    expect(threadLoadFailure(undefined)).toBe("Could not open thread.");
    expect(threadLoadFailure(new Error("not from axios"))).toBe("Could not open thread.");
  });
});
