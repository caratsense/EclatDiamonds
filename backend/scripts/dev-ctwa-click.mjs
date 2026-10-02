#!/usr/bin/env node
/**
 * Simulate one Click-to-WhatsApp ad click against the LOCAL backend.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The platform split — "did this lead tap the ad inside Instagram or inside
 * Facebook?" — is decided by one field on the inbound webhook: the referral's
 * `source_url`. On a laptop no webhook ever arrives, and Meta can only deliver
 * to a public URL, so the one thing you most want to see working locally is the
 * one thing a laptop cannot receive.
 *
 * This posts the real Cloud API envelope to the local webhook route, so the
 * whole chain runs for real: signature path, persist, tenant resolution,
 * referral extraction, ad-set lookup, routing, `sourcePlatform`, and the two
 * filters on /conversations. Nothing is stubbed except Meta's delivery.
 *
 * ── It is not a substitute for the live test ────────────────────────────────
 *
 * It proves OUR half. It cannot prove that Meta sends `source_url` on a given
 * placement — only a real click can, which is why the service logs the referral
 * verbatim ("ctwa referral: ad=… url=…") when a real one lands on staging.
 *
 * ── LOCAL ONLY ──────────────────────────────────────────────────────────────
 *
 * Refuses any target that is not on this machine. Phone numbers default to the
 * documentation range (+91 99999 9xxxx) so a stray outbound reaches nobody, and
 * every id it invents is prefixed `DEVCTWA` so it can be told from a real click
 * in the database later.
 *
 *   node scripts/dev-ctwa-click.mjs --platform instagram --from 919999900001
 *   node scripts/dev-ctwa-click.mjs --platform facebook  --from 919999900002
 *
 * Options:
 *   --platform  instagram | facebook | none   (none = referral with no source_url)
 *   --organic   send NO referral at all — an ordinary message, not an ad click.
 *               This is the door the internal DSR bot comes through: a linked
 *               staff number writing in, with nothing from Ads Manager attached.
 *   --from      sender's number, digits only, country code first
 *   --ad        the ad id to attribute to (defaults to a dev id)
 *   --text      the opening message
 *   --phone-id  WHICH business number it arrived on. Defaults to the one in
 *               backend/.env. Pass the internal line's id to exercise the
 *               staff/customer split.
 *   --url       backend base URL (default http://localhost:4000)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = parseArgs(process.argv.slice(2));

const BASE = args.url ?? 'http://localhost:4000';
const PLATFORM = (args.platform ?? 'instagram').toLowerCase();
const FROM = args.from ?? '919999900001';
const AD_ID = args.ad ?? '120210000000001';
const TEXT = args.text ?? 'Saw your ad, do you have this in 22k?';

/*
 * The hostname check is the whole safety story, so it is done on the parsed URL
 * rather than on the string — "http://localhost.evil.com" contains "localhost"
 * and is not this machine.
 */
const host = new URL(BASE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing to post to ${host}. This script only targets the local backend.`);
  process.exit(1);
}

/** No referral at all — the staff/DSR door rather than the ad door. */
const ORGANIC = args.organic === 'true';

/** Where the ad was tapped. `null` is Meta sending no source_url at all. */
const SOURCE_URL = {
  instagram: 'https://www.instagram.com/p/DevCtwaInstagram/',
  facebook: 'https://www.facebook.com/eclatdiamonds/posts/900000000000001',
  none: null,
}[PLATFORM];

if (SOURCE_URL === undefined) {
  console.error(`Unknown --platform "${PLATFORM}". Use instagram, facebook or none.`);
  process.exit(1);
}

const phoneNumberId =
  args['phone-id'] ??
  process.env.WHATSAPP_PHONE_NUMBER_ID ??
  readEnvFile('WHATSAPP_PHONE_NUMBER_ID');
if (!phoneNumberId) {
  console.error(
    'WHATSAPP_PHONE_NUMBER_ID is not set in backend/.env.\n' +
      'The webhook resolves which tenant was messaged from the number it arrived on, ' +
      'so without it the message is parked unattributed — which is the correct ' +
      'behaviour, but not what you are trying to see.',
  );
  process.exit(1);
}

// A wamid is what makes a redelivery idempotent, so each run needs its own.
const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const wamid = `wamid.DEVCTWA${stamp}`;

const referral = {
  source_id: AD_ID,
  source_type: 'ad',
  headline: 'Bridal collection — Éclat Diamonds',
  body: 'Book a private viewing',
  media_type: 'image',
  ctwa_clid: `DEVCTWA.clid.${stamp}`,
};
// Omitted entirely rather than set to null: Meta leaves the key out, and a
// null would exercise a shape the provider never sends.
if (SOURCE_URL) referral.source_url = SOURCE_URL;

const envelope = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'DEVCTWA_WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '919999900000',
              phone_number_id: phoneNumberId,
            },
            contacts: [{ profile: { name: 'Dev Tester' }, wa_id: FROM }],
            messages: [
              {
                from: FROM,
                id: wamid,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: TEXT },
                // An ordinary message carries no referral key at all. Sending an
                // empty object instead would be a shape Meta never produces.
                ...(ORGANIC ? {} : { referral }),
              },
            ],
          },
        },
      ],
    },
  ],
};

const res = await fetch(`${BASE}/integrations/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(envelope),
});

const body = await res.text();
if (!res.ok) {
  console.error(`Webhook refused it: ${res.status} ${body}`);
  // 403 here almost always means WHATSAPP_APP_SECRET is set locally, which
  // turns on signature checking — say so rather than leaving a bare 403.
  if (res.status === 403) {
    console.error(
      '\nA 403 usually means WHATSAPP_APP_SECRET is set in backend/.env. ' +
        'The signature check is skipped only when it is absent. Unset it for local testing.',
    );
  }
  process.exit(1);
}

console.log(
  ORGANIC
    ? `Sent an ordinary (non-ad) message from +${FROM}`
    : `Sent a ${PLATFORM} ad click from +${FROM}`,
);
if (!ORGANIC) {
  console.log(`  ad      ${AD_ID}`);
  console.log(`  source  ${SOURCE_URL ?? '(no source_url — should land as "Ad — source unknown")'}`);
}
console.log(`  to      business number ${phoneNumberId}`);
console.log(`  wamid   ${wamid}`);
console.log(`  webhook ${res.status} ${body.trim() || '(empty)'}`);
console.log(
  '\nThe webhook only ACKNOWLEDGES here; routing runs in the background sweep a moment later.\n' +
    'Watch the backend log for "ctwa referral: …", then open /conversations and use the\n' +
    'source filter. Expect: Instagram ad / Facebook ad / Ad — source unknown.',
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i += 1, next) : 'true';
  }
  return out;
}

/** Read one key out of backend/.env without pulling in a dotenv dependency. */
function readEnvFile(key) {
  try {
    const text = readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (!line) return null;
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}
