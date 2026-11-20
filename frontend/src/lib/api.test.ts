import { describe, expect, it } from "vitest";

import { api } from "./api";

/**
 * A file upload must not go out as application/json.
 *
 * The instance defaults every request to `application/json`, which is correct
 * for the hundred that send objects and silently fatal for the twelve that
 * send files: the default overrides the `multipart/form-data` axios would
 * generate, no boundary is written, and the server's multer parses no file.
 * The call then fails with "choose a file" and nothing in between explains it.
 *
 * It cost a production debugging session on the template-image upload, after
 * having already cost one on imports — which is why the fix lives in the
 * interceptor rather than in each caller, and why this test exists.
 */

/** Run the request interceptors the way axios does, and return the config. */
async function runInterceptors(config: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into axios internals on purpose
  const handlers = (api.interceptors.request as any).handlers as {
    fulfilled?: (c: unknown) => unknown;
  }[];
  let next: unknown = { headers: { "Content-Type": "application/json" }, ...config };
  for (const h of handlers) if (h?.fulfilled) next = await h.fulfilled(next);
  return next as { headers: Record<string, unknown> };
}

describe("the api client", () => {
  it("drops the JSON content type when the body is FormData", async () => {
    const form = new FormData();
    form.append("file", new Blob(["x"]), "photo.jpg");

    const config = await runInterceptors({ data: form });

    // Absent, not "multipart/form-data": the browser has to write the header
    // itself so it can include the boundary, which is the part that matters.
    expect(config.headers["Content-Type"]).toBeUndefined();
  });

  it("leaves an ordinary JSON body alone", async () => {
    const config = await runInterceptors({ data: { name: "Priya" } });
    expect(config.headers["Content-Type"]).toBe("application/json");
  });

  it("leaves a request with no body alone", async () => {
    const config = await runInterceptors({});
    expect(config.headers["Content-Type"]).toBe("application/json");
  });
});
