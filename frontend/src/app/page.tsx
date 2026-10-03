import { redirect } from "next/navigation";

/**
 * The link opens on the sign-in screen. There was a product landing page here;
 * the shop asked for it to go — the people who open this link already work
 * here and only want to sign in.
 */
export default function Home() {
  redirect("/login");
}
