# Welile Schools Bot

- Default new-school registration to a six-step chat: name/gate, level/ownership, GPS, location, contact/enrolment, and review/save.
- Add editable reply bubbles, progress, Start Over, automatic scrolling, and Chat Bot / Classic Form modes sharing one draft.
- Use the existing Uganda location picker in both modes. Other Country uses country selection and optional town only; no typed administrative hierarchy.
- Preserve the existing school save, gate locking, profile registration and offline queue. Add a conversational locked-school greeting.
- Verify the location guard and focused tests. Live signed-in checks remain dependent on available account access.

## Technical details
- Keep the conversational UI local to the school page and reuse `createSchool()`.
- Reuse resilient smart GPS capture; do not change tables, permissions, funding logic or calling code.
- Include Mixed / K-12 as an additional UI level option, subject to the existing school field contract.