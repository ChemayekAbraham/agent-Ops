# CRM Broadcast — proposed plan

## Goal
Provide a clearly visible **Broadcast** view in the CRM dashboard for publishing audience-targeted in-app messages. This is a proposal only; no app or database changes are included.

## 1. Make Broadcast visible
- Rename the existing **In-app Communications** menu entry to **Broadcast**, retaining its Megaphone icon and existing access restrictions.
- Keep the separate **Communications** monitoring view and SMS Campaigns unchanged.
- Reuse the existing in-app publishing and recipient-dialog system rather than creating a second broadcast system.

## 2. Prepare a broadcast
- Select Agents, Supporters, Tenants, Landlords, any combination, or Everyone.
- Enter a title, full message, communication type, optional approved internal destination, start time and expiry.
- Display dates in Kampala time.
- Show the audience count and an exact dialog preview before publishing; require explicit confirmation for Everyone.
- Provide Draft, Scheduled, Live, Ended and Withdrawn views, with author, audience and dates.
- Allow saving drafts, publishing, scheduling and withdrawing. Editing a published message creates a new version and preserves history.

## 3. Communication types
| Type | Icon | Recipient dialog |
|---|---|---|
| Announcement | Megaphone | Title, full message and Close |
| Information | Info | Neutral message, with optional View details |
| Important notice | AlertTriangle | Emphasised message with Acknowledge |
| Action reminder | ClipboardCheck | Message with optional Open button to an existing platform screen |

Use simple CSS dialogs with minimal animation, readable long messages, reachable buttons, keyboard support and relevant icons. No emojis or decorative effects. Notices never block wallets or essential actions; acknowledgement records that a message was seen, not financial authorisation or legal consent.

## 4. Recipient experience
- Match broadcasts to the user's current authorised dashboard role, checked by the server.
- Everyone covers eligible signed-in users, including staff; exclude deleted accounts and disabled roles.
- Show unread live broadcasts when the app opens, after required identity or security dialogs close, one message at a time.
- Keep broadcasts accessible inside the existing notification bell, not through a floating button.
- Preserve the existing no-bell design on the alternate agent dashboard; its broadcasts appear through the automatic dialog.
- Persist acknowledgement per person and published version across devices, including for people with multiple roles.
- Expired or withdrawn messages stop appearing. Offline users see messages on their next visit only while those messages remain live.

## 5. Safety and reporting
- Only enabled CRM publishers or existing super-admin authority may publish, schedule or withdraw; enforce permissions on the server.
- Keep a history of publishing, revisions, withdrawals and acknowledgements. Distinguish publication from delivery or acknowledgement.
- Accept plain text only and approved internal destinations, not executable HTML or arbitrary redirects.
- This feature is in-app only: no automatic SMS, email, WhatsApp or push sends.
- No changes to money, wallets, ledger entries, Rent Plan approvals or other business rules.

## Technical approach
- Reuse the existing CommunicationManager, shared CommunicationGate, CommunicationDialog and bell integration.
- Add a Broadcast navigation destination while preserving existing bookmarks and keeping the monitoring view separate.
- Verify existing server contracts and live permissions before proposing any missing functionality; do not assume repository migrations reflect production.
- Keep shared message/version records and sparse acknowledgements rather than creating a notification row for every recipient.
- Use bounded cached reads, clear audience data on account/role changes, and revalidate before opening or acknowledging a message.
- Retain idempotent lifecycle events and existing trust requirements without awarding score for passive display.
- Follow the project's UI/logic ownership split and leave Agent Ops Metrics and First 7 Days untouched.

## Verification before release
1. Verify CRM can open Broadcast, save a draft, preview, publish, schedule and withdraw.
2. Test every audience, combinations and Everyone with authorised accounts; unrelated users must not fetch the message.
3. Verify automatic opening, bell reopening, full message display and acknowledgement across devices.
4. Check role switching, disabled roles, deleted accounts, expiry, withdrawal and duplicate submissions.
5. Check phone and desktop layouts, long messages and conflicts with mandatory dialogs.

## Success criteria
CRM has a visible Broadcast view; the correct users receive the appropriate simple dialog and can reopen it from their bell, without changing financial workflows.
