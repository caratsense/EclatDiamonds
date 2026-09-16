# End-to-End Implementation Plan: WhatsApp, Instagram & Meta Integrations
**Date:** September 16, 2026  
**Document:** `INTEGRATIONS_PLAN_16TH_SEPT.md`  
**System:** Eclat Diamonds / CaratOS CRM  

---

## 1. Executive Summary & Objective

This document outlines the complete, production-grade implementation plan to connect **Meta Business Suite (WhatsApp Business Cloud API, Instagram Direct, Facebook Messenger, and Meta Lead Ads)** into the **CaratOS / Eclat CRM**.

### Core Goals:
1. **Single Public Touchpoint**: 1 verified WhatsApp Business number and 1 official Instagram profile (`@eclatdiamonds`) across all public marketing.
2. **8-Branch Intelligent Redirection**: Queries automatically routed to the respective store queue (e.g., Bandra, Surat, Ahmedabad, Pune, etc.) without breaking the customer's chat thread or requiring them to switch numbers.
3. **Real-Time 3-Pane WhatsApp UI**: A live web-based WhatsApp interface built directly inside the CRM at `/conversations`, allowing all 8 branch teams to manage chats concurrently with zero device limits.
4. **Full Omnichannel Customer 360**: Unifying chats with customer diamond preferences, quotes, walk-in visits, purchase history, and follow-up reminders.

---

## 2. Architecture & Codebase Map

