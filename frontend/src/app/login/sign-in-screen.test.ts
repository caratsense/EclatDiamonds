import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import LoginRoute from "./page";

/**
 * The sign-in screen is only a sign-in screen: a manager makes staff logins,
 * so nothing on it leads to sign-up. Sign-up still opens from a direct link,
 * /login?start=join or /login?start=create, and whoever came by one gets a
 * way back.
 *
 * The screen is rendered once on the server for each address and read as the
 * text a person sees. What "Back to sign in" does when clicked needs a browser.
 */

const address = vi.hoisted(() => ({ start: null as string | null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => ({
    get: (name: string) => (name === "start" ? address.start : null),
  }),
}));

/** The words on /login, or on /login?start=<start>. */
function screen(start: string | null = null): string {
  address.start = start;
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LoginRoute),
    ),
  );
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("the sign-in screen", () => {
  it("asks for a Login ID or mobile number and a password", () => {
    const text = screen();
    expect(text).toContain("Sign in to your workspace");
    expect(text).toContain("Login ID or mobile number");
    expect(text).toContain("Sign In");
  });

  it("has no way into sign-up, and says nothing about making an account", () => {
    const text = screen();
    expect(text).not.toMatch(/new staff|set up|sign.?up|create|join|register/i);
    // Nothing to go back from either.
    expect(text).not.toContain("Back to sign in");
  });
});

describe("sign-up, by its direct link only", () => {
  it("opens on joining a team from ?start=join, with a way back", () => {
    const text = screen("join");
    expect(text).toContain("Join your organisation");
    expect(text).toContain("Create account");
    expect(text).toContain("Back to sign in");
    expect(text).not.toContain("Sign in to your workspace");
  });

  it("opens on a new organisation from ?start=create, with a way back", () => {
    const text = screen("create");
    expect(text).toContain("Set up your organisation");
    expect(text).toContain("Create organisation");
    expect(text).toContain("Back to sign in");
    expect(text).not.toContain("Sign in to your workspace");
  });

  it("is not opened by any other address", () => {
    expect(screen("signup")).toContain("Sign in to your workspace");
    expect(screen("signup")).not.toContain("Back to sign in");
  });
});
