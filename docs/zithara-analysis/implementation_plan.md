# Implementation Plan — Award-Winning Venture SaaS Transformation, Face Scanner & Meeting KPIs

This implementation plan outlines the complete end-to-end transformation of the platform into a modern venture SaaS application, eliminating jewelry-specific imagery/copy, embedding an award-winning aesthetic, adding Google Sign-In, building a Weather Point-style Biometric Face Scanner, and integrating the complete KPI suite from the Zithara demonstration video.

---

## User Review Required

> [!IMPORTANT]
> **Venture Brand Positioning:** We are pivoting the public branding from single-vertical jewelry to **CaratSense / Omnichannel Intelligence OS** — a universal retail & enterprise intelligence platform. All jewelry images (e.g. `/images/luxury_jewelry_hero.png`), gold monogram jewelry marks on public pages, and jewelry-only copy will be replaced with high-tech, award-winning SaaS visuals (inspired by Stripe, Linear, Vercel, and Raycast).

> [!IMPORTANT]
> **Biometric Face Scanner Architecture:** The face scanner will operate via browser HTML5 camera stream with a canvas-based HUD biometric scanning reticle, liveness detection simulation, and audio chime feedback. It will connect to both **Staff Attendance** (`/check-in` & `/hrms`) and **Showroom Walk-in Recognition** (`/instore` & `/checkins`).

---

## 1. Complete System Diagnostic: What is Broken, Semi-Built, and Pending

Before executing the overhaul, here is the full audit of the current application across all 35+ routes:

### A. Broken or Disconnected Pages
1. **`/tasks` vs `/calling` (FIXED):** The In-Store app's bottom navigation linked to `/tasks`, but the page was at `/calling`. We created `frontend/src/app/(app)/tasks/page.tsx` re-exporting `CallingPage`, resolving the 404.
2. **Google Sign-In Hidden on `/login`:** The Google button was conditioned on `process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ? (...) : null`. When the env variable wasn't defined, the button was completely invisible.
3. **In-Store Tabs 2–5 (`/instore`):** The `Visits`, `Dashboard`, `Tasks`, and `Forms` tabs in `/instore` currently render a placeholder card with a button pointing to other desktop screens rather than offering unified floor workflows.

### B. Semi-Built Features
1. **Meta Lead Forms Dynamic Answers (`/lead-forms` & `/crm`):** The backend successfully ingests Meta Lead Form questionnaires and saves custom answers into `Lead.attributes.metaLeadForm`, but there is no UI table or modal rendering these answers (e.g. `City`, `Budget`, `Custom Questionnaire`), nor does it display the `Old Lead` vs `New Lead` status badges shown in Zithara screenshot `06_meta_form_answers.png`.
2. **Meeting Video KPIs Missing on CRM & Dashboards:** Screenshot `04_lead_management_table.png` showed a 7-card omnichannel lead metric bar (`Total Leads`, `Total Visits`, `Total Enquiries`, `Facebook Leads`, `WhatsApp Leads`, `Social Leads`, `New Leads with Visits`) along with an Intent Donut Chart (`Highly Convertable`, `Convertable`, `Low Intent`) and Gender/Category Bar Chart. The current `/crm` page has only a Kanban board without any top KPI tiles.

### C. Fully Built & Tested Features (Green Build)
* `In-Store Mobile Floor App` (`/instore`): Instant partial-phone search, ad source tag, Customer 360 drawer, multi-enquiry visit logging with walk-out reasons, and physical barcode scanner.
* `Calling Team Queue & Telephony IVR` (`/calling` & `/tasks`): 4 KPI summary cards, filter buckets, task queue, and Take Action modal with HTML5 audio playback of IVR call recordings.
* `Ad-Set Level AI Prompt & Guardrails Configuration`: 2-step wizard modal with guidelines, prompt editor (5,000 chars), guardrails editor (2,000 chars), and live validation counters.
* `Real-Time Intent Score & Explainable AI Panel`: SVG circular radial gauge meter (0–100), intent category pills, natural-language AI reasoning card, and suggested next actions checklist.

---

## 2. Proposed Architectural & Visual Changes

### Phase 1: Award-Winning Venture SaaS Design & Jewelry Removal

#### [MODIFY] [login/page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/login/page.tsx)
- Remove `/images/luxury_jewelry_hero.png` and jewelry-specific text ("every counter", "Surat Main / Mumbai Bandra", etc.).
- Replace left visual panel with an **award-winning dark luxury tech aesthetic**:
  - Deep obsidian & emerald ambient mesh gradient (`#05130e` / `#071e16` / `#0a2e22`).
  - Interactive live venture architecture graphic (glowing real-time node connections: Meta Ads → AI WhatsApp Agent → Biometric Floor Terminal → Revenue Analytics).
  - Floating glassmorphism cards with micro-animations: Live Ingestion Throughput (`45.2k leads/sec`), AI Intent Accuracy (`94.8%`), and Biometric Latency (`<120ms`).
- **Google Sign-In Button:**
  - Make permanently visible with standard Google G-logo, sleek white/dark border, and smooth hover state.
  - Implement seamless one-tap sign-in with instant fallback demo token for local testing.

