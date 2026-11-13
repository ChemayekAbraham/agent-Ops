/** E96 shapes read from the live _ops_map_payload and _desk_stage_flow_data, for tests. */
/* The live E96 shapes (read from _ops_map_payload and _desk_stage_flow_data). */
export const STAGES = [
  { ord: '0', desk: 'field-agents', stage: 'Submitted', waiting: null, waiting_ugx: 0, done_24h: 7, per_day_7d: 6.9, days_to_clear: null },
  { ord: '1', desk: 'service-centre', stage: 'Service Centre', waiting: 221, waiting_ugx: 42216032, done_24h: 0, per_day_7d: 6.9, days_to_clear: 32.2 },
  { ord: '2', desk: 'agent-ops', stage: 'Agent Ops', waiting: 0, waiting_ugx: 0, done_24h: 40, per_day_7d: 16.3, days_to_clear: 0 },
  { ord: '3', desk: 'tenant-ops', stage: 'Tenant Ops', waiting: 0, waiting_ugx: 0, done_24h: 99, per_day_7d: 21.3, days_to_clear: 0 },
  { ord: '4', desk: 'landlord-ops', stage: 'Landlord Ops', waiting: 0, waiting_ugx: 0, done_24h: 16, per_day_7d: 7, days_to_clear: 0 },
  { ord: '5', desk: 'coo', stage: 'COO approval', waiting: 14, waiting_ugx: 12400000, done_24h: 0, per_day_7d: 18.6, days_to_clear: 0.8 },
  { ord: '6', desk: 'cfo', stage: 'Funders dashboard', waiting: 34, waiting_ugx: 19350000, done_24h: 0, per_day_7d: 2.6, days_to_clear: 13.2 },
  { ord: '7', desk: 'cfo', stage: 'Selected, waiting', waiting: 5, waiting_ugx: 1430000, done_24h: 0, per_day_7d: 1.9, days_to_clear: 2.7 },
];
export const MAP = {
  readiness: 'red',
  readiness_rule: 'red: money with an agent 3+ days or a desk 3+ days to clear; amber: 1+ day; else green',
  as_of: '2026-11-13T08:00:00Z',
  names: true,
  kpis: { sold_today: { n: 8, ugx: 4450000 }, selected: { n: 5, ugx: 1430000, oldest_hours: 184.4 }, on_board: { n: 34, ugx: 19350000 }, in_desks: 3814, repaying: 983, arrears_pings_today: 213, agents_active_60d: 145, agents_frozen: 77 },
  layers: {
    sold: [{ lat: 0.33, lng: 31.73, ugx: 1000000, hours: 30, tenant: 'Sold Sara', agent: 'Agent A', funder: 'Funder F', landlord: 'Landlord L', area: 'Masaka' }],
    selected: [
      { lat: 0.0993199, lng: 32.4988485, ugx: 300000, area: 'Katabi Town Council', agent: 'M. Magezi', hours: 184.4, funder: 'B. Muhanguzi', tenant: 'Nakiyinji Zaitun', landlord: 'Landlord K', agent_lat: 0.31, agent_lng: 32.58, phone: '0700111222' },
      { lat: 1.2, lng: 33.1, ugx: 150000, hours: 5, tenant: null, agent: null, funder: null, landlord: null, agent_lat: null, agent_lng: null },
      { lat: 0, lng: 0, ugx: 1 },
      { lat: 'x', lng: 32 },
    ],
    on_board: [{ lat: 1.1283969, lng: 33.3565635, ugx: 100000, area: 'Irundu' }],
    desks: [{ n: 1, lat: 0.41, lng: 32.49 }, { n: 0, lat: 0.4, lng: 32.4 }],
    repaying: [{ n: 22, lat: -0.32, lng: 31.76 }],
    arrears_today: [],
    agents: [{ lat: 0.3670478, lng: 32.5762828, name: null, frozen: false }, { lat: 0.5, lng: 32.9, name: 'Paul Okello', frozen: true }],
    empty_houses: [{ n: 172, lat: 0.6, lng: 33.7 }, { n: 28, lat: 0.7, lng: 33.6 }],
  },
  money_in_motion: [
    { ugx: 130000, hours: 6, tenant: 'Both Alex', funder: 'J. Wanda', agent: 'N. Mellon', landlord: null },
    { ugx: 200000, hours: 36, tenant: 'Nakiyinji Zaitun', funder: 'Byaruhanga Muhanguzi', agent: 'Moses Magezi', landlord: null },
    { ugx: 150000, hours: 80, tenant: null, funder: null, agent: null, landlord: null },
  ],
  alerts: [
    { kind: 'FIELD FORCE', rank: 4, text: '77 agents frozen below 50% collection', severity: 'medium' },
    { kind: 'BOTTLENECK', rank: 2, text: 'Service Centre: 221 waiting · 32.2 days to clear', severity: 'high' },
    { kind: 'MONEY', rank: 1, text: '20 old Welile-float plans still with agents', severity: 'critical' },
    { kind: 'LANDLORD NOT PAID', rank: 3, text: '5 selected tenants wait', severity: 'high' },
    { kind: 'WHAT', rank: 0, text: 'unknown severity', severity: 'cosmic' },
  ],
  coverage: { desks: { gps: 3811, excluded_legacy_kigishu: 3012 }, repaying: { gps: 727, total: 983 }, agents_with_base: 96 },
};
export const STAGES_RAW = STAGES;
