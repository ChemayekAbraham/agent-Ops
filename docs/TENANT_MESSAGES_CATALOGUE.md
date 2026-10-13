# Every Message a Tenant Receives — and What Triggers It

Prepared 8 Oct 2026 (Kampala time). Research only — nothing was changed.

Sources: the live message settings in the database, the scheduled jobs that are switched on now, the SMS sending log for the last 30 days, and the code that sends each message. Times below are **Kampala time (EAT)**.

---

## 1. How tenant messages work (in plain words)

- **Almost everything is SMS**, sent from **WELILE** through Yoola, with Africa's Talking as a backup if Yoola fails.
- Most SMS get a footer added automatically: *"For assistance, contact Welile Support on 0748747134."* Some also get *"Not on Welile yet? Sign up: welileapp.com/wjoin"*. Code messages (OTPs) never get the sign-up footer.
- **Behaviour messages** (payment received, missed payment, rent-limit growth, relocation, dashboard links) all pass through one **"traffic controller"** before sending. It checks:
  - a per-message daily/weekly limit;
  - "once per occasion" (e.g. one missed-payment SMS per missed day);
  - a **global cap of 2 marketing messages per tenant per 7 days**.
  Every send *and every skip* is recorded, so Tenant Ops can see why someone did or did not get a message.
- The wording of these behaviour messages is stored in the database (one row per message), so it can be changed without new code. The other messages have their wording written inside the code.
- Messages can also go by **push notification** and **in-app notification** for tenants using the dashboard/app. Emails to tenants are rare.

---

## 2. Volume — what tenants actually received in the last 30 days

Recipients who are tenants on a Rent Plan (some are also agents, so a few agent messages appear).

| Message | Sent | Delivered |
|---|---:|---:|
| Sign-up "request rent" prompt | 4,523 | 62% |
| Missed payment | 3,840 | 90% |
| Rent card after a payment ("paid UGX X. Balance…") | 3,073 | 99% |
| Pay Welile directly (merchant codes) | 2,467 | 96% |
| Arrears reminder (X days behind) | 2,428 | 94% |
| Payment received – partial | 1,562 | 99% |
| Payment received – full | 1,440 | 99% |
| Staff broadcasts (e.g. "up to UGX 30M") | 1,031 | 98% |
| Relocation offer | 822 | 91% |
| Smartphone discovery (dashboard link) | 750 | 93% |
| 5-day default → become an agent | 623 | 97% |
| Rent-limit progress | 387 | 79% |
| Rent limit increased | 308 | 82% |
| Rent Plan welcome (landlord paid) | 122 | 100% |
| Rent request still in progress | 71 | 100% |
| Push-notifications invite | 46 | 100% |
| Password reset code | 26 | 92% |
| Rent Plan cancelled (landlord not paid in time) | 25 | 100% |
| Dashboard invite / activated | 9 | 100% |

The low delivery rate on the sign-up prompt (62%) and rent-limit messages (≈80%) is worth checking. It usually means wrong, inactive or switched-off numbers.

---

## 3. Rent payment messages

