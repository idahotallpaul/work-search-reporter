import path from "node:path";

export const DEFAULT_OUTPUT_PATH = path.resolve(
  "/Users/paulterhaar/PROJECTS/jobhunt-26/work-search-reporter/outputs/idaho_work_search_log.csv",
);
export const DEFAULT_PROCESSED_EMAIL_CACHE_PATH = path.resolve(
  "/Users/paulterhaar/PROJECTS/jobhunt-26/work-search-reporter/cache/processed-email-extractions.json",
);
export const DEFAULT_OPENAI_USAGE_LOG_PATH = path.resolve(
  "/Users/paulterhaar/PROJECTS/jobhunt-26/work-search-reporter/cache/openai-usage-log.jsonl",
);

export const CSV_COLUMNS = [
  "claim_week_start",
  "claim_week_end",
  "action_date",
  "action_type",
  "company",
  "job_title",
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

export const APPLICATION_SEARCH_TERMS = [
  "application",
  "applied",
  "applying",
  "applicant",
  "candidacy",
  "candidate",
] as const;

export const APPLICATION_EVIDENCE_PHRASES = [
  "thank you for applying",
  "thank you for your application",
  "interview",
  "assessment",
  "resume",
  "cover letter",
  "we received your",
  "your candidacy",
] as const;

export const CANDIDATE_TERMS = [
  ...APPLICATION_SEARCH_TERMS,
  ...APPLICATION_EVIDENCE_PHRASES,
] as const;

export const DEFAULT_EXTRACT_MODEL =
  process.env.OPENAI_EXTRACT_MODEL || "gpt-5.6-luna";
export const DEFAULT_ENRICH_MODEL =
  process.env.OPENAI_ENRICH_MODEL || "gpt-5.6-terra";

export const DEFAULT_OPENAI_EXTRACT_BATCH_SIZE = 10;
export const DEFAULT_OPENAI_ENRICH_CONCURRENCY = 2;
export const LARGE_EXTRACTION_RUN_EMAIL_COUNT = 20;
export const LARGE_ENRICHMENT_RUN_ROW_COUNT = 5;
