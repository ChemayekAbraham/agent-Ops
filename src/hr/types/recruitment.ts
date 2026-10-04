/**
 * HR data contracts — Recruitment
 * Part of the HR module contract. Do not add, rename or remove fields.
 */

/**
 * NOTE: this is NOT the existing /hr/dashboard/requisitions module, which is
 * Director funding approval (UGX amounts). This is headcount.
 */

export interface HiringRequisition {
  id: string;
  ref: string;                       // HREQ-00001
  job_title: string;
  department_id: string;
  headcount: number;
  employment_type: 'permanent' | 'contract' | 'intern' | 'probation';
  justification: string;
  requested_by_employee_id: string;
  status: 'pending' | 'more_info' | 'approved' | 'rejected';
  approver_employee_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export interface JobPosting {
  id: string;
  requisition_id: string | null;
  title: string;
  department_id: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  location: string;
  employment_type: 'permanent' | 'contract' | 'intern' | 'probation';
  rubric_id: string | null;
  status: 'draft' | 'open' | 'closed';
  opens_at: string | null;
  closes_at: string | null;
  public_slug: string;
  application_count: number;
}

export type CandidateSource =
  | 'career_page'
  | 'referral'
  | 'talent_pool'
  | 'work_sample'
  | 'import';

/** One person, one identity. A hired candidate keeps this record forever. */
export interface Candidate {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  location: string;
  source: CandidateSource;
  referred_by_employee_id: string | null;
  consent_at: string;
  retention_until: string;
  /** Set when hired. Links to the Employee record. Never a second identity. */
  linked_employee_id: string | null;
  created_at: string;
}

export type ApplicationStage =
  | 'received'
  | 'screening'
  | 'shortlisted'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'withdrawn';

/** AI output. Structured, confidence-flagged, and ALWAYS human-editable. */
export interface ExtractedProfile {
  years_experience: number | null;
  education_level: string | null;
  institutions: string[];
  skills: string[];
  last_role: string | null;
  last_employer: string | null;
  months_in_last_role: number | null;
  languages: string[];
  certifications: string[];
  extraction_model: string;
  extracted_at: string;
  /** Fields the model was unsure about. UI must surface these for review. */
  confidence_flags: string[];
}

export interface CriterionScore {
  criterion_id: string;
  label: string;
  points: number;
  max_points: number;
  /** The literal fact from inputs_snapshot that produced these points. */
  evidence: string;
}

/**
 * The scoring contract. All six groups are REQUIRED.
 * A score without them is a bug, not a feature request.
 */
export interface Score {
  id: string;
  application_id: string;
  rubric_id: string;
  rubric_version: number;
  total_points: number;
  max_points: number;
  percentage: number;
  criterion_scores: CriterionScore[];
  /** Immutable copy of the fields the rules ran on. */
  inputs_snapshot: Record<string, string | number | boolean | null>;
  computed_at: string;
  /** The named human who confirmed the resulting decision. */
  decided_by_employee_id: string | null;
  decided_at: string | null;
  /** Drafted FOR a score already computed. The LLM never produces the number. */
  rationale_text: string | null;
  rationale_model: string | null;
  rationale_generated_at: string | null;
}

export interface Application {
  id: string;
  ref: string;                       // APP-00001
  candidate_id: string;
  job_posting_id: string;
  cv_file_url: string | null;
  cover_note: string | null;
  stage: ApplicationStage;
  stage_changed_at: string;
  /**
   * Shortlist level reached: 1, 2 or 3. Only meaningful while the status is
   * `shortlisted`, and kept on held or declined rows so the level a person
   * reached is never lost. Null on rows that were never shortlisted.
   */
  shortlist_round?: number | null;
  decided_by_employee_id: string | null;
  decision_reason: string | null;
  extraction_status: 'pending' | 'done' | 'failed' | 'manual';
  extracted: ExtractedProfile | null;
  score: Score | null;
  created_at: string;
}

export type RubricRuleType = 'threshold' | 'range' | 'boolean' | 'manual';

export interface RubricCriterion {
  id: string;
  key: string;
  label: string;
  description: string;
  weight: number;
  max_points: number;
  rule_type: RubricRuleType;
  /** e.g. { min: 24, unit: 'months' } — deterministic, human-readable. */
  rule_config: Record<string, string | number | boolean>;
  /** Which ExtractedProfile field feeds this rule. 'manual' for human-scored. */
  source_field: string;
}

export interface Rubric {
  id: string;
  name: string;
  job_family: string;
  version: number;
  active: boolean;
  criteria: RubricCriterion[];
  created_by_employee_id: string;
  created_at: string;
}
