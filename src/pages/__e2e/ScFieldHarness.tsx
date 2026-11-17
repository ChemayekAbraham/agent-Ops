/**
 * Dev-only Playwright harness for E133, the field agents' Service Centre view,
 * exactly as /agent/service-centre renders it. The spec answers
 * rpc('sc_field_board') itself (page.route on /rest/v1/).
 *
 * Mounted at `/__e2e/sc-field` only when `import.meta.env.DEV` is true.
 */
import ScFieldPage from '@/pages/desk/scField';

export default function ScFieldHarness() {
  return <ScFieldPage />;
}
