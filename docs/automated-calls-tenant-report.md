# Automated calls: tenant report

*As at Thursday 23 October 2026, 09:30 Kampala. Figures come from the live database and will move during the day.*

## 1. Bottom line

There are **2 tenant scripts**, each used by **1 campaign**:

| | T1 · Rent due today | T2 · Missed payment |
|---|---|---|
| **Who** | Tenants with an unpaid Rent Plan payment on today's bill | Tenants who missed yesterday's payment and have paid nothing on it today |
| **When** | 08:00–10:00, Mon–Sat | 17:00–19:00, Mon–Sat |
| **People today** | 877 | 799 |
| **Status** | Paused | Paused |

**If you resume tenant calls today, at the current settings:**
- About **400 tenants get a call per 2-hour window**, not all 877 / 799. There are only 5 phone lines, so roughly 200 calls an hour.
- The rest are **not called that day**. Each day starts over with a fresh list, so there's no "carry over".
- Tenants who missed yesterday and haven't paid yet can get **both** calls: T1 in the morning and T2 in the evening.
- **Airtime runs out in about a day.** The balance is UGX 152,134. Two windows a day costs an estimated UGX 120,000–160,000. Calling stops by itself when the balance falls below UGX 5,000.
- **Some things on the calls don't work yet** (section 6, gaps A, B, D and E). Most importantly, **nobody is told** when a tenant asks for a callback, even though the call tells them "your agent will call you soon".

Fix the items in section 6 before pressing Start.

## 2. The switches: what "resume" actually does

Tenant calling needs **two** switches on:

| Switch | Where | Now |
|---|---|---|
| **Category pause** ("Tenants" card, or "Pause all") | Command Center → Overview | **Paused**, reason "testing" (set 22 Oct, 16:20) |
| **Campaign status** (T1 and T2 separately) | Command Center → Campaigns → Start | **Paused** (never started) |

- **Resume only the Tenants category:** nothing is called. Both campaigns are still paused.
- **Start T1 only:** calls begin at the next 08:00 window. If you start it inside the window, calls begin within a minute.
- **Start T2 only:** calls begin at 17:00.
- **Test calls** ("Call as Tenant", "Call my phone") ignore both switches. They always work between 07:00 and 21:00.

**Always true, whatever the settings:**
- No tenant is ever called before 08:00, after 19:00, or on a Sunday.
- Nobody who pressed 9, is paused in "Paused People", or is on the SMS opt-out list (2 numbers) is called.

## 3. Script T1: "Rent due today" (version 2)

**Triggered:** every Monday to Saturday at **08:00**, once that day's bill has been fixed (it's fixed at 00:05 each night). The list is built at 08:00 and calls run until **10:00**.

**Who:** every tenant with a Rent Plan payment on **today's** bill, minus what they've already paid against it today.
- If a tenant has two plans, the amounts are added together into one call.
- A plan funded today isn't on today's bill, because repayment starts the next day. Those tenants aren't called.
- Deleted and test accounts are excluded, and so are tenants without a valid Ugandan mobile number.

