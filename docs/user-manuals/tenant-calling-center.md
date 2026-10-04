# Tenant Calling Center — User Manual

This guide shows you how to use the **Tenant Calling Center**. It lives inside **Tenant Ops → Classic → Calling Center**. The Calling Center lets you phone tenants, see their payment details, and write down what happened on each call.

> **Important:** The Calling Center shares the same tenant list, call records, statuses, and history as the older **Calling Hub**. Anything you record here also appears there.

---

## 1. How to open the Calling Center

1. Sign in to the system.
2. Go to **Tenant Ops**.
3. Choose **Classic** view.
4. In the left-hand menu, click **Tenant Ops Tools**.
5. Click **Calling Center** (the icon looks like headphones).

The Calling Center opens. You will see five tabs at the top:
- **Overview**
- **Work Queue**
- **Live Call**
- **History**
- **Settings**

---

## 2. Understanding the Overview tab

The Overview shows you the big picture.

You will see five coloured cards:
- **To call** — tenants waiting for a call.
- **In progress** — calls still being worked on.
- **Callback** — tenants who asked to be called back later.
- **Parked** — tenants set aside for a reason.
- **Done** — tenants whose calls are finished.

Below the cards you may see:
- **Open attempts** — calls you started but have not finished recording.
- **Follow-ups due** — tenants who need another action soon.

To start working, click the **Work Queue** tab, or click the **Go to work queue** button.

---

## 3. The Work Queue tab

This is where you do most of your work.

At the top you can:
- Pick a **Status** from the drop-down to show only certain tenants.
- Pick **Sort by** to change the order of the list.
- Type a name or district in the **Search** box.
- Choose a **Sequential run** size: 5, 10, 25, or 50 calls.
- Press **Start sequential run** to let the system dial one tenant after another for you.

Below that is a **Filters** section. Use filters to narrow the list, for example by district or other details. Click **Clear all** to remove filters.

The main table shows one tenant per row. You will see:
- Name
- District
- Status
- Any notes from previous calls
- A **Call** button

If a yellow warning appears saying *“You are at the open-attempt limit”*, you must first record the outcome of your open calls before starting new ones.

Use the arrow buttons at the bottom to move to the next or previous page of tenants.

---

## 4. How to start a call

There are two ways to call a tenant.

### Option A: Call one tenant by yourself

1. Find the tenant in the Work Queue list.
2. Click the **Call** button in that row.
3. The system gets the tenant’s phone number and opens the **Live Call** tab.

### Option B: Let the system move through the list automatically

1. Choose how many calls you want to make from the **Sequential run** drop-down (5, 10, 25, or 50).
2. Click **Start sequential run**.
3. The system calls the first tenant.
4. After you finish recording what happened, it automatically moves to the next tenant.

> **Tip:** Sequential calling still needs you to be present. It will not make calls by itself if you do not record the outcome of the previous call.

---

## 5. The Live Call screen

When a call starts, the **Live Call** tab shows the tenant on the line.

At the top you see:
- A big circle with the tenant’s initials.
- The tenant’s **name**.
- The **phone number**.
- A coloured badge showing the call state, for example:
  - *Calling…*
  - *Ringing…*
  - *Connected*
  - *No answer*
  - *Call ended*

If the call is connected, a timer shows how long you have been talking.

In the middle of the screen are call controls:
- **Microphone button** — press to mute or unmute yourself during a connected call.
- **Red phone button** — press to hang up.
- **Phone handset button** — open your normal phone app to dial the number.
- **WhatsApp button** — open WhatsApp for this number.

Below the call controls you see the **Tenant Information** panel.

---

## 6. Reading the tenant information panel

This panel helps you understand the tenant’s situation before and during the call.

You will see:
- **Days missed** — how many days the tenant has not paid.
- **Missed amount** — how much money is overdue.
- **Total owed** — the remaining balance on the rent plan.
- **Daily payment** — the amount the tenant is supposed to pay each day.
- **Repaid so far** — how much has already been paid.
- **Days active** — how long the rent plan has been running.
- **Rent amount** — the original rent amount.
- **Plan total** — the full amount to be repaid.
- **Tenant wallet** — money the tenant has in their Welile wallet.

You will also see:
- **Tenant** name and phone number.
- **Responsible agent** name, phone number, and agent wallet balance.

If the numbers are still loading, you will see grey placeholder boxes. Wait a moment for them to fill in.

The colours tell you quickly if something is wrong:
- Red or dark red usually means the tenant is behind or has no wallet balance.
- Green usually means things are okay or money is available.

---

## 7. How to record what happened on the call

After the call ends, you must tell the system what happened.

At the bottom of the Live Call tab you will see a row of buttons:
- **No answer**
- **Phone off**
- **Wrong number**
- **Refused**
- **Engaged / callback**

### Quick outcomes

If the tenant did not answer, simply press the matching button:
- Press **No answer** if the phone rang but nobody picked up.
- Press **Phone off** if the phone is switched off or unavailable.
- Press **Wrong number** if the number does not belong to the tenant.
- Press **Refused** if the tenant rejected the call.

When you press one of these buttons, the system saves the result and can move to the next tenant if you are in a sequential run.

### If the tenant answered