| # | Message (live wording) | When it is sent | Limits |
|---|---|---|---|
| 3.1 | **Payment received – full:** "Welile: We received UGX {amount}. Today's rent obligation is fully cleared. Your balance is UGX {balance}." + progress lines (paid X of Y, cycle ends in N days, how much more to qualify for higher rent, how to pay directly, dashboard link) | A payment is recorded that covers today's due. Checked every **20 minutes**. | None — every qualifying payment |
| 3.2 | **Payment received – partial:** "Welile: We received UGX {amount}. Today's due was UGX {due}. UGX {left} remains and will carry forward." + same progress lines | A payment smaller than today's due. Every **20 minutes**. | None |
| 3.3 | **Rent card:** "WELILE: Hi {name}, paid UGX {amount}. Balance UGX {balance}. Card: welileapp.com/limit/…" | Immediately when an agent records/allocates a payment for the tenant. | Per payment |
| 3.4 | **Wallet rent payment:** "WELILE — Rent Money You Can Get. Hello {name}, You have paid {amount} toward your rent. Your remaining balance is {balance}… View your rent card here: {link}. Pay on time, your rent limit increases daily!" | Tenant pays rent from the Welile wallet (or it is auto-collected). | Per payment |
| 3.5 | **Missed payment:** "Welile: Yesterday's UGX {due} rent payment was not received. It remains due and carries forward. Pay directly via MTN 090777 or Airtel 4380664." (+ encouraging note for good payers) | Every day at **07:00**, for each day that closed unpaid. | 1 per day, once per missed day |
| 3.6 | **Pay Welile directly:** "You don't have to wait for your agent. Pay Welile directly using MTN 090777 or Airtel 4380664. Your agent relationship remains recognised." | Every day at **12:00**: tenant has an unpaid amount today, has paid before, and paid within the last 30 days. | 1 per day |
| 3.7 | **Agent self-payment receipt** (to agent): "{tenant} paid their rent directly. Received… Your commission…" | When a tenant pays by merchant code. Checked every 10 minutes. | Goes to the **agent**, not the tenant |

## 4. Arrears, default and penalties

| # | Message | When | Limits |
|---|---|---|---|
| 4.1 | **Arrears reminder:** "Welile: Your Rent Plan is behind by UGX {amount} ({days} days). Please pay today from your Welile wallet or through your agent. Staying behind lowers your Welile Trust Score and your future rent limit." | Every day at **07:00** for tenants 3+ days behind. The agent also gets "{tenant} is {N} days behind… Please collect today." | Daily while behind |
| 4.2 | **5-day default → earn as agent:** "Need another source of income? You can become a Welile Agent and earn by helping people access Welile services. Start here: welileapp.com/agent-commission-benefits" | Every day at **08:00**, for tenants with 5–7 missed days in a row. | **Once per default run**, never repeated daily |
| 4.3 | **Overdue penalty:** "Your rent term expired with UGX {outstanding} outstanding. A 33% penalty of UGX {penalty} has been added. New balance: UGX {new}." (SMS + in-app) | Daily job at **09:30** when the plan's term has ended unpaid. | Once per plan |
| 4.4 | **Bike lease no repayment:** "Hello {name}, your Welile electric bike lease has had no repayment for 7+ days. Outstanding: {bal}. Please top up your Welile wallet today…" | Daily at **09:00** | Only for bike leaseholders |
| 4.5 | **Advance repayment missed / deducted:** "WELILE: Your monthly advance repayment could not be collected today (low wallet balance)…" / "UGX X was deducted from your wallet today towards your daily advance installment…" | Daily deduction run (evening) | Only tenants who also hold an advance |

## 5. Rent Plan lifecycle

| # | Message | When |
|---|---|---|
| 5.1 | **Sign-up prompt:** "Hi {name}, you can now request rent from Welile and pay it back in small daily amounts. Request your Rent Plan: welileapp.com/rent" | Shortly after a new account is created |
| 5.2 | **Request still in progress:** "Welile: Your rent request is still in progress (with {stage/person}). We will update you as soon as it moves." | Checked every **15 minutes** while a request is waiting in the pipeline |
| 5.3 | **Approved:** "Your rent request for UGX {amount} has been approved. Auto-deductions will begin shortly." | Staff approves the request |
| 5.4 | **Not approved:** "Your rent request for UGX {amount} was not approved." | Staff rejects the request |
| 5.5 | **Welcome – landlord paid:** "Welcome to Welile, {name}. Your rent of UGX {amount} has been paid to your landlord {landlord}. Your repayment starts TOMORROW, {day}: UGX {daily} per day for {N} days. Total to repay: UGX {total}. Your agent {agent} ({phone})…" | Checked every **10 minutes** after the agent pays the landlord |
| 5.6 | **Rent Plan cancelled:** "{name}, the Rent Plan for your rent of UGX {amount} could not be completed because the landlord payment was not made in time. Nothing is owed by you. Your agent can submit the request again." | When the agent fails to pay the landlord within 24 hours and the money is returned |
| 5.7 | **Rent disbursed (push/in-app):** "Rent Disbursed — UGX {amount} disbursed to {landlord}" | When rent is paid to the landlord |
| 5.8 | **Rent amount changed** | Checked every 10 minutes when staff change the rent amount on a plan |

