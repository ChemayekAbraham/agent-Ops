# Prompt 2 Results — A ChatGPT-Grade Screen (Mobile First)

Generated: `2026-10-30`

## 1. Deliverables Summary

All layout and component changes follow Section 7 of `docs/ZOE_WORLD_CLASS_ASSISTANT_REPORT.md` while keeping server logic, database objects, and number-check rules untouched:

| # | Deliverable | Files Updated | Key Implementation Details |
| --- | --- | --- | --- |
| 1 | **Layout** | `src/components/zoe/ZoeChatSurface.tsx`, `src/pages/me/Zoe.tsx` | Removed the outer card border around the chat; built a full-height page layout (`min-h-[calc(100dvh-5rem)]` / `h-[100dvh]`) with a single centred conversation column (`max-w-[720px]` on desktop, full width with `px-4` / `16 px` horizontal padding on mobile) and bottom safe-area padding (`pb-[max(0.75rem,env(safe-area-inset-bottom))]`). |
| 2 | **Top bar** | `src/components/zoe/ZoeChatSurface.tsx` | Minimal sticky top bar showing title `"Zoe"`, History icon button (`zoe-conversations-toggle`), New-chat icon button (`zoe-new-chat-button`), and `"..."` menu button (`zoe-top-more-button`). Moved `Zoe notes`, `Glossary`, `Full view`, `Clear my history`, and the daily question counter (`zoe-menu-quota`) into the `"..."` menu (`zoe-top-more-menu`). The daily counter appears in the main top bar (`zoe-low-quota-badge`) **only when 10 or fewer questions remain** (`remainingQuestionsToday <= 10`). |
| 3 | **Messages** | `src/components/zoe/ZoeChatSurface.tsx`, `src/components/zoe/ZoeMarkdown.tsx`, `src/components/zoe/ZoeMiniChart.tsx` | User messages render as right-aligned purple bubbles (`bg-primary text-primary-foreground rounded-2xl`). Zoe's replies render **without a bubble** (`<article>` full-width flow) with readable line length (`max-w-[68ch]`), semantic dark/light tokens, compact inline charts (`max-w-md`), and horizontal-scroll tables (`overflow-x-auto`) with a **sticky first column** (`first:sticky first:left-0 first:z-10`) for Markdown tables, raw report tables, and SQL drawers. |
| 4 | **Message actions** | `src/components/zoe/ZoeChatSurface.tsx` | Replaced the five large buttons under each answer with **four subtle icon buttons** (`Copy`, `Thumbs up`, `Thumbs down`, and `"..."` menu holding `Regenerate`, `Show the data`, and `Report a problem`). Every icon button has a `44 px` minimum tap target (`min-h-[44px] min-w-[44px]`) and a compact `16 px` (`h-4 w-4`) icon, shown by default on the latest answer and on hover/focus-within on desktop (always reachable on touch screens). |
| 5 | **Suggestions** | `src/components/zoe/zoeConfig.ts`, `src/components/zoe/ZoeChatSurface.tsx` | Added `getStarterSuggestionsForRoles(roles, recentTopics, 3)` so an empty chat shows **at most three** starter prompts tailored to the person's active roles and recent conversation topics. Removed the mid-conversation suggestion bar above the composer. Follow-up prompts under each answer render as **at most three quiet text links** with a subtle arrow (`→`). |
| 6 | **Composer** | `src/components/zoe/ZoeChatSurface.tsx` | Replaced the single-line text input with a rounded (`rounded-3xl`), auto-growing `<textarea>` (1 to 6 lines, `max-h-36`) with a **circular Send button** (`rounded-full h-11 w-11`) inside the box that turns into a **circular Stop button** (`zoe-stop-button`) while Zoe is generating. Desktop `Enter` (without `Shift`) sends; mobile/coarse-pointer `Enter` inserts a new line. Added the calm grey disclaimer line below: `"Zoe can make mistakes. Check important figures."` (`zoe-disclaimer-line`). |
| 7 | **Progress and errors** | `src/components/zoe/zoeConfig.ts`, `src/components/zoe/ZoeChatSurface.tsx` | Renders one quiet status line (`zoe-typing-indicator`) while working. Replaced the red destructive error banner with a **soft inline note** (`border-border bg-muted/50 text-foreground`, `zoe-error-banner`) that translates raw errors via `formatPlainZoeErrorMessage()` into plain words (`"Zoe's data service is being updated. Please try again shortly."`) alongside a `"Try again"` link (`zoe-retry-button`). |
| 8 | **History and floating button** | `src/components/zoe/useZoeAssistant.ts`, `src/components/zoe/ZoeChatSurface.tsx`, `src/components/zoe/ZoeFloatingLauncher.tsx` | Added a slim left history rail on desktop (`1024 px` / `lg:` and up, `zoe-conversations-rail`) and a collapsible drawer on mobile (`zoe-conversation-drawer`), with auto-titles, inline rename (`onRenameConversation`), and single-thread delete (`deleteConversation` / `zoe-conv-delete-btn-*`). Updated `ZoeFloatingLauncher.tsx` to open a **full-height sheet on phones** (`h-[100dvh] w-full max-w-full p-0 sm:max-w-lg`). |

