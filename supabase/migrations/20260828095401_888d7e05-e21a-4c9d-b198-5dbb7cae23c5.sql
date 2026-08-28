DO $do$
DECLARE
  src text;
  pairs text[][] := ARRAY[
    ARRAY[
      E'nullif(lower(trim(coalesce(n.email,\'\'))), \'\') AS em\n    FROM promissory_notes n',
      E'nullif(lower(trim(coalesce(n.email,\'\'))), \'\') AS em,\n      nullif(lower(regexp_replace(trim(coalesce(n.partner_name,\'\')), \'\\s+\', \' \', \'g\')), \'\') AS nmk\n    FROM promissory_notes n'
    ],
    ARRAY[
      E'  ids AS MATERIALIZED (',
      E'  names AS MATERIALIZED (\n    SELECT DISTINCT nmk FROM nb WHERE nmk IS NOT NULL AND length(nmk) >= 5\n  ),\n  ids AS MATERIALIZED ('
    ],
    ARRAY[
      E'  by_email AS (',
      E'  cand_name AS MATERIALIZED (\n    SELECT p.id, p.full_name, p.created_at,\n           lower(regexp_replace(trim(p.full_name), \'\\s+\', \' \', \'g\')) AS pnm\n    FROM profiles p\n    WHERE p.full_name IS NOT NULL\n      AND lower(regexp_replace(trim(p.full_name), \'\\s+\', \' \', \'g\')) IN (SELECT nmk FROM names)\n  ),\n  by_name AS (\n    SELECT pnm,\n           (array_agg(id ORDER BY created_at ASC))[1] AS id,\n           (array_agg(full_name ORDER BY created_at ASC))[1] AS full_name,\n           min(created_at) AS created_at\n    FROM cand_name\n    GROUP BY pnm\n    HAVING count(*) = 1\n  ),\n  by_email AS ('
    ],
    ARRAY[
      E'COALESCE(bi.id, bk1.id, bk2.id, be.id) AS came_in_user_id',
      E'COALESCE(bi.id, bk1.id, bk2.id, be.id, bn.id) AS came_in_user_id'
    ],
    ARRAY[
      E'WHEN bk2.id IS NOT NULL THEN bk2.full_name\n        ELSE be.full_name',
      E'WHEN bk2.id IS NOT NULL THEN bk2.full_name\n        WHEN be.id IS NOT NULL THEN be.full_name\n        ELSE bn.full_name'
    ],
    ARRAY[
      E'WHEN bk2.id IS NOT NULL THEN bk2.created_at\n        ELSE be.created_at',
      E'WHEN bk2.id IS NOT NULL THEN bk2.created_at\n        WHEN be.id IS NOT NULL THEN be.created_at\n        ELSE bn.created_at'
    ],
    ARRAY[
      E'WHEN bi.id IS NOT NULL THEN \'linked_account\'\n        ELSE NULL\n      END AS came_in_match_basis',
      E'WHEN bi.id IS NOT NULL THEN \'linked_account\'\n        WHEN bn.id IS NOT NULL THEN \'partner_name\'\n        ELSE NULL\n      END AS came_in_match_basis'
    ],
    ARRAY[
      E'WHEN bi.id IS NOT NULL THEN nb.partner_user_id::text\n        ELSE NULL\n      END AS came_in_matched_value',
      E'WHEN bi.id IS NOT NULL THEN nb.partner_user_id::text\n        WHEN bn.id IS NOT NULL THEN nb.partner_name\n        ELSE NULL\n      END AS came_in_matched_value'
    ],
    ARRAY[
      E'LEFT JOIN by_email be ON nb.em IS NOT NULL AND be.pem = nb.em',
      E'LEFT JOIN by_email be ON nb.em IS NOT NULL AND be.pem = nb.em\n    LEFT JOIN by_name bn ON nb.nmk IS NOT NULL AND bn.pnm = nb.nmk'
    ]
  ];
  i int;
BEGIN
  src := pg_get_functiondef('public.get_promissory_ops_report(timestamptz,timestamptz)'::regprocedure);

  FOR i IN 1 .. array_length(pairs, 1) LOOP
    IF position(pairs[i][1] IN src) = 0 THEN
      RAISE EXCEPTION 'promissory name-match patch %: anchor not found', i;
    END IF;
    src := replace(src, pairs[i][1], pairs[i][2]);
  END LOOP;

  EXECUTE src;
END
$do$;