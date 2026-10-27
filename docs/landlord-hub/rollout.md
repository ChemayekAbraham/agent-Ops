# Landlord Calling Hub — Rollout, One-Minute Rollback, Officer Guide & First-Week Checklist

**Route**: `/landlord-ops/calling` (menu label: **Calling Hub**)  
**UI Components**: `src/components/executive/landlord-ops/calling-hub/`  
**Hooks**: `src/hooks/useLandlordCallingHub.ts`  
**Database Migrations**:
- `supabase/migrations/20261028100000_landlord_calling_hub_foundation.sql`
- `supabase/migrations/20261028110000_landlord_calling_hub_reports.sql`

---

## 1. The Feature Switch (`landlord_hub_new`)

The `/landlord-ops/calling` page ([src/pages/landlord-ops/calling/CallingHub.tsx](file:///Users/Timothy/Desktop/WELILE/welilereceipts-com-98bba33b/src/pages/landlord-ops/calling/CallingHub.tsx)) checks `useLandlordHubNewEnabled()` from [src/hooks/useLandlordCallingHub.ts](file:///Users/Timothy/Desktop/WELILE/welilereceipts-com-98bba33b/src/hooks/useLandlordCallingHub.ts):

1. **Default behavior**: Enabled (`true`) by default for Landlord Ops (`landlord_ops`) and all authorized staff.
2. **Global database switch (`public.system_config`)**:
   - Key: `'landlord_hub_new'`
   - Value: `{"enabled": true}` (renders `<LandlordCallingHub />`) or `{"enabled": false}` (renders the previous `<LandlordCallingCenter initialTab="calling_hub" />`).
3. **Per-browser local override (`localStorage`)**:
   - Key: `'welile:landlord_hub_new'`
   - Value: `'false'` or `'0'` forces the previous Calling Center view on that device; `'true'` or `'1'` forces the new Landlord Calling Hub on that device.

---

## 2. One-Minute Rollback Procedure

### Option A: Instant UI Rollback (Under 30 Seconds — Keeps All Recorded Calls)
To switch all staff back to the previous Calling Hub screen immediately without dropping any recorded calls or reports, run the following SQL in the Supabase SQL Editor:

```sql
INSERT INTO public.system_config (key, value, description, updated_at)
VALUES (
  'landlord_hub_new',
  '{"enabled": false}'::jsonb,
  'Feature switch for the new Landlord Calling Hub on /landlord-ops/calling',
  now()
)
ON CONFLICT (key) DO UPDATE
  SET value = '{"enabled": false}'::jsonb,
      updated_at = now();
```

To re-enable the new Landlord Calling Hub later:

```sql
UPDATE public.system_config
   SET value = '{"enabled": true}'::jsonb,
       updated_at = now()
 WHERE key = 'landlord_hub_new';
```

### Option B: Database Function & Report Rollback (Only If Needed)
If the database report functions or foundation objects themselves must be rolled back:
1. Restore the pre-hub versions of `staff_calling_detailed_report`, `v_landlord_registry_all`, `_landlord_cc_events_in_window`, and `landlord_cc_coverage`:
   ```bash
   npx supabase db query --linked -f supabase/rollbacks/20261028110000_landlord_calling_hub_reports.rollback.sql
   ```
2. Drop the `landlord_hub_*` RPCs, views, and tables (only if no production calls need to be retained):
   ```bash
   npx supabase db query --linked -f supabase/rollbacks/20261028100000_landlord_calling_hub_foundation.rollback.sql
   ```

---

## 3. One-Page Officer Guide (Plain Words)

### How to Use the Landlord Calling Hub (`/landlord-ops/calling`)

 The **Calling Hub** is built for your phone screen so you can call landlords, check their houses and Rent Plans, and record every call in one place.

#### Step 1: Pick Who to Call
- At the top of the screen, the scope defaults to **Live Rent Plans** (landlords who have active Rent Plans right now). You can switch to **With Rent Plans** or **All Landlords** at any time.
- Use the five tabs:
  - **To call**: Landlords who have never been called, or whose last call was not answered more than 7 days ago.
  - **Call back**: Landlords who asked us to call back at a specific date and time. Overdue call-backs appear at the top.
  - **Answered**: Landlords we have reached and spoken with.
  - **Not answered**: Landlords whose last call was No answer, Phone off, or Wrong number.
  - **All**: Every landlord in the selected scope.
- Tap any number in the top summary strip (for example **Call-Backs Due** or **Never Called (Live Plans)**) to jump straight to that list.
- If a row shows **"Being called by [Name]"**, another officer dialled that landlord in the last 20 minutes. Skip that row and pick the next landlord.

#### Step 2: Place the Call
- Tap the **Call** button on a landlord row (or tap the landlord's row first to open the **Landlord Card** and check their houses, tenants, Rent Plans, and payout number, then tap **Call**).
- Your phone dialler opens automatically with the landlord's number, and Welile marks that landlord as being called by you for the next 20 minutes so no colleague double-dials them.

#### Step 3: Return to Welile and Record the Call
- As soon as you finish the phone call and return to the Welile tab or app, the **Record Call** box opens automatically for the landlord you just dialled.
- If you closed or refreshed the page during the call, a **Return-from-Call Banner** appears at the top of the screen with a **Record Now** button so you never lose your place.
- Pick what happened on the call:
  1. **Answered**:
     - Answer the **4 Landlord Awareness Questions**:
       1. Aware of the 30-minute Rent Plan verification rule? (*Knew*, *Heard*, or *Did not know*)
       2. Consents to the Rent Plan? (*Consents*, *Unsure*, or *Refuses*)
       3. Aware of the payout OTP rule? (*Knew*, *Heard*, or *Did not know*)
       4. Did you explain any unclear terms? (*Yes*, *Partly*, or *No*)
     - Pick the **Feedback Category** (*Reached — all okay*, *Confirmed payout number*, *Wants more tenants*, *Landlord complaint*, *Payout issue*, *Not a landlord*, or *Wrong phone number*) and **Severity** (*Normal*, *High*, or *Critical*).
     - Type a clear **Note** of at least **20 characters** (for example: `"Confirmed mobile money payout number UGX 1,234,000 Rent Plan with landlord"`).
     - Optionally tick which tenants/Rent Plans were discussed, then tap **Save Call Record**.
  2. **Call back**:
     - Pick when to call back (**In 1 hour**, **This afternoon (14:00)**, **Tomorrow morning (09:00)**, or choose a custom date and time) and add an optional note, then tap **Save Call Record**.
  3. **No answer**, **Phone off**, or **Wrong number**:
     - Tap the result, add an optional short note if helpful, and tap **Save Call Record** (one tap).

#### Step 4: Follow Up on Call-Backs & Corrections
- Check the **Call back** tab during the day so no scheduled call-back becomes overdue.
- Recorded calls are permanent and cannot be deleted. If you made a mistake on a call you recorded today, open the **Landlord Card**, find your call under **Call History**, and tap **Amend (24h)** within 24 hours to save a correction with a short reason.
- Every call you record appears automatically in your **My Space > Calling Reports** (`/me/reports`) and in the team report (`/me/staff-reports`).

---

## 4. Daily Checklist for the First Week of Rollout

Run the following read-only check once per day during the first 7 days of rollout to verify adoption, unrecorded dials, overdue call-backs, and report consistency:

| Check | What to Look For | Healthy Target |
| :--- | :--- | :--- |
| **1. Calls recorded vs dials started** | Compare today's rows in `landlord_calls` against today's rows in `landlord_call_dials`. Every completed phone call should have `call_id IS NOT NULL` on its dial row. | `>= 90%` of dials linked to a recorded call by end of day |
| **2. Unrecorded dials older than 24 hours** | Check `landlord_call_dials WHERE call_id IS NULL AND started_at < now() - interval '24 hours'`. These count as `excluded_reveals` in `staff_calling_detailed_report`. | Near `0` (follow up with any officer leaving dials unrecorded) |
| **3. Call-backs overdue** | Check `call_backs_overdue` in the top strip of `/landlord-ops/calling` (or `SELECT landlord_hub_stats()->>'call_backs_overdue'`). | `0` overdue call-backs at end of shift |
| **4. My Space & HR report totals** | Open `/me/reports` (as Jane) and `/me/staff-reports` (as HR / Mark Bwayo) for the current week and confirm rows with source `Landlord Ops - Calling Hub` match `SELECT count(*) FROM v_landlord_calls_effective WHERE voided_at IS NULL` for the same window. | Exact match (`0` difference) |

### Diagnostic SQL Query (Read-Only)
```sql
SELECT
  (SELECT count(*) FROM public.landlord_call_dials WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala') AS dials_started_today,
  (SELECT count(*) FROM public.landlord_call_dials WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala' AND call_id IS NOT NULL) AS dials_recorded_today,
  (SELECT count(*) FROM public.landlord_call_dials WHERE call_id IS NULL AND started_at < now() - interval '24 hours') AS unrecorded_dials_over_24h,
  public.landlord_hub_stats() AS current_hub_stats;
```