## 6. Rent limit and growth (marketing-style)

| # | Message | When | Limits |
|---|---|---|---|
| 6.1 | **Limit increased:** "Welile: Your good payment record has increased your rent access to UGX {new limit}. Keep paying consistently to grow your access." | Daily at **09:00**, only when the system actually raised the tenant's limit | 1 per day |
| 6.2 | **Limit progress:** "Welile: Every good rent payment strengthens your record and helps you qualify for higher rent access." | Mondays and Thursdays at **09:30** | 1 per week; marketing cap |
| 6.3 | **Relocation offer:** "Need to shift? Welile can support you to move to another home. Inform Welile or your agent and help arrange a new tenant for your current house." | Mondays and Thursdays at **10:00** | Up to 2 per week; marketing cap |

## 7. Tenant dashboard and app

| # | Message | When | Limits |
|---|---|---|---|
| 7.1 | **Smartphone discovery:** "Welile: If you use a smartphone, open your personal tenant dashboard here to see your rent payments and balance: {personal link}" | Tuesdays and Fridays at **11:00**, for tenants whose smartphone status is unknown | 1 per week; marketing cap |
| 7.2 | **Dashboard invite:** "Welile: Your tenant dashboard is ready. See your payments, balance and rent access anytime from your smartphone: {personal link}" | Tuesdays and Fridays at **11:15**; repeats until the link is opened | 1 per week; marketing cap |
| 7.3 | **Dashboard activated:** "Welcome to your Welile dashboard. You can now track your rent payments, balances and available services anytime: {link}" | The first time the tenant opens the dashboard | Once ever |
| 7.4 | **Turn on notifications:** "Welile: Turn on notifications from your tenant dashboard to receive faster payment updates and account information. Open: {link}" | Daily at **10:30**, for dashboard users without push notifications | 1 per day |

Messages 3.1, 3.2, 3.5, 3.6, 4.2, 6.1 and 7.3 also have **push** and **in-app** versions (e.g. "Payment received", "Rent payment pending", "Pay Welile directly", "Earn with Welile", "Welcome to your dashboard"). Those versions go only to tenants using the app.

## 8. Wallet, deposits and withdrawals

| # | Message | When |
|---|---|---|
| 8.1 | **MoMo deposit invite:** "WELILE: Thank you for sending UGX {amount} via MTN MoMo. Create your free Welile account to manage this money…" | A mobile-money payment arrives from a number |
| 8.2 | **Deposit approved:** "Welile: Hi {name}, UGX {amount} from MTN (TID …) was auto-credited…" (+ push "Deposit Approved") | Deposit verified by staff or matched automatically |
| 8.3 | **Deposit rejected:** "Your deposit of UGX {amount} rejected by {staff}. Reason: {reason}" | Staff rejects a deposit |
| 8.4 | **Cash deposit code / confirmed / expired** | Tenant deposits cash with Financial Ops; code expiry checked every 5 minutes |
| 8.5 | **Withdrawal code:** "Your withdrawal verification code is {code}. Valid 10 minutes. Do not share this code…" | Tenant starts a withdrawal |
| 8.6 | **Withdrawal received / processing / paid:** "WELILE: Withdrawal Processing…", "…being processed… Track your transaction…", "WELILE: Payment Received. Dear {name}, your payout of UGX {amount} has been confirmed…" | Each stage of a withdrawal |
| 8.7 | **Wallet moved by Financial Ops** | Staff move money between wallet buckets |

