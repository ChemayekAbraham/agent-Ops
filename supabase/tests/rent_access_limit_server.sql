-- Rolled-back parity test for the server Rent Access Limit (20261014200000_rent_renewal_any_rent_days.sql).
--
-- The server function must give exactly what src/lib/rentAccessLimit.ts gives. The fixtures below were produced by RUNNING that TypeScript
-- (supabase/tests/fixtures/gen_rent_access_limit_fixtures.ts: fixed clock 2026-10-14T12:00:00Z, hand-built edge cases plus 24 seeded random
-- payment histories) and carry its answers: limit, paid days, missed days, tracked days. Run each block on its own; each ends in
-- RAISE EXCEPTION so nothing is kept and the error text is the report. Every step must pass.
--
-- Block 1  P  _rent_access_limit_calc equals the TypeScript on all 36 fixtures (limit, paid, missed, tracked)
-- Block 2  Q  the config is read as the client reads it (zero, text, negative, missing); the live parameters are used;
--          R  the data the server gathers (non-reversed collections + unmatched repayments, UTC days) equals an independent recompute for
--             60 real tenants; the gate (tenant, an agent of the tenant, ops; anyone else and signed-out refused); grants

-- ===== Block 1: P =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_now timestamptz := '2026-10-14T12:00:00Z';
  c record; v_times timestamptz[]; v_calc jsonb; v_n int := 0; v_bad int := 0; ex jsonb := '[]'::jsonb;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('no_payments', ARRAY[]::timestamptz[], NULL::int[], 10000, 7000, 30000000, 0, 0, 0, 0),
    ('paid_today_only', ARRAY['2026-10-14T06:00:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 10000, 1, 0, 1),
    ('five_day_streak', ARRAY['2026-10-14T09:00:00.000Z', '2026-10-13T09:00:00.000Z', '2026-10-12T09:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-10T09:00:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 50000, 5, 0, 5),
    ('same_day_many', ARRAY['2026-10-14T01:00:00.000Z', '2026-10-14T08:00:00.000Z', '2026-10-14T23:59:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 10000, 1, 0, 1),
    ('one_old_payment_clamps_to_zero', ARRAY['2026-09-24T10:00:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 0, 1, 20, 21),
    ('cap_hit', NULL, ARRAY[2,26,50,74,98,122,146,170,194,218,242,266,290,314,338,362,386,410,434,458,482,506,530,554,578,602,626,650,674,698,722,746,770,794,818,842,866,890,914,938,962,986,1010,1034,1058,1082,1106,1130,1154,1178,1202,1226,1250,1274,1298,1322,1346,1370,1394,1418,1442,1466,1490,1514,1538,1562,1586,1610,1634,1658,1682,1706,1730,1754,1778,1802,1826,1850,1874,1898,1922,1946,1970,1994,2018,2042,2066,2090,2114,2138,2162,2186,2210,2234,2258,2282,2306,2330,2354,2378,2402,2426,2450,2474,2498,2522,2546,2570,2594,2618,2642,2666,2690,2714,2738,2762,2786,2810,2834,2858,2882,2906,2930,2954,2978,3002,3026,3050,3074,3098,3122,3146,3170,3194,3218,3242,3266,3290,3314,3338,3362,3386,3410,3434,3458,3482,3506,3530,3554,3578,3602,3626,3650,3674,3698,3722,3746,3770,3794,3818,3842,3866,3890,3914,3938,3962,3986,4010,4034,4058,4082,4106,4130,4154,4178,4202,4226,4250,4274,4298,4322,4346,4370,4394,4418,4442,4466,4490,4514,4538,4562,4586,4610,4634,4658,4682,4706,4730,4754,4778,4802,4826,4850,4874,4898,4922,4946,4970,4994,5018,5042,5066,5090,5114,5138,5162,5186,5210,5234,5258,5282,5306,5330,5354,5378,5402,5426,5450,5474,5498,5522,5546,5570,5594,5618,5642,5666,5690,5714,5738,5762,5786,5810,5834,5858,5882,5906,5930,5954,5978,6002,6026,6050,6074,6098,6122,6146,6170,6194,6218,6242,6266,6290,6314,6338,6362,6386,6410,6434,6458,6482,6506,6530,6554,6578,6602,6626,6650,6674,6698,6722,6746,6770,6794,6818,6842,6866,6890,6914,6938,6962,6986,7010,7034,7058,7082,7106,7130,7154,7178,7202,7226,7250,7274,7298,7322,7346,7370,7394,7418,7442,7466,7490,7514,7538,7562,7586,7610,7634,7658,7682,7706,7730,7754,7778,7802,7826,7850,7874,7898,7922,7946,7970,7994,8018,8042,8066,8090,8114,8138,8162,8186,8210,8234,8258,8282,8306,8330,8354,8378,8402,8426,8450,8474,8498,8522,8546,8570,8594,8618,8642,8666,8690,8714,8738,8762,8786,8810,8834,8858,8882,8906,8930,8954,8978,9002,9026,9050,9074,9098,9122,9146,9170,9194,9218,9242,9266,9290,9314,9338,9362,9386,9410,9434,9458,9482,9506,9530,9554,9578], 100000, 7000, 30000000, 30000000, 400, 0, 400),
    ('midnight_utc_boundary', ARRAY['2026-10-11T23:59:00.000Z', '2026-10-12T00:00:00.000Z', '2026-10-12T00:01:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 6000, 2, 2, 4),
    ('future_payment', ARRAY['2026-10-17T12:00:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 30000000, 10000, 1, 0, 1),
    ('live_params', ARRAY['2026-10-14T11:00:00.000Z', '2026-10-12T11:00:00.000Z', '2026-10-11T11:00:00.000Z', '2026-10-05T11:00:00.000Z', '2026-10-04T11:00:00.000Z', '2026-09-14T11:00:00.000Z']::timestamptz[], NULL::int[], 10000, 1000, 30000000, 35000, 6, 25, 31),
    ('zero_decrement', ARRAY['2026-10-14T07:00:00.000Z', '2026-10-09T07:00:00.000Z', '2026-09-04T07:00:00.000Z']::timestamptz[], NULL::int[], 10000, 0, 30000000, 30000, 3, 38, 41),
    ('zero_increment', ARRAY['2026-10-14T07:00:00.000Z', '2026-10-09T07:00:00.000Z', '2026-09-04T07:00:00.000Z']::timestamptz[], NULL::int[], 0, 7000, 30000000, 0, 3, 38, 41),
    ('tiny_max', ARRAY['2026-10-14T07:00:00.000Z', '2026-10-13T07:00:00.000Z', '2026-10-12T07:00:00.000Z', '2026-10-11T07:00:00.000Z']::timestamptz[], NULL::int[], 10000, 7000, 25000, 25000, 4, 0, 4),
    ('random_01', NULL, ARRAY[20,7,31,56,81,103,143,188,180,209,224,248,283,306,333,322,339,383,404,426,442,465,478,499,529,555,586,589,620,608,641,653,655,690,717,723,732,766,791,791,808,830,859], 20000, 3000, 500000, 500000, 32, 5, 37),
    ('random_02', NULL, ARRAY[20,37,63,130,126,162,184,314,398,426,455,473,501,514,565,578,607,644,672,750,875,894,922,958,1040,1061,1122,1115,1148,1131,1152,1239,1312,1299,1343,1324,1357,1415,1400,1477,1496,1512,1571,1589,1608,1717,1749,1765,1787,1839,1842,1859,1903,1938,1961], 10000, 7000, 30000000, 184000, 45, 38, 83),
    ('random_03', NULL, ARRAY[17,24,60,81,89,137,162,155,168,192,220,258,264,318,321,345,361,365,390,410,458,490,511,536,559,558,579,604,633,695,677,715,696,738,758,746,875,920,915,978,1022,1048,1073,1089,1135,1160,1188,1259,1287,1325,1342,1362,1378,1402,1417,1450,1482,1496,1488,1526,1545,1560,1644,1666,1656,1699,1753,1786,1817,1839,1842,1855,1887,1873,1923,1946,1972,2043,2074,2099,2132,2126,2174,2185,2230,2235,2274,2315,2313,2332,2367,2404,2407,2435,2458,2464,2479,2572,2593,2621,2646,2689,2719,2738,2739,2766,2778,2818,2825,2840,2832,2868,2885,2914,2946,2928], 10000, 3000, 30000000, 785000, 89, 35, 124),
    ('random_04', NULL, ARRAY[16,42,67,92,97,99,141,166], 10000, 12000, 30000000, 36000, 6, 2, 8),
    ('random_05', NULL, ARRAY[8,27,50,78,103,118,123,164,161,171,213,231,237,252,252,282,305,324,352,344,394,423,444,460,472,487,518,551,561,598,614,639,651,681,713,721,803], 1000, 3000, 500000, 0, 25, 9, 34),
    ('random_06', NULL, ARRAY[117,163,183,291,304,357,536,577,586], 10000, 12000, 30000000, 0, 8, 17, 25),
    ('random_07', NULL, ARRAY[73], 5000, 12000, 500000, 0, 1, 3, 4),
    ('random_08', NULL, ARRAY[75,97,124,155,190,215,262,264,292,305,341,352,376,399,414,452,458,458,527,542,568,591,638,660,664,678,747,794,814,818,833,861,869,887,901,904,935,936,977,986,1010,1048,1096,1104,1190,1203,1284,1277,1305,1340,1353,1366,1413,1419,1452,1469,1470,1499,1531,1549,1561,1564,1622,1641,1662,1692,1710,1769,1803,1844,1900,1928,1966,1969,2043,2093,2124,2140,2164,2205,2269,2303,2326,2351,2366,2393,2407,2425,2441,2464,2472,2504,2521,2542,2575,2608,2647,2665,2704,2714,2745,2760,2826,2842,2900,2916,2947,2971,3021,3059,3082,3110,3096,3142,3150,3173,3173,3225,3282,3302,3327,3360,3383,3409,3418,3463,3501,3492,3516,3509,3573,3614,3615,3675,3736,3765,3791,3795,3855,3906,3912,3938,3982,3991,4055,4048,4075,4091,4084,4107,4148,4151,4157,4198,4221], 5000, 7000, 30000000, 141000, 115, 62, 177),
    ('random_09', NULL, ARRAY[6,119,209,196,379,634,657,755,783,800,970,1078,1064,1098,1136,1145,1317,1338,1788,1799,1841,2018,2109,2295,2385,2389,2421,2415,2583,2779,3242], 5000, 7000, 30000000, 0, 29, 107, 136),
    ('random_10', NULL, ARRAY[56,83,192,210,227,271,376,426,472,465,526,525,556,660,675,682,731,725,759,785,809,1010,1038,1064,1098,1271,1279,1303,1335,1369,1408,1417,1418,1440,1483,1498,1533,1595,1662,1703,1705,1741,1743,1756,1788,1822,1867,1879,1883,1911,1936,1971,2009,2025,2068,2074,2168,2195,2203,2223,2242,2332,2363,2375,2392,2421,2464,2470,2648,2657,2710,2820,2925,2932,2980,3089,3088,3102], 5000, 7000, 30000000, 0, 58, 72, 130),
    ('random_11', NULL, ARRAY[22,41,396,763,1245,1256,1378], 10000, 12000, 2000000, 0, 6, 52, 58),
    ('random_12', NULL, ARRAY[10,42,71,81,115,118,132,148,183,180,199,200,250,277,299,315,371,390,423,431,461,513,541,536,554,578,601,608,667,681,716,727,748,801,833,845,871,868], 5000, 7000, 500000, 41000, 25, 12, 37),
    ('random_13', NULL, ARRAY[273,351,642,696,737,731,922,1292,1313,1551,1617,1616,1677,1677,1914,1903], 1000, 3000, 500000, 0, 14, 67, 81),
    ('random_14', NULL, ARRAY[7,20,114,117,122,302,312,320,340,380,488,499,504,541,596,625,631,693,709,790,780,821,870,897,911,937,982,983,1063,1193,1221,1318,1297,1361,1382,1424,1418,1485,1530,1645,1680,1768,1824,1883,1988,2040,2104,2152,2212,2243,2312,2454,2473,2536,2566,2558,2568,2652,2680,2710,2744,2792,2787,2815,2830,2834,2879,2894,3044,3063,3068,3096,3109,3134,3138,3154,3179,3190,3220,3368,3384,3451,3471,3492,3510,3542,3631,3673,3709,3731,3724,3820,3845,3864,3869], 10000, 12000, 30000000, 0, 76, 86, 162),
    ('random_15', NULL, ARRAY[44,63,49,93,75,107,108,141,145,147,183,221,244,273,305,303,318,342,376,375,390,430,455,474,483,522,530,533,570,604,626,645,660,692,707,720,735,764,774,809,831,833,861,897,934,913,954,1000,994,1011,1033,1057], 5000, 12000, 30000000, 38000, 34, 11, 45),
    ('random_16', NULL, ARRAY[22,40,68,87,114,129,189,231,241,281,285,322,355,339,390,412,454,457,495,484,541,553,599,627,673,698,735,756,777,810,827,875,907,935,949,972,988,985,1023,1071], 20000, 7000, 2000000, 515000, 31, 15, 46),
    ('random_17', NULL, ARRAY[20,27,26,64,70,74,107,138,150,180,202,224,249,284,301,288,324,346,360,378,412,475,504,518,554,576,661,716,708,735,761,790], 20000, 3000, 2000000, 473000, 25, 9, 34),
    ('random_18', NULL, ARRAY[18,59,100,173,213,273,328], 5000, 7000, 500000, 0, 7, 8, 15),
    ('random_19', NULL, ARRAY[51,81,93,201,209,275,333,314,424,449,500,571,593,709,753,841,884,902,890,931,1060,1068,1123,1142,1202,1264,1297,1311,1322,1387,1482,1543,1674,1659,1698,1708,1728,1840,1898,1963,1954,1975,1982,2006,2083,2085,2088,2155,2329,2412,2448,2494,2503,2520,2545,2605,2638,2648], 10000, 1000, 500000, 428000, 49, 62, 111),
    ('random_20', NULL, ARRAY[27,93,107,133,190,197,326,363,393,427,456,482,602,652,752,958,970,1010], 20000, 12000, 2000000, 0, 15, 28, 43),
    ('random_21', NULL, ARRAY[38,70,106,123,139,187,208,239,269,294,325,338,358,371,406,388,424,450,473,489,494,565,665,707,728,765,827,845,854,874,903,919,958,955,980,1025,1092,1087,1118,1149,1142,1191,1292,1308,1325,1362,1381,1482,1470,1516,1534,1557,1602,1658,1657,1702,1714,1716,1742,1744,1775,1791,1814,1892,1895,1923,1979,2001,2036,2069,2094,2095,2115,2162,2192,2209,2321,2372,2489,2547,2563,2589,2607,2673,2670,2710,2715,2739,2742,2839,2872,2862,2896,2922,2951,2969,2997,3014,3027,3065,3095,3113,3135,3173,3208,3234], 10000, 1000, 30000000, 821000, 87, 49, 136),
    ('random_22', NULL, ARRAY[3,32,81,86,114,154,180,194,333,368,365,417,446,514,529,564,583,619,645,639,667,691,740,748,745,803,801,900,1004,1026,1046,1117,1160,1152,1201,1254,1278,1317,1352,1372,1376,1392,1427,1438,1472,1505,1529,1554,1583,1564,1587,1677,1684,1715,1741,1765,1796,1857,1890,1892,1923,1960,1997,2003,2050], 10000, 12000, 30000000, 134000, 53, 33, 86),
    ('random_23', NULL, ARRAY[21,5,38,60,91,118,137,187,189,226,312,349,368,389,466,503,513,563,554,624,670,653,715,741,774,805,842,889,896,912,944,1044,1059,1101,1119,1126,1170,1264,1278,1357,1380,1414,1399,1429,1477,1505,1495,1527,1559,1575,1576,1605,1586,1629,1650,1644,1667,1699,1727,1750,1752,1785,1805,1842,1856,1848,1913,1927,1921,1963,1980,1998,2035,2045,2045,2083,2086,2121,2136,2166,2200,2240,2278,2280,2317,2306,2362,2355,2383,2403,2432,2459,2485,2498,2588,2606,2660,2680,2709,2730,2756,2790,2823,2834,2878], 5000, 7000, 2000000, 89000, 78, 43, 121),
    ('random_24', NULL, ARRAY[7,26,62,88,149,181,168,215,238,274,294,358,399,417,421,433,460,466,481,554,597,622,658,692,698,735,765,748,817,835,860,848,908,925,955,974,1045,1093,1115,1152,1175,1237,1293,1327,1356,1382,1411,1430,1481,1557,1626,1652,1695,1701,1712,1718,1761,1782,1803,1843,1865,1867,1873,1926,1972,2032,2051,2153,2251,2256,2325,2349,2388,2420,2443,2477,2487,2509,2536], 10000, 7000, 500000, 373000, 66, 41, 107)
  ) AS f(id, ts, hrs, inc, dec, mx, e_limit, e_paid, e_missed, e_tracked)
  LOOP
    v_n := v_n + 1;
    v_times := COALESCE(c.ts, (SELECT COALESCE(array_agg(v_now - h * interval '1 hour'), ARRAY[]::timestamptz[]) FROM unnest(c.hrs) AS h));
    v_calc := public._rent_access_limit_calc(v_times, v_now, c.inc, c.dec, c.mx);
    IF (v_calc->>'limit')::numeric <> c.e_limit OR (v_calc->>'paid_days')::int <> c.e_paid
       OR (v_calc->>'missed_days')::int <> c.e_missed OR (v_calc->>'tracked_days')::int <> c.e_tracked THEN
      v_bad := v_bad + 1;
      ex := ex || jsonb_build_object('case', c.id, 'server', v_calc, 'typescript', jsonb_build_array(c.e_limit, c.e_paid, c.e_missed, c.e_tracked));
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'P the server calculation equals the TypeScript on every fixture (limit, paid days, missed days, tracked days)',
    'pass', v_bad = 0 AND v_n = 36, 'detail', jsonb_build_object('fixtures', v_n, 'mismatches', v_bad, 'examples', ex));
  RAISE EXCEPTION 'ROLLED BACK REPORT (block 1): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || (e->'detail')::text, '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;

-- ===== Block 2: Q and R =====
DO $test$
DECLARE
  r jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_staff uuid; v_user uuid; v_plain uuid;
  v_p jsonb; v_ok boolean; t record; v_srv jsonb; v_exp jsonb; v_checked int := 0; v_bad int := 0; ex jsonb := '[]'::jsonb;
  v_times timestamptz[]; v_params jsonb; v_agent uuid; v_other_agent uuid; v_tenant uuid;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'operations' AND enabled LIMIT 1;
  SELECT p.id INTO v_plain FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id) LIMIT 1;

  -- Q: the parameters, as the client reads them (hook: Number(x) || default; then Math.max(0, x))
  v_p := public._rent_access_limit_params();
  r := r || jsonb_build_object('step', 'Q the live parameters are used (not the defaults)',
    'pass', (SELECT (value->>'paid_increment_ugx')::numeric = (v_p->>'paid_increment_ugx')::numeric
                AND (value->>'missed_decrement_ugx')::numeric = (v_p->>'missed_decrement_ugx')::numeric
                AND (value->>'max_limit_ugx')::numeric = (v_p->>'max_limit_ugx')::numeric
               FROM public.system_config WHERE key = 'rent_access_limit_params'), 'detail', v_p);
  UPDATE public.system_config SET value = '{"paid_increment_ugx": 0, "missed_decrement_ugx": "abc", "max_limit_ugx": null}'::jsonb WHERE key = 'rent_access_limit_params';
  v_p := public._rent_access_limit_params();
  r := r || jsonb_build_object('step', 'Q zero, non-numeric and null fall back to the defaults (10,000 / 7,000 / 30,000,000)',
    'pass', v_p = '{"paid_increment_ugx": 10000, "missed_decrement_ugx": 7000, "max_limit_ugx": 30000000}'::jsonb, 'detail', v_p);
  UPDATE public.system_config SET value = '{"paid_increment_ugx": "5000", "missed_decrement_ugx": -5, "max_limit_ugx": 1200000}'::jsonb WHERE key = 'rent_access_limit_params';
  v_p := public._rent_access_limit_params();
  r := r || jsonb_build_object('step', 'Q a numeric string is accepted and a negative value clamps to 0',
    'pass', v_p = '{"paid_increment_ugx": 5000, "missed_decrement_ugx": 0, "max_limit_ugx": 1200000}'::jsonb, 'detail', v_p);
  DELETE FROM public.system_config WHERE key = 'rent_access_limit_params';
  v_p := public._rent_access_limit_params();
  r := r || jsonb_build_object('step', 'Q with no row the defaults apply', 'pass', v_p = '{"paid_increment_ugx": 10000, "missed_decrement_ugx": 7000, "max_limit_ugx": 30000000}'::jsonb);

  -- R: the data the server gathers equals an independent recompute (changes made above are rolled back with the block, but restore the
  -- live row now so the comparison uses the real parameters)
  INSERT INTO public.system_config (key, value) VALUES ('rent_access_limit_params', '{"max_limit_ugx": 30000000, "paid_increment_ugx": 10000, "missed_decrement_ugx": 1000}'::jsonb);
  v_params := public._rent_access_limit_params();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  FOR t IN
    SELECT q.tenant_id FROM (SELECT DISTINCT ac.tenant_id FROM public.agent_collections ac WHERE ac.tenant_id IS NOT NULL) q ORDER BY md5(q.tenant_id::text) LIMIT 60
  LOOP
    v_checked := v_checked + 1;
    v_srv := public.rent_access_limit_server(t.tenant_id);
    -- independent: distinct UTC days over non-reversed collections, plus repayment rows no collection explains
    WITH pay AS (
      SELECT (ac.created_at AT TIME ZONE 'UTC')::date AS d FROM public.agent_collections ac
       WHERE ac.tenant_id = t.tenant_id AND ac.reversed_at IS NULL AND ac.amount > 0
      UNION
      SELECT (rp.created_at AT TIME ZONE 'UTC')::date FROM public.repayments rp
       WHERE rp.tenant_id = t.tenant_id AND rp.amount > 0
         AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac2 WHERE ac2.rent_request_id IS NOT DISTINCT FROM rp.rent_request_id
                            AND ac2.rent_request_id IS NOT NULL AND ac2.reversed_at IS NULL AND ac2.amount = rp.amount
                            AND ac2.created_at BETWEEN rp.created_at - interval '299 seconds' AND rp.created_at + interval '299 seconds')
    ), s AS (SELECT count(*) AS paid, min(d) AS first FROM pay)
    SELECT jsonb_build_object('paid', s.paid,
             'tracked', CASE WHEN s.paid > 0 THEN GREATEST(1, ((v_now AT TIME ZONE 'UTC')::date - s.first) + 1) ELSE 0 END)
      INTO v_exp FROM s;
    v_exp := v_exp || jsonb_build_object('limit', GREATEST(0, LEAST((v_params->>'max_limit_ugx')::numeric,
              (v_exp->>'paid')::int * (v_params->>'paid_increment_ugx')::numeric
              - GREATEST(0, (v_exp->>'tracked')::int - (v_exp->>'paid')::int) * (v_params->>'missed_decrement_ugx')::numeric)));
    IF (v_srv->>'limit')::numeric <> (v_exp->>'limit')::numeric OR (v_srv->>'paid_days')::int <> (v_exp->>'paid')::int
       OR (v_srv->>'tracked_days')::int <> (v_exp->>'tracked')::int THEN
      v_bad := v_bad + 1; ex := ex || jsonb_build_object('tenant', t.tenant_id, 'server', v_srv, 'independent', v_exp);
    END IF;
  END LOOP;
  r := r || jsonb_build_object('step', 'R the server limit equals an independent recompute for 60 real tenants', 'pass', v_bad = 0 AND v_checked = 60,
    'detail', jsonb_build_object('checked', v_checked, 'mismatches', v_bad, 'examples', ex));

  -- gate
  SELECT rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id) INTO v_tenant, v_agent
    FROM public.rent_requests rr WHERE COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL ORDER BY rr.created_at DESC LIMIT 1;
  SELECT DISTINCT COALESCE(x.assigned_agent_id, x.agent_id) INTO v_other_agent FROM public.rent_requests x
   WHERE COALESCE(x.assigned_agent_id, x.agent_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests y WHERE y.tenant_id = v_tenant AND (y.agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR y.assigned_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = COALESCE(x.assigned_agent_id, x.agent_id) AND ur.enabled AND ur.role::text IN ('agent_ops','tenant_ops','operations','manager','super_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.status = 'verified' AND (s.parent_agent_id = COALESCE(x.assigned_agent_id, x.agent_id) OR s.sub_agent_id = COALESCE(x.assigned_agent_id, x.agent_id)))
   LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  v_ok := true; BEGIN PERFORM public.rent_access_limit_server(v_tenant); EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  r := r || jsonb_build_object('step', 'R an agent of the tenant is let in', 'pass', v_ok);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_tenant, 'role', 'authenticated')::text, true);
  v_ok := true; BEGIN PERFORM public.rent_access_limit_server(v_tenant); EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  r := r || jsonb_build_object('step', 'R the tenant can read their own limit', 'pass', v_ok);
  IF v_other_agent IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_agent, 'role', 'authenticated')::text, true);
    v_ok := false; BEGIN PERFORM public.rent_access_limit_server(v_tenant); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'R an unrelated agent is refused (42501)', 'pass', v_ok);
  END IF;
  IF v_plain IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_plain, 'role', 'authenticated')::text, true);
    v_ok := false; BEGIN PERFORM public.rent_access_limit_server(v_tenant); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
    r := r || jsonb_build_object('step', 'R a user with no role and no link to the tenant is refused (42501)', 'pass', v_ok);
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := false; BEGIN PERFORM public.rent_access_limit_server(v_tenant); EXCEPTION WHEN OTHERS THEN v_ok := SQLSTATE = '42501'; END;
  r := r || jsonb_build_object('step', 'R signed-out is refused (42501)', 'pass', v_ok);
  r := r || jsonb_build_object('step', 'R anon cannot call it, authenticated can, and the internal helpers are not callable from the API',
    'pass', NOT has_function_privilege('anon', 'public.rent_access_limit_server(uuid)', 'EXECUTE')
        AND has_function_privilege('authenticated', 'public.rent_access_limit_server(uuid)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._rent_access_limit_core(uuid,timestamptz)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._rent_access_limit_calc(timestamptz[],timestamptz,numeric,numeric,numeric)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public._rent_access_limit_params()', 'EXECUTE'));
  r := r || jsonb_build_object('step', 'R the function is STABLE (it reads, never writes)',
    'pass', (SELECT provolatile FROM pg_proc WHERE proname = 'rent_access_limit_server' AND pronamespace = 'public'::regnamespace) = 's');

  RAISE EXCEPTION 'ROLLED BACK REPORT (block 2): % passed of % | failing: %', (SELECT count(*) FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'true'), jsonb_array_length(r),
    COALESCE((SELECT string_agg(e->>'step' || ' ' || COALESCE((e->'detail')::text, ''), '; ') FROM jsonb_array_elements(r) e WHERE (e->>'pass') = 'false'), 'none');
END
$test$;
