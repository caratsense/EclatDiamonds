# Meta App Review — Éclat Diamonds CRM

> App `1074605415310032`, owned by Éclat's portfolio `920334109418825`.
> Written 30 September 2026. Every "current state" line below was read from the
> Graph API, not assumed.

## It cannot be automated

There is no Graph endpoint for this. Verified against the live app:

```
/app_review_submissions  ->  Unknown path components
/features                ->  Unknown path components
/permissions             ->  0 rows
```

Submission is the App Dashboard only — screencasts, written use cases and a
test user, uploaded by hand. Budget days of Meta's time after submitting, not
hours.

## Fix these two first, or it will be rejected on sight

Read from the app just now:

| Field | Current value | Problem |
|---|---|---|
| `terms_of_service_url` | `https://www.facebook.com/` | A placeholder pointing at Meta itself. Reviewers check this. |
| `category` | *(empty)* | Required before submission. "Business and Pages" fits. |
| `app_domains` | *(none)* | Needed once a redirect or webhook domain is declared. |

`privacy_policy_url` is set to `https://eclatdiamonds.in/privacy-policy` and
returns 200 — but it is JS-rendered, and a reviewer whose crawler sees an empty
page will fail it. Open it with JavaScript disabled before submitting.

`contact_email` is `snehachouksey@caratsense.in`, which is fine — but note the
reviewer's questions go there, and an unanswered question is a rejection.

## What is already granted, and what is not

The system-user token currently carries:

```
ads_read · business_management · leads_retrieval
whatsapp_business_management · whatsapp_business_messaging
```

Those work today because the app is in **development mode** acting on assets
the same business owns. That is exactly why WhatsApp works now and why nothing
else does.

`ECLAT_APP_STATUS=unpublished`. An unpublished app only serves people who hold
a role on it. **Going Live is what needs review**, and going Live is required
before Éclat's real customers can be messaged at scale.

## Permissions to request, by what they unlock

| Permission | Unlocks | Needed for |
|---|---|---|
| `whatsapp_business_messaging` | send/receive on the WABA | already working; needs Advanced for volume |
| `whatsapp_business_management` | numbers, templates | already working |
| `leads_retrieval` | pull a Lead Ads submission | **Meta lead forms into the CRM** |
| `pages_show_list` | list the Page | prerequisite for the two below |
| `pages_manage_metadata` | subscribe the Page webhook | **Messenger inbox** |
| `pages_messaging` | send/receive as the Page | **Messenger inbox** |
| `instagram_basic` | read the linked IG account | prerequisite |
| `instagram_manage_messages` | send/receive IG DMs | **Instagram Direct inbox** |

`ads_management` is deliberately **not** on this list. It permits creating and
editing ads, is account-wide with no per-campaign scoping, and nothing in the
product needs it — routing reads ad metadata with `ads_read`.

## What each submission needs

Meta asks the same three things per permission. Prepare them once:

1. **A screencast** showing a real person using the feature end to end, in the
   app, with the permission doing something visible. Not slides.
2. **Step-by-step instructions** a reviewer can follow in your app without
   guessing. They will follow them literally.
3. **A test account** with data already in it. A reviewer who logs in to an
   empty CRM rejects for "could not verify the use case".

Per-permission, what the screencast has to show:

- **`leads_retrieval`** — submit a Meta lead form, then show that lead appearing
  in the CRM with its answers. The whole point is the hop from Meta to us.
- **`pages_messaging` / `pages_manage_metadata`** — a customer messages the Page,
  it arrives in the inbox, a person replies, the customer receives it.
- **`instagram_manage_messages`** — the same journey on Instagram Direct.
- **`whatsapp_business_messaging`** — customer messages the business number, bot
  answers, a human takes over. This one you can already film today.

## Order of work

1. **Fix the terms-of-service URL and set the category.** Ten minutes; blocks
   everything else.
2. **Verify the privacy policy renders without JavaScript.**
3. **Submit `leads_retrieval` on its own.** It is the highest value — Meta lead
   forms are ~2,400 leads a month — and it is the easiest to film, because the
   journey already works end to end.
4. **Create the test user** with seeded conversations before submitting
   anything.
5. **Submit the Pages and Instagram set together.** They share a screencast and
   a reviewer will ask why one is requested without the other.
6. **Only then publish the app.**

## Two things that will surprise you

**Business verification is separate.** Éclat's portfolio reads
`verification_status: not_verified`, which caps messaging at 250 unique
recipients per 24 hours. App Review does not lift that, and verification does
not grant permissions. They are two different queues and you need both.

**Never verify a client portfolio as CaratSense.** Recorded in DECISIONS.md
after a live incident: completing verification with the wrong legal identity
banned a working WABA within hours, and verification is irreversible.

## Links

- App dashboard: https://developers.facebook.com/apps/1074605415310032/
- App Review: https://developers.facebook.com/apps/1074605415310032/app-review/permissions/
- Basic settings (ToS URL, category): https://developers.facebook.com/apps/1074605415310032/settings/basic/
- Business verification: https://business.facebook.com/settings/security?business_id=920334109418825
