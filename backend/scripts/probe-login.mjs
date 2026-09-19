/**
 * Drive the real login page in a real browser and report why Sign In fails.
 *
 * curl proves the API answers; it does not prove the page can reach it. The
 * axios base URL is inlined at build time, so a wrong value produces a request
 * to the wrong origin that only a browser will make. This watches the console,
 * page errors, and every request the click actually fires.
 *
 *   node scripts/probe-login.mjs <url> [email] [password]
 */
import { chromium } from "playwright";

const URL = process.argv[2];
const EMAIL = process.argv[3] ?? "head.office@caratsense.in";
const PASS = process.argv[4] ?? "password123";
if (!URL) throw new Error("usage: probe-login.mjs <url>");

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];
const requests = [];
const failures = [];

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("request", (r) => {
  if (/auth|login|_api/i.test(r.url())) requests.push(`${r.method()} ${r.url()}`);
});
page.on("requestfailed", (r) => failures.push(`${r.url()}  -> ${r.failure()?.errorText}`));
page.on("response", async (r) => {
  if (/auth|login|_api/i.test(r.url()) && r.status() >= 400) {
    let body = "";
    try { body = (await r.text()).slice(0, 200); } catch {}
    failures.push(`${r.status()} ${r.url()}  ${body}`);
  }
});

console.log(`opening ${URL}/login`);
await page.goto(`${URL}/login`, { waitUntil: "networkidle", timeout: 60000 });

// The Login ID / password form; the face tab is a sibling.
// Match the inputs themselves: "Password" also matches the show/hide button.
await page.getByRole("textbox", { name: /login id/i }).fill(EMAIL);
await page.locator("input#password").fill(PASS);

requests.length = 0; // only care about what the click causes
console.log("clicking Sign In ...");
await page.getByRole("button", { name: /^sign in$/i }).click();
await page.waitForTimeout(6000);

console.log(`\nURL after click : ${page.url()}`);
const toast = await page.locator("[data-sonner-toast], [role=status], .toast").allInnerTexts().catch(() => []);
if (toast.length) console.log(`toast           : ${toast.join(" | ").slice(0, 300)}`);

console.log("\n-- requests fired by the click --");
for (const r of requests.slice(0, 12)) console.log("  " + r);
if (!requests.length) console.log("  (none — the click did nothing)");

console.log("\n-- failed / 4xx-5xx --");
for (const f of failures.slice(0, 12)) console.log("  " + f);
if (!failures.length) console.log("  (none)");

console.log("\n-- console errors --");
for (const e of consoleErrors.slice(0, 10)) console.log("  " + e.slice(0, 300));
if (!consoleErrors.length) console.log("  (none)");

console.log("\n-- uncaught page errors --");
for (const e of pageErrors.slice(0, 10)) console.log("  " + e.slice(0, 300));
if (!pageErrors.length) console.log("  (none)");

await browser.close();
