# New-Landlord Pitch Rework — Before / After Review for Jane, Winnie & Hanisha

**Date verified:** 4 November 2026 (Africa/Kampala)  
**Files updated:**
- [`src/lib/landlordPitchScript.ts`](../src/lib/landlordPitchScript.ts) (shared period calculator maths, bounded offer formatter, reframed `/landlord-signup` copy, and reusable calling-team phone-opening scripts)
- [`src/pages/LandlordSignup.tsx`](../src/pages/LandlordSignup.tsx) (reframed hero, 3 / 6 / 12-month period calculator, plain-English payment staging note, updated consent & CTA)
- [`src/components/executive/landlord-ops/LandlordPitchScriptBanner.tsx`](../src/components/executive/landlord-ops/LandlordPitchScriptBanner.tsx) (reusable on-screen script + 1-unit period quick preview for calling staff)
- [`src/components/executive/landlord-ops/calling-hub/LandlordCallingHub.tsx`](../src/components/executive/landlord-ops/calling-hub/LandlordCallingHub.tsx), [`LandlordCallingHubCard.tsx`](../src/components/executive/landlord-ops/calling-hub/LandlordCallingHubCard.tsx), and [`LandlordCallingHubRecordDialog.tsx`](../src/components/executive/landlord-ops/calling-hub/LandlordCallingHubRecordDialog.tsx)
- [`src/components/executive/landlord-ops/calling-center/LandlordLiveCallPanel.tsx`](../src/components/executive/landlord-ops/calling-center/LandlordLiveCallPanel.tsx)
- [`src/components/crm/autocall/AutocallScripts.tsx`](../src/components/crm/autocall/AutocallScripts.tsx)
- [`src/components/agent/ShareLandlordLinkDialog.tsx`](../src/components/agent/ShareLandlordLinkDialog.tsx)

---

## 1. Before / After Copy Side-by-Side (`/landlord-signup`)

| Page Section | Before Rework | After Rework |
| --- | --- | --- |
| **Browser `<title>`** | `Get 12 Months Rent Guaranteed \| Welile` | `Rent Paid on Time for Your Tenant’s Rent Plan \| Welile` |
| **Hero Eyebrow** | `Welile Technologies` | `Welile Technologies · Landlord Rent Plan Partner` |
| **Hero Headline (`<h1>`)** | `Your Next 12 Months of Rent — Guaranteed` | `On-Time Rent for the Tenant You Already Have` |
| **Hero Subheadline (What Welile Actually Does)** | `Get paid every month on time, even if tenants don't pay.` | `Welile pays a landlord their tenant’s rent, on time, for an agreed period of 3, 6, or 12 months, while the tenant repays Welile over time through a Rent Plan.` |
| **Calculator Heading** | `Calculate Your Guaranteed Income` | `Estimate Rent Covered for Your Agreed Period` |
| **Calculator Default Units & Period Picker** | Units blank, fixed to `12` months only (no period selector) | Default `1` unit; landlord chooses **`3 months`**, **`6 months`**, or **`12 months`** (defaults to **`3 months`**) |
| **Calculator Output Label** | `Your 12-Month Guaranteed Income` | `Estimated Rent Covered (3-Month Rent Plan)` *(updates to 3, 6, or 12-Month Rent Plan)* |
| **Calculator Output Figure (e.g. UGX 500,000 × 1 unit × 3 months)** | Only showed 12 months: `UGX 6,000,000` (or `UGX 30,000,000` for 5 units) | **`UGX 1,500,000 for 3 months`** (`UGX 3,000,000 for 6 months` / `UGX 6,000,000 for 12 months`) |
| **How & When Money Moves (Nearby Plain Sentence)** | *(None — no explanation of how or when money moves)* | **`How payment works: Payouts are tied to a signed-up, verified tenant’s active Rent Plan and released in agreed stages after tenant and property verification — never an unconditional lump sum on signup.`** |
| **Value Props (`VALUE_PROPS`)** | 1. `Get paid every month on time`<br>2. `Welile pays even if tenant delays or runs away`<br>3. `No chasing tenants`<br>4. `We handle tenant placement and replacement`<br>5. `Predictable, stress-free income` | 1. `Get paid every month on time for your tenant’s Rent Plan`<br>2. `Welile pays your agreed Rent Plan schedule while the tenant repays Welile over time`<br>3. `No chasing tenants for late monthly rent`<br>4. `We support tenant placement and replacement for registered units`<br>5. `Predictable, verified rent collection for 3, 6, or 12 months` |
| **Form Section Heading** | `Activate Your Rent Guarantee` | `Register Your Property for a Tenant Rent Plan` |
| **Enrollment Checkbox Copy** | `I agree to enroll in the Welile Rent Guarantee Program where Welile commits to pay my rent for 12 months on time.` | `I agree to register my property with Welile so eligible tenants can apply for a 3, 6, or 12-month Rent Plan, with rent paid on time according to each verified Rent Plan schedule.` |
| **Sticky Submit Button** | `Activate My 12-Month Rent Guarantee` | `Register My Property with Welile` |
| **Post-Submission Screen** | `You're Now Secured — Welcome to Welile. Your rent is now protected for the next 12 months.` | `Property Registration Received — Thank you for registering with Welile. A Landlord Operations officer or field agent will contact you to verify your property and match your tenant’s Rent Plan.` |
| **Agent Share Link Message (`ShareLandlordLinkDialog`)** | `Guarantee your rent for 12 months with Welile! No more chasing tenants — we pay you on time every month, even if the tenant delays. Sign up here: [link]` | `Have a tenant behind on rent or an empty unit? Welile pays a landlord their tenant's rent on time for an agreed 3, 6, or 12-month Rent Plan while the tenant repays Welile over time. Register your property here: [link]` |