---

## 2. Visual Proof — 24 Screenshots (`docs/zoe/ui-screenshots/`)

Captured in headless Chromium across `360 px` (mobile), `768 px` (tablet), and `1280 px` (desktop) in both **Light** and **Dark** themes:

| State | `360 px` (Light / Dark) | `768 px` (Light / Dark) | `1280 px` (Light / Dark) |
| --- | --- | --- | --- |
| **1. Empty chat** | `zoe-empty-chat-360px-light.png` / `zoe-empty-chat-360px-dark.png` | `zoe-empty-chat-768px-light.png` / `zoe-empty-chat-768px-dark.png` | `zoe-empty-chat-1280px-light.png` / `zoe-empty-chat-1280px-dark.png` |
| **2. Long answer with table** | `zoe-long-answer-table-360px-light.png` / `zoe-long-answer-table-360px-dark.png` | `zoe-long-answer-table-768px-light.png` / `zoe-long-answer-table-768px-dark.png` | `zoe-long-answer-table-1280px-light.png` / `zoe-long-answer-table-1280px-dark.png` |
| **3. Soft inline error** | `zoe-error-360px-light.png` / `zoe-error-360px-dark.png` | `zoe-error-768px-light.png` / `zoe-error-768px-dark.png` | `zoe-error-1280px-light.png` / `zoe-error-1280px-dark.png` |
| **4. `"..."` menus open** | `zoe-menu-open-360px-light.png` / `zoe-menu-open-360px-dark.png` | `zoe-menu-open-768px-light.png` / `zoe-menu-open-768px-dark.png` | `zoe-menu-open-1280px-light.png` / `zoe-menu-open-1280px-dark.png` |

---

## 3. Keyboard, Focus Order, Tap Targets & Screen-Reader Audit

- **Tap targets**: Every top-bar button (`zoe-conversations-toggle`, `zoe-new-chat-button`, `zoe-top-more-button`), message action icon (`zoe-copy-*`, `zoe-feedback-up-*`, `zoe-feedback-down-*`, `zoe-message-more-*`), menu item (`role="menuitem"`), and composer button (`zoe-send-button`, `zoe-stop-button`) enforces `min-h-[44px]` and `min-w-[44px]`.
- **Keyboard behaviour**:
  - Desktop (`>= 768 px`, fine pointer): `Enter` submits the message; `Shift+Enter` inserts a newline.
  - Mobile / touch (`< 768 px` or `(pointer: coarse)`): `Enter` inserts a newline; tapping the circular Send button submits.
- **Screen-reader landmarks & ARIA attributes**:
  - Conversation log uses `role="log" aria-live="polite" aria-label="Zoe conversation messages"`.
  - Working status indicator and soft inline error note use `role="status" aria-live="polite"`.
  - Both `"..."` triggers expose `aria-expanded={...}` and `aria-haspopup="menu"`, and their popovers expose `role="menu"` with `role="menuitem"` children.
  - Thumbs up/down buttons expose `aria-pressed={msg.feedback === 'up' | 'down'}`.

---

## 4. Verification Results

- **Pre-build & Zoe safety guards (`npm run guard:all`)**: All 12 guards passed (`guard-staff-assistant.mjs` and `guard-zoe-parity.mjs` verified).
- **Component & unit tests**:
  - `src/components/zoe/__tests__/ZoeChatSurface.test.tsx`: **12 / 12 passed** (including new Prompt 2 layout, menu, quota `<= 10`, sticky table column, composer, soft error, and accessibility/keyboard tests).
  - `src/components/zoe/__tests__/ZoeActionsAndBrief.test.tsx`: **7 / 7 passed**.
  - `src/lib/__tests__/zoeReportExport.test.ts`, `zoeEmailDraft.test.ts`, `zoeActionDrafts.test.ts`, `staffAssistantFunction.test.ts`: **All passed**.
- **Live database health & parity harness (`npm run eval:zoe:live`)**: **5 / 5 passed**.
