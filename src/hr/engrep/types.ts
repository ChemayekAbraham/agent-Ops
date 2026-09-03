/**
 * ENGREP — Engineering Contribution Report types.
 *
 * Shapes only. No business rules, no banding logic, no arithmetic, no thresholds.
 */

export type EngrepGranularity = 'day' | 'week' | 'month';

export type EngrepWindowStatus = 'open' | 'locked';

export type EngrepSource = 'lovable_edit' | 'external_commit';

export type EngrepLiveness = 'yes' | 'no' | 'na';

/** The only two verdicts engrep_set_liveness accepts. */
export type EngrepLivenessVerdict = 'yes' | 'no';

export type EngrepBand = 'w1' | 'w2' | 'w3' | 'w4' | 'w5';

export interface EngrepWindow {
  id: string;
  granularity: EngrepGranularity;
  period_start: string;
  period_end: string;
  status: EngrepWindowStatus;
  harvested_at: string | null;
  locked_at: string | null;
}

export interface EngrepWindowSummary {
  window_id: string;
  granularity: EngrepGranularity;
  period_start: string;
  period_end: string;
  status: EngrepWindowStatus;
  harvested_at: string | null;
  locked_at: string | null;
  lovable_edits: number;
  external_commits: number;
  claiming_schema: number;
  live_verified: number;
  untagged: number;
  fenced_breaches: number;
  self_fixes: number;
  zeroed: number;
  unadjudicated: number;
  distinct_author_emails: number;
}

export interface EngrepRow {
  id: string;
  window_id: string;
  source: EngrepSource;
  engineer_code: string | null;
  engineer_id: string | null;
  author_email: string | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  commit_subject: string | null;
  change_classes: string[] | null;
  claims_schema: boolean;
  claimed_objects: string[];
  migration_bearing: boolean;
  live_verified: EngrepLiveness;
  untagged: boolean;
  fenced_breach: boolean;
  fence_path: string | null;
  self_fix: boolean;
  self_fix_of: string | null;
  zeroed: boolean;
  zero_reason: string | null;
  harvested_at: string | null;
  band: EngrepBand | null;
  basis: string | null;
  adjudicated_by: string | null;
  adjudicated_at: string | null;
}

export interface EngrepClaimedNotLive {
  row_id: string;
  window_id: string;
  source: EngrepSource;
  engineer_code: string | null;
  author_email: string | null;
  evidence_kind: string | null;
  evidence_ref: string | null;
  commit_subject: string | null;
  change_classes: string[] | null;
  migration_bearing: boolean;
  zero_reason: string | null;
}

export interface EngrepUnclaimedObject {
  id: string;
  window_id: string;
  object_kind: string;
  object_key: string;
  change: string | null;
  detected_at: string;
  investigated_at: string | null;
  investigated_by: string | null;
  note: string | null;
}

export interface EngrepIngestInput {
  windowId: string;
  source: EngrepSource;
  evidenceRef: string;
  commitSubject: string;
  changeClasses?: string[];
  engineerCode?: string | null;
  authorEmail?: string | null;
  claimsSchema?: boolean;
  migrationBearing?: boolean;
  untagged?: boolean;
  fencedBreach?: boolean;
  fencePath?: string | null;
  selfFix?: boolean;
  selfFixOf?: string | null;
  claimedObjects?: string[];
}
