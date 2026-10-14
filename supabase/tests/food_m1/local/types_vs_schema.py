"""Compare the hand-written Food row interfaces (src/lib/foodService.ts) with the
columns the final migrations create (read from a local DB via psql)."""
import re, subprocess, sys
src = open(sys.argv[1], encoding='utf-8').read()
db = sys.argv[2]
PAIRS = {
    'FoodOrder': 'food_orders', 'FoodOrderLine': 'food_order_items', 'FoodException': 'food_exceptions',
    'FoodMeal': 'food_meals', 'FoodCategory': 'food_categories', 'FoodServicePeriod': 'food_service_periods',
    'FoodCoordinatorAssignment': 'food_coordinator_assignments', 'FoodAuditEntry': 'food_audit',
    'FoodOrderEvent': 'food_order_events', 'FoodServiceClosure': 'food_service_closures',
}
# fields that are deliberately not columns: embedded or attached client-side
COMPUTED = {'items', 'employee_name', 'coordinator_name'}

def fields(name):
    m = re.search(r'export interface ' + name + r'(?: extends (\w+))? \{(.*?)\n\}', src, re.S)
    if not m: raise SystemExit('no interface ' + name)
    own = set(re.findall(r'^\s+([a-z_]+)\??:', m.group(2), re.M))
    return own | (fields(m.group(1)) if m.group(1) else set())

bad = 0
for iface, table in PAIRS.items():
    cols = set(subprocess.run(['psql', '-X', '-At', '-d', db, '-c',
        f"select column_name from information_schema.columns where table_schema='public' and table_name='{table}'"],
        capture_output=True, text=True, check=True).stdout.split())
    f = fields(iface)
    phantom = sorted(f - cols - COMPUTED)
    unused = sorted(cols - f)
    status = 'OK' if not phantom else 'MISMATCH'
    bad += bool(phantom)
    print(f'{status:8} {iface:27} -> {table:29} fields={len(f):2} cols={len(cols):2} '
          f'phantom={phantom} not-in-interface={unused}')
sys.exit(1 if bad else 0)