Press **Engaged / callback**.
A form will open. Fill in:
- **Category** — choose the reason for the call (for example, payment reminder, payment plan, complaint).
- **Severity** — choose Normal, High, or Critical.
- **Notes** — write at least 20 characters about what the tenant said.
- **Route to** (optional) — if someone else needs to handle this, pick their name.
- **Consent** tick box — tick it if the tenant agreed to what was discussed.
- **Follow-up date and time** (optional) — if the tenant must be called back later.

Then press **Save outcome**.

> **Important:** You cannot start a new sequential run until you have recorded the outcome of the current call.

---

## 8. What happens after you record a call

After you press an outcome button:
- The call is saved in the system.
- The tenant moves to the right status group (Done, Callback, Parked, etc.).
- If you are in a sequential run, the system automatically dials the next tenant.
- If you are not in a sequential run, the Live Call tab becomes empty again and you can pick another tenant.

---

## 9. Moving through the calling list

### One-by-one

1. Stay on the **Work Queue** tab.
2. Find the next tenant.
3. Click **Call**.
4. Record the outcome.
5. Return to the Work Queue and repeat.

### Sequential run

1. Choose **5, 10, 25, or 50** calls.
2. Click **Start sequential run**.
3. Talk to each tenant as the system connects you.
4. Press the correct outcome button after each call.
5. The next tenant is dialled automatically.

---

## 10. Pause or stop a sequential run

While a sequential run is active, the status badge at the top shows **Running** with a green pulsing dot.

- To take a break, click **Pause**. The badge changes to **Paused**.
- To continue, click **Resume**.
- To end the run completely, click **Stop**. The run stops and the system forgets the rest of the list.

If the badge says **Waiting for outcome**, you must record what happened on the current call before the run can continue.

---

## 11. What to do when a tenant does not answer

If the tenant does not answer, just press the correct quick outcome button:
- **No answer** — the phone rang but no one picked up.
- **Phone off** — the phone is off.
- **Refused** — the tenant ended or rejected the call.
- **Wrong number** — the number is not correct.

The system will schedule the tenant for a retry later, based on the calling cycle rules. You do not need to remember to call back manually unless the tenant asked for a callback.

If a tenant asks you to call back later, press **Engaged / callback** and set a **Follow-up date and time**.

---

## 12. Understanding the different statuses

Here is what the statuses mean:

- **To call** — tenant has not been called yet, or it is time to try again.
- **In progress** — a call has started but the outcome has not been recorded.
- **Callback** — the tenant asked to be called back at a certain time.
- **Parked** — the case has been set aside, usually because it needs extra help.
- **Done** — the call is finished and recorded.

In the Work Queue, you can switch between these statuses using the **Status** drop-down.

---

## 13. Comments and follow-ups

When you record an **Engaged / callback** outcome, the form asks for notes. These notes are saved and can be seen by other staff.

If you set a follow-up date:
- The tenant appears in the **Follow-ups due** section on the Overview tab when the time comes.
- Another officer can pick up where you left off.

You can also see comments, ticket numbers, and park reasons in the tenant information panel during a call.

---

## 14. Viewing previous calls and call history

Click the **History** tab.

You will see:
- **Calls attempted** — total calls made.
- **Answered** — how many tenants answered.
- **Answer rate** — the percentage of answered calls.
- **Awaiting outcome** — calls still waiting for a result.

Below the cards is a table showing every call. You can:
- Choose **Last 7 days**, **Last 30 days**, or **Last 90 days**.
- Search by tenant name, officer, category, or comment.
- Click **CSV** to download the list as a spreadsheet.

Each row shows:
- When the call was made or recorded.
- Tenant name.
- Status (for example, Answered, No answer).
- Category.
- Comment.
- Follow-up date.
- Officer who made the call.

> **Note:** Calls made from the Calling Center and calls made from the Calling Hub appear in the same history list.

---

## 15. The Settings tab

The Settings tab shows information about the current calling cycle:
- Open cycle number.
- Open-attempt limit (how many unfinished calls you can have at once).
- Retry window (how many days must pass before a tenant is called again).
- Sequential run cap.
- Default sort order.
- Number of available filters.
- Number of outcome categories.

Cycles, filters, and outcome categories are set up by the operations team. You do not change them here.

---

## 16. Common problems and what to do

### “You are at the open-attempt limit”

You have too many calls that you started but did not finish recording. Go to the **Live Call** tab or the **Overview** tab, open each unfinished call, and record the outcome.

### The Call button does nothing

Make sure you have a headset or microphone allowed in your browser. The Calling Center uses your browser to make voice calls.

### The number is hidden

The number is only shown after you click **Call**. This protects the tenant’s privacy.

### The tenant is not in the list

Use the **Search** box or change the **Status** drop-down. Remember that tenants who were recently called may still be inside the retry window.

### I cannot resume the sequential run

The badge probably says **Waiting for outcome**. Record the outcome of the current call first, then click **Resume**.

---

## 17. Quick checklist for each call

1. Open **Tenant Ops → Classic → Calling Center**.
2. Go to the **Work Queue** tab.
3. Find the tenant or start a **sequential run**.
4. Click **Call**.
5. Talk to the tenant.
6. Hang up when finished.
7. Press the right outcome button:
   - No answer / Phone off / Wrong number / Refused for quick results.
   - Engaged / callback when you actually spoke to the tenant.
8. If you used **Engaged / callback**, fill in the form and save.
9. Move to the next tenant.
10. Check the **History** tab at any time to see what you and others have done.

---

*End of manual*