---

## 2. Calling Team Phone-Opening Script for Jane, Winnie & Hanisha

### Before vs. After Phone Opening

| Stage | Before (Cold Annual Total / Verification Only) | After (`src/lib/landlordPitchScript.ts` & `LandlordPitchScriptBanner.tsx`) |
| --- | --- | --- |
| **Opening Line to a New / Prospective Landlord** | Staff quoted the `/landlord-signup` headline (`"Your 12-Month Guaranteed Income: UGX 30,000,000"`) or only had the post-submission verification read-aloud (`LANDLORD_READ_ALOUD`). | **"Hello [Landlord Name], I am calling from Welile Landlord Operations. Do you currently have a tenant who is behind on rent, or a unit sitting empty? Instead of you chasing rent, Welile can enroll that tenant on a Rent Plan and pay their rent to you on time for an agreed 3, 6, or up to 12 months while the tenant repays Welile in smaller instalments."** |
| **Step 1 — Ask about one real tenant or empty unit** | *(None)* | **"Hello [Landlord Name], I am calling from Welile Landlord Operations. Do you currently have one tenant who is behind on rent, or an empty house you want occupied?"**<br>*Coaching note: Start with a real problem the landlord already has today. Never open with an abstract annual million-shilling figure.* |
| **Step 2 — Offer a bounded 3, 6, or 12-month Rent Plan** | *(Quoted 12 months across all units at once)* | **"For that specific tenant, Welile can set up a 3-month, 6-month, or 12-month Rent Plan. We pay you the agreed rent on time, and the tenant repays Welile gradually over time."**<br>*Coaching note: Quote the exact rent for 1 unit over 3 months first (for example, `UGX 500,000 x 1 unit x 3 months = UGX 1,500,000 for 3 months`).* |
| **Step 3 — Explain how and when money moves** | *(Only explained OTP at payout stage)* | **"Payment is tied to your signed-up tenant’s approved Rent Plan and paid in agreed stages after our team verifies the tenant and your payout number — not an unverified lump sum."** |

### Where Jane, Winnie & Hanisha Can Access This Script Today
1. **Landlord Calling Hub (`src/components/executive/landlord-ops/calling-hub/LandlordCallingHub.tsx`)**: Displayed at the top of the Hub with a one-tap **Copy script** button, a live 1-unit **3 mo / 6 mo / 12 mo** UGX preview, and an expandable **3-step guide**.
2. **Landlord Calling Hub Drawer Card (`LandlordCallingHubCard.tsx`)**: Personalized with the selected landlord's name and rent right below the call bar.
3. **Landlord Calling Hub Record Dialog (`LandlordCallingHubRecordDialog.tsx`)**: Shown alongside the existing Rent Plan verification `LANDLORD_READ_ALOUD` prompt.
4. **Landlord Ops Calling Center (`src/components/executive/landlord-ops/calling-center/LandlordLiveCallPanel.tsx`)**: Displayed in both the ready-to-call card and the active landlord call panel.
5. **Automated / Assisted Scripts (`src/components/crm/autocall/AutocallScripts.tsx`)**: Available as a built-in template (`New Landlord Rent Plan Opening Pitch (3, 6, or 12-month Rent Plan)`) in the **New script -> Start from** selector.

---

## 3. Calculator Maths, Responsive Layout & Database Verification

1. **Calculator Maths (`calculateLandlordPeriodRent(rentPerUnit, units, months)`)**:
   - Formula: `rentPerUnit * units * months` (identical to the previous `r * u * 12` when `months === 12`).
   - Verified examples:
     - `UGX 500,000 × 1 unit × 3 months = UGX 1,500,000 for 3 months`
     - `UGX 500,000 × 1 unit × 6 months = UGX 3,000,000 for 6 months`
     - `UGX 500,000 × 1 unit × 12 months = UGX 6,000,000 for 12 months`
     - `UGX 500,000 × 5 units × 12 months = UGX 30,000,000 for 12 months`
2. **Responsive Check at 360 px and 1280 px**:
   - **360 px mobile**: Single-column input stack (`grid-cols-1 sm:grid-cols-2`), 3-button period bar (`grid-cols-3 gap-2`) where each button has `min-h-[44px]`, text sizes `>= text-xs`, and `break-words` on the `"UGX [amount] for [period]"` output so long amounts never overflow horizontally.
   - **1280 px desktop**: Centered `max-w-lg` card layout with 2-column rent/units inputs (`sm:grid-cols-2`), clear typography hierarchy, and sticky bottom CTA bar.
3. **`public.landlord_leads` Sign-Up Flow Verification**:
   - Verified against the live database (`information_schema.columns` on `public.landlord_leads`): `full_name`, `phone`, `property_location`, `number_of_units`, `rent_per_unit`, `referrer_agent_id`, `campaign`, and `status: 'new_lead'` are unchanged in `LandlordSignup.tsx`.