**What it says** (woman's voice, English):

1. **Greeting:** "Hello {first name}, this is Welile calling. This call may be recorded for quality. If you are {first name}, press 1."
   - No key within **20 seconds**: "Sorry to disturb you. Goodbye." The call is logged as *Not confirmed (wrong person or voicemail)*.
   - Wrong key: the greeting repeats once.
2. **Main message:** "Your Rent Plan payment of {amount} shillings is due today. Press 1 if you will pay today. Press 2 if you need your agent to call you. Press 3 to speak to Welile now. To stop receiving these calls, press 9." The tenant has **20 seconds** to press a key.

| Key | Tenant hears | Logged as | What actually happens |
|---|---|---|---|
| **1** | "Thank you. Please pay {agent's first name} today." | Will pay today | Logged only |
| **2** | "Thank you. Your agent will call you soon." | Wants agent to call | **Logged only. The agent is not told** (gap A) |
| **3** | "Please hold while we connect you to the Welile team." | Asked for the team | **No team phones are set**, so it always continues: "Sorry, our team is busy right now. We will call you back." It's logged as *Team busy, call back*, and **nobody is told** (gap A, gap B) |
| **9** | "You will not receive these calls again. Goodbye." | Stopped these calls | The tenant is blocked from **all** automated calls, all categories, permanently (staff can lift it) |
| nothing | (goes to the goodbye) | Listened, pressed nothing | Logged only |

3. **Every call ends with:** "Thank you for being with Welile. Goodbye."

**Example the tenant hears:** "Hello Sarah … Your Rent Plan payment of 13,967 shillings is due today …"

## 4. Script T2: "Missed payment" (version 2)

**Triggered:** every Monday to Saturday at **17:00**. The list is built at 17:00 and calls run until **19:00**.

**Who:** tenants whose **yesterday's** bill was not fully paid yesterday, **and** who have paid nothing on those plans so far today. The amount read out is yesterday's shortfall.
- On Monday, "yesterday" is Sunday, so Sunday's bill is what gets followed up.

**What it says:**

1. **Greeting:** the same words as T1 ("may be recorded", press-1 confirmation, quiet goodbye on no answer), but T2's menus still wait **10 seconds**.
2. **Main message:** "We did not receive your Rent Plan payment of {amount} shillings for {date}. Press 1 if you will pay today. Press 2 if you are having difficulty and want us to call you. Press 3 to leave a short message after the beep. To stop receiving these calls, press 9."

| Key | Tenant hears | Logged as | What actually happens |
|---|---|---|---|
| **1** | "Thank you. Please pay {agent's first name} today." | Will pay today | Logged only |
| **2** | "Thank you. A Welile team member will call you." | Having difficulty, call back | **Logged only. Nobody is told** (gap A) |
| **3** | "Please speak after the beep. Press the hash key when you finish." Then up to 60 seconds of recording, then "Thank you. We have received your message." | Left a voice message | The recording is saved and can be played in **Call Log → call detail**. **Nobody is told a message is waiting** (gap A) |
| **9** | "You will not receive these calls again. Goodbye." | Stopped these calls | Blocked from all automated calls |
| nothing | (goodbye) | Listened, pressed nothing | Logged only |

3. **Ends with:** "Thank you for being with Welile. Goodbye."

## 5. A day with both campaigns running (Monday to Saturday)

| Time (Kampala) | What happens |
|---|---|
| 00:05 | Today's bill is fixed (this already runs today, separately from the calls) |
| 08:00 | T1 builds today's list (about 877 today) and starts dialling, 5 calls at a time |
| 08:00–10:00 | About 400 calls go out. No answer or busy: one retry 2 hours later, but that falls after 10:00, so **in practice there are no retries** |
| 10:00 | T1 stops. Tenants not reached are marked *Not reached in time* |
| 17:00 | T2 builds its list (about 799 today) and starts dialling |
| 17:00–19:00 | About 400 calls |
| 19:00 | T2 stops. The rest are marked *Not reached in time* |
| Sunday | No calls |

**Order of calling:** the order the list was built in. There's no priority (for example, largest amount first, or tenants who were never reached before).

## 6. Gaps to close before resuming

**A. Callback promises aren't delivered (most important).**
- T1 key 2 says "your agent will call you soon".
- T2 key 2 says "a Welile team member will call you".
- Both scripts' "team busy" step says "we will call you back".
- T2 key 3 takes a voice message.

All four are **only logged** in the Call Log. No agent, team member or task list is notified. Today the only way to find them is to filter the Call Log by outcome. **Fix:** either send each request to the tenant's agent (an SMS or app notification) and to a CRM follow-up list, or change the words so the robot doesn't promise a callback.

**B. "Press 3 to speak to Welile now" can't connect anyone.** No team phone numbers are set (`AUTOCALL_TRANSFER_NUMBERS`), and in-app calling is paused. **Fix:** set the staff phones that should ring, or change key 3 in T1 to a voice message (as in T2).

**C. Recording notice: done (23 October).** Every script now says "This call **may be** recorded for quality". That's accurate: whole-call recording is still off, and only T2 voice messages and transfers to staff are recorded.

**SMS after every call: on (23 October).** When a call reaches its final result (answered, no answer, busy or failed), an SMS goes to **+256 748 747134**. Calls being retried don't text until their last attempt. It looks like this:

> Welile auto-call: Sarah N. (+256701\*\*\*245) Rent due today - Answered. Will pay today. Keys 1>1. 40s. 08:07

With both campaigns running, that's up to about **800 SMS a day** to that number, each charged as a normal SMS.

**D. Capacity and airtime.**

| | Now | Effect |
|---|---|---|
| Phone lines | 5 (the default; the line-count setting `AFRICASTALKING_AUTOCALL_CHANNELS` isn't set) | About 400 calls per 2-hour window |
| Lines needed to reach everyone once in 2 hours | About **11–12** for 877 tenants | Ask Africa's Talking how many lines the number allows, then set the line-count setting to match |
| Airtime balance | UGX 152,134 | Lasts about **one day** at two windows a day |
| Cost seen in tests | About UGX 290 per minute, UGX 127 for a short (≈22 s) call | A full T1 call (≈40–60 s) is likely about UGX 200–300 |

**E. Double calls on the same day.** A tenant who missed yesterday and hasn't paid by the evening hears T1 at 08:00 and T2 at 17:00. If one call a day is enough, T2 can skip anyone T1 already reached that day.

## 7. What the test calls showed (22 October, to 0701355245)

| Time | Script | Keys pressed | Result |
|---|---|---|---|
| 16:00 | Missed payment | none registered | 19 s. This is the bug found and fixed that day: key presses were being missed |
| 16:07 | Rent due today | 1 → 1 | *Will pay today*, 40 s |
| 16:14 | Rent due today | 1 → 3 | *Team busy, call back* (no team phones set) |
| 16:15 | Rent due today | 1 → 2 | *Wants agent to call* |
| 16:24 | Rent due today | 1 → 3 | *Team busy, call back* |
| 17:16 | Missed payment | 1 | Listened |

The confirmation, the menus, the outcomes and the goodbye all worked after the fix. The voice message (T2 key 3) and opt-out (key 9) paths haven't been tested on a real call yet.

## 8. How to start and stop

**To start tenant calls:**
1. Command Center → **Overview**: resume **Tenants** (or "Resume all").
2. Command Center → **Campaigns**: press **Start** on T1 and/or T2.

**To stop everything immediately:** Overview → **Pause all automated calls**. Calls already ringing finish; nothing new is dialled.

**To stop one tenant:** Paused People → **Pause someone**. You can choose all automated calls or tenants only, and set an end date if you want one.

**To change the words:** Scripts → T1 or T2 → **Edit**.
- Calls already in progress keep the old words.
- Each save becomes a new version, with history and a **Restore** button.
