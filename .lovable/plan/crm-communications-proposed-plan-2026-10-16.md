# CRM communications — proposed plan

## Goal
Add a **Communications** view to the CRM dashboard where authorised CRM staff can publish in-app messages to **Agents, Supporters, Tenants, Landlords**, selected combinations, or **Everyone**. Recipients see a simple dialog on the appropriate dashboard.

This is a proposal only. No app or database changes have been made.

## 1. CRM screen
- Add **Communications** to the CRM menu with a **Megaphone** icon, without removing existing tools.
- List **Draft, Scheduled, Live, Ended and Withdrawn** messages, with audience, type, author and dates.
- A **New communication** form contains audience checkboxes, communication type, title, message, optional internal destination, start time and expiry.
- Show an audience count and an exact recipient-dialog preview before publishing. Confirm broad “Everyone” messages explicitly.
- Offer **Save draft**, **Publish/Schedule**, and **Withdraw**. Changing a live message creates a new version, preserving what was previously published.
- Times are entered and displayed in Kampala time.

## 2. Types control the dialog
All types use the same simple, CSS-styled dialog foundation. Type changes the icon, emphasis and appropriate button—not the underlying financial or approval workflows.

| Type | Icon | Recipient presentation |
|---|---|---|
| Announcement | Megaphone | Title, message and Close |
| Information | Info | Neutral information with optional View details |
| Important notice | AlertTriangle | Clearly emphasised notice with Acknowledge |
| Action reminder | ClipboardCheck | Message with an optional Open button leading to an existing platform screen |

- No decorative motion, bouncing icons or elaborate effects; respect reduced-motion preferences.
- Dialogs fit narrow phone screens, with a scrollable message body and reachable buttons.
- Support keyboard navigation, screen readers and clear labels; colour is not the only indicator of type.
- Notices never lock users out of wallets, repayment screens or other essential actions. Acknowledgement means “I saw this,” not financial authorisation or legal consent.

## 3. Who sees each message
- Agent messages appear on agent dashboards, Supporter messages on Supporter dashboards, and likewise for Tenants and Landlords.
- Match the **active dashboard role**, rather than displaying all messages for every role a person holds. Check role entitlement on the server as well.
- **Everyone** means all eligible signed-in platform users, including staff dashboards; exclude deleted accounts and disabled roles.
- A person with multiple roles sees the same message version only once after acknowledging it, even if several selected audiences match.
- Users offline or signed out see eligible messages when they next return while the message remains live. Publication is not proof of delivery.

## 4. Display and acknowledgement rules
- Mount one shared message presenter for signed-in dashboards, rather than adding separate logic to every dashboard.
- Show one message at a time, ordered by importance and publication time.
- Queue communications behind existing identity, security and mandatory account dialogs; do not stack dialogs.
- Keep unread messages available through a **Communications** icon so a closed message can be reopened until it expires or is withdrawn.
- Persist acknowledgement per user and message version across devices. Avoid writing a receipt merely because a dashboard loaded.
- Expired or withdrawn messages disappear from recipients’ lists. A fresh published version may appear again.

## 5. Safety and accountability
- Publishing, scheduling and withdrawal require an enabled CRM role or existing super-admin authority, validated by the server.
- Recipients can read only messages intended for their current authorised role or Everyone. They cannot edit messages or another person’s acknowledgement.
- Keep an audit history of who published, revised or withdrew each message, when, and why.
- Message content is plain text; any optional destination is limited to approved internal screens. Do not accept executable HTML or arbitrary redirects.
- This feature sends **in-app communications only**. It does not automatically send SMS, email, WhatsApp or push notifications.
- No changes to balances, ledger entries, rent approvals, existing communications or other business rules.

## Technical approach
- Extend `src/pages/crm/Dashboard.tsx` and the CRM sidebar configuration with the new view; reuse existing dialog, button and icon components.
- Use a dedicated shared communications store, not one `notifications` row per recipient. The existing notifications table is not a complete audience-targeted publishing system, and project rules discourage bulk notification inserts.
- Proposed records: messages and published versions, audience assignments, sparse user acknowledgements, and append-only lifecycle events. Index live windows, role audiences and user/message-version acknowledgements.
- Fetch eligible messages through a server-authorised function using the active role. Enforce publication and audience permissions in database rules, with explicit grants and row-level security.
- Reuse existing authentication and role-switching state. Clear cached audience data on sign-out/account or role changes; never reuse another user’s messages.
- Use bounded, cached reads when a dashboard opens, changes role or regains focus; avoid aggressive polling or per-user realtime subscriptions. Revalidate a selected message before opening or acknowledging it so withdrawn notices do not remain actionable.
- Publication and acknowledgement are idempotent and produce the required platform events. Follow existing trust-signal rules for meaningful user interactions; passive display must not artificially raise a score.
- Verify the live schema and existing gate behaviour before implementation. Follow the project’s logic/UI ownership split; leave Agent Ops Metrics and First 7 Days untouched.

## Implementation sequence and verification
1. Implement the protected communications store, publishing functions and audience checks.
2. Add the CRM editor, lists, scheduling controls and exact dialog preview.
3. Add the shared recipient dialog and communications list.
4. Test with virtual messages first: each audience, Everyone, multiple roles, disabled roles, deleted accounts, scheduling, expiry, withdrawal, duplicate publish attempts and acknowledgement across devices.
5. Test on phones and desktop, including long messages, keyboard access, role switching and clashes with existing mandatory dialogs.
6. Verify the complete flow with authorised accounts: CRM publishes → intended user reads → acknowledges → CRM can confirm acknowledgement. An unrelated audience must not be able to fetch the message.

## Success criteria
CRM can prepare and publish a communication once, the correct users see the correct simple dialog, acknowledgements persist, and existing dashboards and financial systems behave exactly as before.