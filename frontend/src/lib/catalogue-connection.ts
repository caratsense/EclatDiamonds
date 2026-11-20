/**
 * How the website connection reads on the integration board. "Connected" is
 * shown only when the backend says the last read-only probe of the saved
 * address passed — never because an address is merely stored.
 */
export type ConnectionState = "not_configured" | "connected" | "sync_running" | "needs_attention" | "failed";

export interface ConnectionView {
  label: string;
  tone: "success" | "warning" | "destructive" | "secondary" | "gold";
  /** What to do next, in one sentence. */
  help: string;
}

export function connectionView(state: ConnectionState | null | undefined, checking = false): ConnectionView {
  if (checking) return { label: "Checking…", tone: "secondary", help: "Reading one product from the website to prove the address works." };
  switch (state) {
    case "connected":
      return { label: "Connected", tone: "success", help: "The last check read a product from the website." };
    case "sync_running":
      return { label: "Sync running", tone: "gold", help: "A sync is reading the website now; the numbers below move as it goes." };
    case "needs_attention":
      return {
        label: "Needs attention",
        tone: "warning",
        help: "The last sync did not finish, or the address has not been checked. Test the connection, then resume or run a full sync.",
      };
    case "failed":
      return { label: "Failed", tone: "destructive", help: "The last check could not read the website. Fix the address, or wait and test again." };
    default:
      return { label: "Not configured", tone: "secondary", help: "No website address is saved. Save and test one to connect." };
  }
}
