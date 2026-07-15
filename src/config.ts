import path from "node:path";
export const DEFAULT_OUTPUT_PATH = path.resolve(
  "/Users/paulterhaar/PROJECTS/jobhunt-26/work-search-reporter/outputs/idaho_work_search_log.csv",
);

export const CSV_COLUMNS = [
  "claim_week_start",
  "claim_week_end",
  "action_date",
  "action_type",
  "company",
  "job_title",
  "how_applied",
  "employer_website",
  "employer_contact",
  "mailing_address_line_1",
  "mailing_address_line_2",
  "city",
  "state",
  "zip",
  "source_subject",
  "source_sender",
  "source_date",
  "evidence_excerpt",
  "source_url",
  "confidence",
  "notes",
] as const;

export const CANDIDATE_TERMS = [
  "application",
  "applying",
  "applied",
  "thank you for applying",
  "thank you for your application",
  "interview",
  "assessment",
  "resume",
  "cover letter",
  "we received your",
  "your candidacy",
] as const;

export const DEFAULT_EXTRACT_MODEL =
  process.env.OPENAI_EXTRACT_MODEL || "gpt-5.6";
export const DEFAULT_ENRICH_MODEL =
  process.env.OPENAI_ENRICH_MODEL || "gpt-5.6";
