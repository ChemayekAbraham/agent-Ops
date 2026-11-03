// Adds the /desk routes to src/App.tsx. Run from the repo root: node scripts/apply-desk-routes.mjs
// Safe to run twice: it does nothing if the routes are already there. It stops if an anchor is missing.
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'src/App.tsx';
let s = readFileSync(path, 'utf8');
if (s.includes("import('./pages/desk/DeskPage')")) { console.log('Desk routes already present. Nothing to do.'); process.exit(0); }
const lazyAnchor = "const COOFunderRentPlanVisibility = lazy(() => import('./pages/coo/FunderRentPlanVisibility'));";
const routeAnchor = '<Route path="/share" element={<Index />} />';
for (const a of [lazyAnchor, routeAnchor]) if (!s.includes(a)) { console.error('Anchor not found, App.tsx changed. Add the routes by hand:\n' + a); process.exit(1); }
const roles = "['coo','ceo','cfo','cto','super_admin','operations','manager','agent_ops','tenant_ops','landlord_ops','partner_ops','financial_ops','crm'] as AppRole[]";
s = s.replace(lazyAnchor, lazyAnchor + "\n// Decision desks (E16 phase 1): new beside the old ops pages.\nconst DeskPage = lazy(() => import('./pages/desk/DeskPage'));");
s = s.replace(routeAnchor,
  `{/* Decision desks (E16 phase 1). Data comes from desk_feed(), which checks roles in the database too. */}\n          <Route path="/desk" element={<RoleGuard skipAllowlist allowedRoles={${roles}}><DeskPage /></RoleGuard>} />\n          <Route path="/desk/:desk" element={<RoleGuard skipAllowlist allowedRoles={${roles}}><DeskPage /></RoleGuard>} />\n          ` + routeAnchor);
writeFileSync(path, s);
console.log('Added /desk and /desk/:desk to src/App.tsx');