The codebase already contains foundational omnichannel infrastructure. The integration aligns with these existing services:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Meta Graph API                                      │
│           (WhatsApp Cloud API  ·  Instagram Direct  ·  Lead Ads Webhooks)              │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ HMAC SHA-256 Webhook POST
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Backend Ingestion & Security:                                                          │
│  • Webhook Verification & Deduplication: MetaWebhookService / WhatsAppBotService       │
│  • AES-256 Envelope Encryption for Secrets: CredentialCrypto                           │
│  • Inbound Identity Resolution: IdentityService (Party & ContactPoint 360)             │
│  • Ad Campaign Attribution: AdSetRulesService / extractMetaReferral                    │
│  • Store Routing Engine: StoreMessagingRoute & WhatsAppCredentialsService             │
│  • Unified Inbox Spine: ConversationsService                                           │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Live Invalidation / WebSockets / SSE
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Frontend Real-Time Interface:                                                          │
│  • 3-Pane Live Chat Canvas: frontend/src/app/(app)/conversations/page.tsx               │
│  • Meta Connection & Token Management: /settings/integrations/meta                     │
│  • Store-to-Number Asset Mapping: /messaging-routes & /settings/integrations/meta/assets│
│  • Multi-Store Scoped Access: StoreScopeService (Bandra, Surat, etc.)                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Source Files:
- **Unified Inbox Spine**: [`backend/src/crm/conversations.service.ts`](file:///c:/Users/Shrey/Eclat/backend/src/crm/conversations.service.ts)
- **WhatsApp Webhook Ingestion**: [`backend/src/whatsapp-bot/whatsapp-bot.service.ts`](file:///c:/Users/Shrey/Eclat/backend/src/whatsapp-bot/whatsapp-bot.service.ts)
- **Multi-Number & Store Routing Resolver**: [`backend/src/integrations/whatsapp-credentials.service.ts`](file:///c:/Users/Shrey/Eclat/backend/src/integrations/whatsapp-credentials.service.ts)
- **Instagram Outbound Adapter**: [`backend/src/integrations/adapters/instagram.adapter.ts`](file:///c:/Users/Shrey/Eclat/backend/src/integrations/adapters/instagram.adapter.ts)
- **Meta Webhooks & Lead Ads Intake**: [`backend/src/integrations/meta-webhook.service.ts`](file:///c:/Users/Shrey/Eclat/backend/src/integrations/meta-webhook.service.ts)
- **Frontend Real-Time Chat Canvas**: [`frontend/src/app/(app)/conversations/page.tsx`](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/conversations/page.tsx)
- **Meta Setup & Asset Registration Screen**: [`frontend/src/app/(app)/settings/integrations/meta/page.tsx`](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/settings/integrations/meta/page.tsx)

---

## 3. Detailed Phase-by-Phase Implementation

### Phase 1: Meta Business Portfolio & App Configuration

#### 1.1 Meta Developer App
1. Go to [developers.facebook.com](https://developers.facebook.com) → **Create App** → Select **Business** type.
2. Link the app to the verified **Meta Business Portfolio (Business Manager)** of Eclat Diamonds.
3. Add the following products:
   - **WhatsApp** (Cloud API)
   - **Messenger / Instagram Graph API**
   - **Webhooks**

#### 1.2 WhatsApp Cloud API Setup
1. Under **WhatsApp → API Setup**:
   - Register the primary public business phone number.
   - Complete OTP verification (SMS or voice).
   - Obtain:
     - `Phone Number ID` (e.g. `102938475610293`)
     - `WhatsApp Business Account ID (WABA ID)` (e.g. `987654321098765`)

#### 1.3 Instagram & Facebook Page Linkage
1. In Meta Business Suite, ensure the **Instagram Professional Account** is connected to the official **Facebook Page**.
2. Enable *"Allow access to Instagram messages in Inbox"* under Page Settings → Instagram.

#### 1.4 Permanent System User & Token
1. Go to **Business Settings → Users → System Users** → Create an Admin System User (`eclat-crm-system-user`).
2. Generate a **Never-Expiring System User Token** with the following scopes:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
   - `instagram_manage_messages`
   - `pages_manage_metadata`
   - `pages_read_engagement`
   - `pages_messaging`
   - `leads_retrieval`
   - `ads_read`
3. Securely copy this token for CRM storage.

---

### Phase 2: CRM Credentials Storage & Webhook Handshake

#### 2.1 Backend Environment Configuration
Configure the following in the CRM backend environment (`.env`):
```env
# Meta Integration Secrets
META_APP_ID="your_meta_app_id"
META_APP_SECRET="your_meta_app_secret"
META_GRAPH_API_VERSION="v20.0"

# Webhook Handshake Verification Tokens
WHATSAPP_VERIFY_TOKEN="eclat_wa_secure_webhook_token_2026"
META_WEBHOOK_VERIFY_TOKEN="eclat_meta_secure_webhook_token_2026"

# Credential Encryption (AES-256 Key for DB Storage)
CREDENTIAL_ENCRYPTION_KEY="<base64_encoded_32_byte_key>"
CREDENTIAL_ENCRYPTION_KEY_VERSION="1"
```

#### 2.2 Register Credentials in the CRM UI
1. Navigate to **CRM Settings → Integrations → Meta** (`/settings/integrations/meta`).
2. Under **WhatsApp Business Cloud**:
   - Name: `Main WABA`
   - Paste the System User Token into the encrypted Access Token input.
   - Enter the `WhatsApp Business Account ID`.
3. Under **Registered Assets** (`/settings/integrations/meta/assets`):
   - Register **Phone Number**: Enter numeric `Phone Number ID`.
   - Register **Facebook Page**: Enter numeric `Page ID`.
   - Register **Instagram Account**: Enter numeric `Instagram Business Account ID`.

#### 2.3 Webhook Setup in Meta Portal
1. **WhatsApp Webhook**:
   - URL: `https://<your-crm-domain>/api/integrations/whatsapp/webhook`
   - Verify Token: Matches `WHATSAPP_VERIFY_TOKEN`
   - Subscriptions: `messages`, `message_template_status_update`
2. **Meta / Instagram Webhook**:
   - URL: `https://<your-crm-domain>/api/integrations/meta/webhook`
   - Verify Token: Matches `META_WEBHOOK_VERIFY_TOKEN`
   - Subscriptions (Instagram): `messages`, `messaging_postbacks`, `message_deliveries`
   - Subscriptions (Page): `leadgen`, `feed`

---

### Phase 3: The 1-Number to 8-Store Branch Redirection Engine

#### 3.1 Architectural Models
To prevent customer friction and protect conversion rates, customer messages remain in **one unified WhatsApp / Instagram thread**, while internal routing dynamically assigns tickets to the right branch team.

```
Incoming Customer Message (Central WhatsApp / Instagram)
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Is this an Ad Campaign Click?   │
        └────────────────┬─────────────────┘
                         │
         ┌───────────────┴───────────────┐
         │ YES                           │ NO
         ▼                               ▼
Auto-route directly to Branch     Trigger Interactive Store Menu
(e.g., Surat Ad Campaign ID      ("Select your nearest store:
 tagged to Surat Store ID)        1. Bandra, 2. Surat, 3. Ahmedabad...")
         │                               │
         └───────────────┬───────────────┘
                         ▼
   Assign Conversation in DB (storeId: "store_surat")
                         │
                         ▼
   Appears in Surat Branch Manager's CRM Inbox View
   (Surat Manager replies live using Central Number)
```

#### 3.2 Automated Campaign Attribution (Click-to-WhatsApp / IG Ads)
- Meta's `adReferral` payload contains the campaign ID and ad set ID.
- The CRM's `AdSetRulesService` checks if the ad targets a specific branch (e.g. Surat Exhibition campaign).
- If matched, the conversation is tagged with `storeId = "store_surat"` immediately upon creation.

#### 3.3 Interactive Greeting & Store Selection (Organic Inquiries)
- If the customer arrives organically, an automated greeting presents a quick-reply menu:
  > *"Welcome to Eclat Diamonds! ✨ To connect you with our specialist nearest to you, please select your store:*
  > *1. Bandra (Mumbai)*
  > *2. Surat*
  > *3. Ahmedabad*
  > *4. Pune*
  > *(Or reply with your City / Pincode)"*
- Customer reply sets the `storeId` on the conversation.

#### 3.4 Thread Pinning (`senderAssetId`)
- For outbound messages, `WhatsAppCredentialsService` honors the conversation's original incoming number (`senderAssetId`).
- This guarantees that replies always leave from the exact same phone number ID the customer contacted, strictly preserving the 24-hour customer-care window.

---

### Phase 4: Real-Time Chat Experience & UI Capabilities

The frontend at [`/conversations`](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/conversations/page.tsx) provides a complete WhatsApp Web experience:

1. **Left Queue Panel**:
   - Filter by queue: *Inbox*, *Starred (VIP Leads)*, *Unread*, *Assigned to Me*, *Closed*.
   - Filter by store: Store managers default to their assigned location; Head Office can view all 8 branches.
   - Channel badges (`WhatsApp`, `Instagram`, `Facebook`).
2. **Center Chat Canvas**:
   - Signature WhatsApp wallpaper & message bubbles (`#d9fdd3` for agent, white/dark for customer).
   - Real-time status indicators (Sent, Delivered, Read double blue ticks).
   - Real-time updates via automatic cache invalidation on inbound webhook receipt.
   - Support for text, quick reply buttons, and image/catalog previews.
3. **Right Customer 360 Sidecar**:
   - Customer profile (Name, phone, city, VIP status).
   - Diamond preferences (Cut, clarity, carat, budget).
   - Recent store walk-in check-ins & active quotes.
   - Quick appointment booking & internal staff handoff notes.

---

### Phase 5: Testing & Go-Live Verification Checklist

| Step | Test Case | Expected Result | Status |
| :---: | :--- | :--- | :---: |
| **1** | Meta Webhook Handshake | `GET /api/integrations/whatsapp/webhook` returns `hub.challenge` | [ ] |
| **2** | Inbound Customer WhatsApp | Text sent to central number arrives in CRM inbox within < 1 sec | [ ] |
| **3** | Inbound Customer Instagram | DM sent to `@eclatdiamonds` appears with Instagram badge in CRM | [ ] |
| **4** | Outbound Agent Reply | Reply typed in CRM arrives on customer's phone as official business chat | [ ] |
| **5** | 8-Store Branch Isolation | Surat manager only sees Surat-assigned chats; Bandra only sees Bandra | [ ] |
| **6** | Click-to-WhatsApp Ad | Clicking test ad assigns lead to the target store automatically | [ ] |
| **7** | Opt-Out Compliance | Customer texting "STOP" sets `consent.revoked` and disables sales automation | [ ] |
| **8** | 24-Hour Window Rule | Free-text allowed within 24h; template required outside 24h window | [ ] |

---

## 4. Next Steps to Execute

1. **Meta App Verification**: Complete Meta Business Verification to remove messaging tier limits.
2. **Add System User Token**: Open `/settings/integrations/meta` in CRM and paste the Meta System User Token.
3. **Configure Webhook Endpoints**: Add CRM webhook URLs into Meta Developer App.
4. **Onboard Branch Staff**: Set up the 8 store manager logins under **Settings → Team** with their corresponding store assignments.
