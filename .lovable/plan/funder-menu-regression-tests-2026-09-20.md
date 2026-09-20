# Funder menu regression tests

## Goal
Add automated tests that protect every current top-right Funder menu action and confirm each opens its intended destination.

## Implementation
- Add a focused test beside the Funder menu component.
- Mock only external content inside the drawer so tests remain fast and reliable.
- Verify every route-based item navigates to its exact existing path.
- Verify every in-page item invokes its exact existing callback.
- Verify each action closes the menu after selection.
- Cover conditional menu actions, including ready-tenant houses, vacant houses, portfolios, wallet, agreement, calculator, and sign out.

## Validation
- Run the new test file.
- Run TypeScript checks and existing project guards.
- Confirm the preview build remains healthy.

No dashboard behavior, menu destinations, financial logic, or backend rules will change.
