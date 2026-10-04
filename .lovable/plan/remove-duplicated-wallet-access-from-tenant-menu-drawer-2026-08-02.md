# Remove duplicated wallet access from Tenant Menu drawer

The tenant home screen already exposes the wallet through the hero card and the floating wallet button. The "My Wallet" row inside the Menu drawer is a duplicate access point and should be removed.

## Changes

1. Delete the wallet hero button block in `src/components/tenant/TenantMenuDrawer.tsx` (the button rendered at lines ~487-505 with label "My Wallet" and balance).
2. Remove the now-unused props from `TenantMenuDrawerProps`:
   - `walletBalance?: number`
   - `onOpenWallet?: () => void`
3. Remove the `Wallet` icon import from `TenantMenuDrawer.tsx` if it becomes unused.
4. In `src/components/dashboards/TenantDashboard.tsx`, stop passing `walletBalance` and `onOpenWallet` to `<TenantMenuDrawer />`.

## Verification

- `TenantMenuDrawer.tsx` compiles with no unused imports or props.
- `TenantDashboard.tsx` still opens the wallet via the hero card and floating button; the Menu drawer no longer contains a wallet row.
- Only one consumer of `TenantMenuDrawer` exists (`TenantDashboard.tsx`), so no other call sites need updating.
