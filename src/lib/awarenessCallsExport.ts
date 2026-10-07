import { downloadCsv } from '@/lib/csvExport';
import { kampalaYmd } from '@/lib/kampalaDays';
import { downloadXlsxWorkbook, type XlsxSheet } from '@/lib/xlsxExport';
import {
  LABEL_30M_ACCESS, LABEL_EXPLAINED, LABEL_SELF_PAYMENT, SUBJECT_LABEL, TEAM_LABEL, awarenessLabel, callResultLabel, explainedLabel, stageLabel,
} from '@/lib/awarenessCallLabels';
import { ANSWER_FILTER_OPTIONS, kampalaDate, kampalaDateTime, statusLabel } from '@/lib/awarenessMonitoringLabels';
import type { AwarenessFilters, AwarenessLogRow } from '@/hooks/useAwarenessMonitoring';

/** Export of the awareness call log: one row per call, in words, with Kampala times. */

export const AWARENESS_LOG_HEADERS = [
  'Day (Kampala)', 'Dialled (Kampala)', 'Recorded (Kampala)', 'Rent Plan', 'Person type', 'Person', 'Phone',
  'Caller', 'Caller team', 'Stage at the call', 'Rent Plan status now', 'Region', 'Call result',
  LABEL_30M_ACCESS, LABEL_SELF_PAYMENT, LABEL_EXPLAINED, 'Note',
];

export function awarenessLogRows(rows: AwarenessLogRow[]): (string | number)[][] {
  return rows.map((r) => [
    kampalaDate(r.day),
    kampalaDateTime(r.dial_started_at),
    kampalaDateTime(r.recorded_at),
    r.plan_code,
    SUBJECT_LABEL[r.subject_type] ?? r.subject_type,
    r.subject_name,
    r.subject_phone,
    r.caller_name,
    TEAM_LABEL[r.caller_team] ?? r.caller_team,
    stageLabel(r.pipeline_stage),
    statusLabel(r.current_status),
    r.region ?? '',
    callResultLabel(r.call_result),
    r.aware_30m ? awarenessLabel(r.aware_30m) : '',
    r.aware_merchant_codes ? awarenessLabel(r.aware_merchant_codes) : '',
    r.explained ? explainedLabel(r.explained) : '',
    r.note ?? '',
  ]);
}

/** The filters in words, for the file's own record of what it contains. */
export function describeAwarenessFilters(f: AwarenessFilters, callerName?: string | null): [string, string][] {
  return [
    ['From', kampalaDate(f.startIso)],
    ['To', kampalaDate(f.endIso)],
    ['Team', f.team ? TEAM_LABEL[f.team] : 'All teams'],
    ['Caller', f.caller ? callerName || f.caller : 'All callers'],
    ['Person type', f.subjectType ? SUBJECT_LABEL[f.subjectType] : 'All'],
    ['Call result', f.result ? callResultLabel(f.result) : 'All'],
    ['Answer choice', f.answer ? ANSWER_FILTER_OPTIONS.find((o) => o.value === f.answer)?.label ?? f.answer : 'Any'],
    ['Region', f.region ?? 'All'],
    ['District', f.district ?? 'All'],
    ['Rent Plan status now', f.status ? statusLabel(f.status) : 'All'],
  ];
}

const stamp = (f: AwarenessFilters) => `${kampalaYmd(f.startIso)}_${kampalaYmd(f.endIso)}`;

export function exportAwarenessLogCsv(rows: AwarenessLogRow[], f: AwarenessFilters) {
  downloadCsv(`Welile_Awareness_Calls_${stamp(f)}.csv`, AWARENESS_LOG_HEADERS, awarenessLogRows(rows));
}

export async function exportAwarenessLogXlsx(rows: AwarenessLogRow[], f: AwarenessFilters, callerName?: string | null) {
  const info: XlsxSheet = {
    name: 'Filters',
    headers: ['Filter', 'Value'],
    rows: [
      ['Report', 'Welile awareness calls: call log'],
      ...describeAwarenessFilters(f, callerName),
      ['Calls in this file', rows.length],
      ['Times shown in', 'Kampala (EAT, UTC+3)'],
    ],
  };
  const log: XlsxSheet = { name: 'Call log', headers: AWARENESS_LOG_HEADERS, rows: awarenessLogRows(rows) };
  await downloadXlsxWorkbook(`Welile_Awareness_Calls_${stamp(f)}.xlsx`, [log, info]);
}
