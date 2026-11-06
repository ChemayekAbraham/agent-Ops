[MERCY-CFO-REQ-RECON] Read-only findings. Nothing was changed. No plan steps.

## 1. Search output
```text
src/components/financial-ops/ManualRequisitionQueuePanel.tsx:50:    title: 'Manual requisitions awaiting CFO approval',
src/components/requisitions/StaffRequisitionQueue.tsx:178: * dashboard; the "Awaiting my review" tab is derived from the caller's roles
src/components/requisitions/StaffRequisitionQueue.tsx:563:    { key: 'inbox', label: `Awaiting my review (${buckets.inbox.length})` },
src/components/requisitions/StaffRequisitionQueue.tsx:578:          <Wallet className="h-4 w-4 sm:h-5 sm:w-5 text-primary" /> Staff requisitions
src/hooks/useCfoApprovalNotifications.ts:185:    // Staff requisitions (My Space -> department head -> COO -> CFO). Counts only
src/hooks/useCfoApprovalNotifications.ts:187:    // which is exactly what the shared queue's "Awaiting my review" tab shows.
```
Path: `src/pages/cfo/Dashboard.tsx:235-236` `case 'requisitions': return <RequisitionsWorkspace manualStage="cfo" />;` → `RequisitionsWorkspace.tsx:35` `<StaffRequisitionQueue />`.

## 2a. "Awaiting my review" condition (StaffRequisitionQueue.tsx 289-337)
```ts
const isMine = useCallback(
  (row: StaffRequisition) => {
    if (!row.current_approver_role) return false;
    const r = roles as string[];
    if ((row.request_kind ?? 'requisition') === 'requisition') {
      const signedEarlier = row.stage !== 'ceo' && [
        row.stage !== 'supervisor' ? row.supervisor_decided_by : null,
        row.stage === 'cfo' ? row.coo_decided_by : null,
        row.stage === 'cfo' ? row.ceo_decided_by : null,
      ].includes(user?.id ?? '__none__');
      const isOfficeStage = row.stage === 'coo' || row.stage === 'ceo' || row.stage === 'cfo';
      const holdsOffice = !isOfficeStage || officeHolders[row.stage] === user?.id;
      return r.includes(row.current_approver_role) && !signedEarlier && holdsOffice;
    }
    return r.includes(row.current_approver_role);
  },
  [roles, user?.id, officeHolders],
);

const deskStage = useMemo(() => {
  const path = window.location.pathname;
  if (path.startsWith('/cfo')) return 'cfo' as const;
  if (path.startsWith('/ceo')) return 'ceo' as const;
  if (path.startsWith('/coo')) return 'coo' as const;
  return null;
}, []);

const buckets = useMemo(() => {
  const pending = rows.filter((r) => ['supervisor', 'coo', 'cfo', 'ceo'].includes(r.stage));
  const deskPending = deskStage
    ? pending.filter((r) => r.stage === deskStage || r.requester_id === user?.id)
    : pending;
  return {
    inbox: deskPending.filter((r) => isMine(r) && r.requester_id !== user?.id),
    in_flight: deskPending.filter((r) => !(isMine(r) && r.requester_id !== user?.id)),
    ...
```
`officeHolders` map: `omap[o.office_key] = o.holder_id;` (lines 241-246). If that RPC errors, the map stays `{}`, so `holdsOffice` is false for coo/ceo/cfo stages.

## 2b. Hiding / buttons / access message
- No condition hides the whole section and there is no "access" / "not authorised" message in StaffRequisitionQueue.tsx or RequisitionsWorkspace.tsx (only `return null` at line 322 is inside `deskStage`).
- Approve / Reduce / Decline gated by line 551:
  `const canReviewRow = (row: StaffRequisition) => isMine(row) && row.requester_id !== user?.id;`
  used at lines 755 `{canReviewRow(row) && (`, 777 `{!canReviewRow(row) && !canOwnReduce(row) && row.stage !== 'approved' && (`, 906 `{canReviewRow(detail) && (`.

## 2c. Data sources
- `useAuth()` → `user`, `roles` (line 187)
- `supabase.from('staff_requisitions').select('*')` (234)
- `supabase.from('v_staff_requisition_budget_context').select('*')` (235)
- `supabase.from('staff_requisition_usage_reports')` (237)
- `supabase.rpc('staff_requisition_offices_list' as never)` (239)
- `supabase.from('staff_requisition_events')` (276, detail history only)
- `supabase.rpc('staff_requisition_reduce_amount', ...)` (517, own reduction)
- `usePolling(() => fetchAll(), 60_000)` (272)
- Not referenced in this file: `is_requisition_office_holder`, `staff_requisition_offices` table, `is_cfo_approver`, `useStaffPermissions`.

## 3. Route and menu
`src/App.tsx:780`
```tsx
<Route path="/cfo/dashboard" element={<RoleGuard allowedRoles={['cfo', 'super_admin', 'cto']} requiredPermission="cfo"><CFODashboardPage /></RoleGuard>} />
```
Menu: `src/components/layout/executiveSidebarConfig.ts:135`
```ts
{ label: 'Requisitions', icon: ClipboardList, id: 'requisitions' },
```
No `access` field on that item, and `src/pages/cfo/Dashboard.tsx` has no condition hiding `requisitions` (only the `case 'requisitions':` at 235).