## 9. Account and security codes

| # | Message | When |
|---|---|---|
| 9.1 | **Verification code:** "Your Welile verification code is: {code}. It expires in 1 hour. Do not share this code." | Sign-up / phone verification |
| 9.2 | **Password reset:** "Your Welile password reset code is: {code}. It expires in 1 hour. Do not share this code with anyone." | Tenant taps "Reset via SMS" |
| 9.3 | **Phone number change** (code to old number + notice) | Tenant changes phone number |
| 9.4 | **ID name adopted:** "Hi {name}, the name on your National ID ({ID name}) is now the name on your Welile account… you do not need to change anything." | Name automatically updated from National ID |
| 9.5 | **Emails** (only if the tenant has an email): confirm email, login link, reset password, change email | Account actions |

## 10. Other products and programmes

| # | Message | When |
|---|---|---|
| 10.1 | **Smartphone/merchandise order sent:** "You repay Welile UGX {daily} daily from {date}, from your wallet or commission." (+ email receipt) | Order paid out |
| 10.2 | **Smartphone order not approved:** "Hi {name}, your Welile application for the {device} was not approved. Reason… No money was taken from your wallet." | Order rejected |
| 10.3 | **Welile Homes:** welcome ("welcome to Welile Homes. Your agent has enrolled you…"), "enrollment was updated", "WELILE HOMES: {amount} rent for {month} has been paid into your Welile wallet." | Agent enrols / updates; dispatch every 5 minutes |
| 10.4 | **Added by agent:** "Hi {name}, you've been added on Welile. Create your free account to track your rent: {link}" | Agent registers the tenant |
| 10.5 | **House viewing:** "Your agent {agent} will meet you there. Reply YES to confirm." | Viewing booked |
| 10.6 | **Promissory note fulfilment day:** "Welile: Today is the fulfilment day for {partner}… {agent} will follow up with you." | Daily at 09:00 on the fulfilment date |
| 10.7 | **Staff broadcasts:** any wording staff type into the broadcast tool, e.g. "WELILE: You can access rent of up to UGX 30,000,000…" | Whenever staff send one to a chosen audience |

---

## 11. Daily timeline (Kampala time)

```text
07:00  Missed-payment SMS · Arrears reminders (tenant + agent)
08:00  5-day default → agent opportunity
09:00  Rent limit increased · Bike lease no-repayment · Promissory fulfilment day
09:30  Overdue penalty · Limit progress (Mon/Thu)
10:00  Relocation offer (Mon/Thu)
10:30  Turn-on-notifications invite
11:00  Smartphone discovery (Tue/Fri)
11:15  Dashboard invite (Tue/Fri)
12:00  Pay Welile directly (merchant codes)
All day: payment received (every 20 min), Rent Plan welcome/cancel (every 10 min),
         request in progress (every 15 min), rent card, deposits, withdrawals, codes
```

## 12. Things worth noticing

1. A tenant who is behind can get **three SMS before noon**: missed payment (07:00), arrears reminder (07:00) and pay directly (12:00). These are all "transactional", so the 2-per-week marketing cap does not apply to them.
2. The arrears reminder is the only message that mentions the **Welile Trust Score**.
3. The approval/rejection SMS (5.3, 5.4) are short and don't explain the next step.
4. The sign-up prompt has only **62% delivery**.
5. Push and in-app versions exist for the main behaviour messages. Only a few tenants receive them, because few have notifications turned on (46 invites sent this month).
6. The OTP sent to **landlords** when they are paid is a landlord message, not a tenant one. Tenants never see it.

## 13. Not fully confirmed

- Exact wording of a few low-volume messages (rent amount changed, cash-deposit expired, tenant transfer) was not opened line by line.
- WhatsApp sending exists in the system but no tenant message uses it today.
