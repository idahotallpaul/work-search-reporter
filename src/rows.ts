import { normalizeForKey, truncate } from "./text";
import type {
  CandidateMessage,
  EnrichedEmployer,
  ExtractedAction,
  WeekWindow,
  WorkSearchRow,
} from "./types";

const normalizeSourceDate = (value: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
};

// Builds the source identity that an email-derived row will write to the CSV.
export const candidateSourceRowKey = (candidate: CandidateMessage): string => {
  return normalizeForKey(
    `${candidate.subject}|${candidate.sender}|${normalizeSourceDate(
      candidate.dateReceived || candidate.dateSent,
    )}`,
  );
};

// Reads the source identity from an existing CSV row.
export const rowSourceKey = (row: WorkSearchRow): string => {
  return normalizeForKey(
    `${row.source_subject}|${row.source_sender}|${row.source_date}`,
  );
};

// Combines extraction and enrichment output into one portal-ready CSV row.
export const toWorkSearchRow = (
  week: WeekWindow,
  candidate: CandidateMessage,
  action: ExtractedAction,
  enrichment: EnrichedEmployer,
): WorkSearchRow => {
  // Extraction confidence matters more than enrichment confidence.
  const combinedConfidence = Math.max(
    0,
    Math.min(
      1,
      (action.confidence || 0) * 0.75 + (enrichment.confidence || 0) * 0.25,
    ),
  );

  const notes = [action.notes, enrichment.notes]
    .filter((note) => note && note.trim() !== "")
    .join(" | ");

  return {
    claim_week_start: week.claimWeekStart,
    claim_week_end: week.claimWeekEnd,
    action_date: action.action_date,
    action_type: action.action_type,
    company: action.company,
    job_title: action.job_title,
    employer_website: enrichment.employer_website,
    employer_contact: enrichment.employer_contact,
    mailing_address_line_1: enrichment.mailing_address_line_1,
    mailing_address_line_2: enrichment.mailing_address_line_2,
    city: enrichment.city,
    state: enrichment.state,
    zip: enrichment.zip,
    source_subject: candidate.subject,
    source_sender: candidate.sender,
    source_date: normalizeSourceDate(
      candidate.dateReceived || candidate.dateSent,
    ),
    evidence_excerpt: truncate(
      action.evidence_excerpt || candidate.evidenceExcerpt,
      700,
    ),
    source_url: enrichment.source_url,
    confidence: combinedConfidence.toFixed(2),
    notes,
  };
};

// Builds the duplicate key used across existing and newly collected rows.
export const rowDedupeKey = (row: WorkSearchRow): string => {
  // Source email identity is preferred because company/title can be edited.
  const sourceKey = rowSourceKey(row);
  if (sourceKey) return sourceKey;

  return normalizeForKey(
    `${row.claim_week_start}|${row.action_date}|${row.company}|${row.job_title}|${row.action_type}`,
  );
};

// Keeps only rows not already present in the CSV or this collection run.
export const filterNewRows = (
  existingRows: readonly WorkSearchRow[],
  candidateRows: readonly WorkSearchRow[],
): WorkSearchRow[] => {
  const existingKeys = new Set(existingRows.map(rowDedupeKey));
  const seenThisRun = new Set<string>();
  const newRows: WorkSearchRow[] = [];

  for (const row of candidateRows) {
    const key = rowDedupeKey(row);
    if (!existingKeys.has(key) && !seenThisRun.has(key)) {
      seenThisRun.add(key);
      newRows.push(row);
    }
  }

  return newRows;
};