#### [MODIFY] [page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/page.tsx)
- Upgrade the public landing page into an **award-winning venture SaaS site** (Linear/Stripe aesthetic):
  - Hero section with animated gradient text, pill badges (`v2.4 Live · Enterprise Omnichannel OS`), and high-contrast CTA buttons.
  - Interactive Bento Grid showcasing the 4 pillars:
    1. **Omnichannel AI Ingestion:** Meta Ads, CTWA WhatsApp, Website Leads in one unified stream.
    2. **Explainable Intent Scoring:** 0–100 AI warmth calibration with actionable sales guidance.
    3. **Biometric Face Verification:** Instant attendance and showroom visitor recognition.
    4. **Offline-to-Online ROAS Attribution:** Bridging ad clicks to physical POS revenue.
  - Interactive live metric preview widget showing live simulation of inbound leads.

---

### Phase 2: Weather Point-Style Biometric Face Scanner

#### [NEW] [face-scanner-modal.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/components/biometrics/face-scanner-modal.tsx)
- Full-screen / sheet camera viewfinder with a high-tech biometric HUD:
  - **Camera Viewfinder:** HTML5 `navigator.mediaDevices.getUserMedia` with fallback simulation mode.
  - **Biometric HUD Overlay:**
    - Animated neon cyan/emerald scanning laser sweep.
    - 4-corner targeting reticle with circular facial landmark detection points.
    - Real-time status badge: `ALIGNING FACE` → `ACQUIRING BIOMETRIC MESH` → `LIVENESS CHECK (BLINK DETECTED)` → `MATCH VERIFIED (99.2%)`.
  - **Audio Feedback:** Web Audio API pleasant high-frequency chime upon successful match.
  - **Verification Card:** Displays employee/customer name, role/tier, timestamp, GPS coordinates, and confidence score.

#### [MODIFY] [check-in/page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/check-in/page.tsx)
- Integrate a prominent **"⚡ Biometric Face Punch"** button in addition to the standard GPS check-in.
- Launches the `FaceScannerModal`, records the facial biometric verification, and auto-completes the attendance punch with a verified badge.

#### [MODIFY] [instore/page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/instore/page.tsx)
- Add a **"Scan Visitor Face"** quick action in the showroom floor app header.
- Allows sales reps to instantly recognize returning VIP visitors walking into the store and pull up their profile and ad history.

---

### Phase 3: Zithara Meeting Video KPI Suite & Analytics

#### [NEW] [omnichannel-kpis.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/components/crm/omnichannel-kpis.tsx)
- Comprehensive metric bar matching screenshot `04_lead_management_table.png`:
  - **7 Metric Cards:**
    1. `Total Leads / Customers` (`45,189` / dynamic)
    2. `Total Visits (Footfall)` (`7,420` / dynamic)
    3. `Total Enquiries` (`14,810` / dynamic)
    4. `Facebook Ad Leads` (`3,120`)
    5. `WhatsApp Bot Leads` (`1,840`)
    6. `Social Inquiries` (`4,650`)
    7. `New Leads with Visits` (`5,210`)
  - **Donut Chart Component:** `Leads by Intent` (`Highly Convertable` 42%, `Convertable` 36%, `Low Intent` 22%).
  - **Channel Bar Chart:** `Visits by Channel` (WhatsApp vs Facebook vs Instagram vs Walk-in).
  - **Funnel Progression:** Clicks → Chats → Enquiries → Visits → Converted Orders.

#### [MODIFY] [crm/page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/crm/page.tsx)
- Mount the `OmnichannelKpis` header above the Kanban board / list view.
- Add toggle to collapse/expand analytics so sales reps can focus on their active pipeline.

#### [MODIFY] [dashboards/page.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/app/(app)/dashboards/page.tsx)
- Add an "Omnichannel Growth" tab in dashboards featuring the Zithara conversion funnel and intent breakdown charts.

---

### Phase 4: Meta Lead Forms Dynamic Questionnaire Answers Viewer

#### [NEW] [meta-form-answers-modal.tsx](file:///c:/Users/Shrey/Eclat/frontend/src/components/crm/meta-form-answers-modal.tsx)
- Renders submitted Meta Lead Form answers from `Lead.attributes.metaLeadForm` matching screenshot `06_meta_form_answers.png`:
  - Customer Name, Phone, Email.
  - `New Lead` vs `Old Lead` badge with aging indicator.
  - Custom questionnaire grid (e.g. City, Jewelry preference, Budget range, Occasion date).
  - Export to CSV button.

---

## Verification Plan

### Automated Tests & Compiles
- Frontend TypeScript check:
  ```powershell
  npx tsc --noEmit --project c:\Users\Shrey\Eclat\frontend\tsconfig.json
  ```
- Backend build check:
  ```powershell
  npm --prefix c:\Users\Shrey\Eclat\backend run build
  ```

### Manual Verification
1. **Login Page (`/login`):**
   - Verify zero jewelry references/images. Verify sleek venture dark theme, live glass widgets, and active Google Sign-In button.
2. **Main Page (`/`):**
   - Verify modern enterprise SaaS look, Bento grid, and responsive layout.
3. **Face Scanner (`/check-in` & `/instore`):**
   - Click "Biometric Face Punch" on `/check-in`.
   - Verify camera viewfinder, neon scanning HUD reticle, liveness scan animation, and verified audio chime.
4. **Meeting KPIs (`/crm` & `/dashboards`):**
   - Verify top 7 KPI blocks (`Total Leads`, `Total Visits`, `Total Enquiries`, etc.) and the Intent breakdown donut chart match screenshot `04_lead_management_table.png`.
