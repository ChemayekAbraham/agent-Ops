// seed.json (config tables only, no personal rows) -> seed.sql
const fs = require('fs'), path = require('path');
const D = __dirname;
const t = fs.readFileSync(path.join(D, 'seed.json'), 'utf8');
const rows = JSON.parse(t.slice(t.indexOf('{'))).rows;
let out = 'SET client_min_messages=warning;\nSET session_replication_role=replica;\n';
for (const r of rows) {
  if (!r.d) continue;
  const j = JSON.stringify(r.d);
  if (j.includes('$SEEDX$')) throw new Error('tag clash ' + r.t);
  if (r.t === 'system_config') {
    // a JSON null in a NOT NULL jsonb column: keep it as the jsonb literal null
    out += `INSERT INTO public.system_config (key, value, updated_at) SELECT e->>'key', COALESCE(e->'value', 'null'::jsonb), (e->>'updated_at')::timestamptz FROM jsonb_array_elements($SEEDX$${j}$SEEDX$::jsonb) e;\n`;
  } else {
    out += `INSERT INTO public.${r.t} SELECT * FROM json_populate_recordset(NULL::public.${r.t}, $SEEDX$${j}$SEEDX$);\n`;
  }
}
out += 'SET session_replication_role=origin;\n';
fs.writeFileSync(path.join(D, 'seed.sql'), out);
console.log('seed.sql', out.length);
