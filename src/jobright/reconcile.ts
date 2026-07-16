import { normalizeForKey } from "../text";
import type { WeekWindow, WorkSearchRow } from "../types";
import type { JobrightAppliedJob } from "./collect";

export type JobrightProposedRow = {
  kind: "conflict" | "new";
  match?: {
    actionDate: string;
    company: string;
    jobTitle: string;
    rowIndex: number;
    sourceSender: string;
    sourceSubject: string;
  };
  row: WorkSearchRow;
  rowIndex: number;
};

export type JobrightReconciliationResult = {
  added: number;
  conflicts: number;
  proposedRows: JobrightProposedRow[];
  rows: WorkSearchRow[];
  unchanged: number;
  updated: number;
};

const ACTION_TYPE = "Job application confirmation";
const JOBRIGHT_SOURCE = "Jobright";
const REVIEW_PREFIX = "REVIEW POSSIBLE DUPLICATE";
const COMPANY_NOISE = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "llc",
  "ltd",
  "the",
]);

// Rejects common Jobright metadata that should never be treated as a company.
const isCompanyMetadata = (value: string): boolean => {
  return [
    /^(mid,\s*)?senior level(,\s*lead\/staff)?$/i,
    /^lead\/staff$/i,
    /^senior level,\s*lead\/staff$/i,
    /^remote$/i,
    /^full-time$/i,
    /^united states$/i,
  ].some((pattern) => pattern.test(value.trim()));
};

// Normalizes company/title values for matching across sources.
const comparableKey = (value: string): string => {
  if (isCompanyMetadata(value)) return "";

  return normalizeForKey(value)
    .split(" ")
    .filter((token) => token && !COMPANY_NOISE.has(token))
    .join(" ");
};

// Computes a conservative token-overlap similarity check.
const similarKey = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 6 && right.length >= 6) {
    if (left.includes(right) || right.includes(left)) return true;
  }

  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;

  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  const overlap = shared.length / Math.min(leftTokens.size, rightTokens.size);
  return overlap >= 0.8;
};

// Keeps matching scoped to the selected reporting week.
const rowIsInWeek = (row: WorkSearchRow, week: WeekWindow): boolean => {
  if (
    row.claim_week_start === week.claimWeekStart &&
    row.claim_week_end === week.claimWeekEnd
  ) {
    return true;
  }

  return (
    row.action_date >= week.claimWeekStart &&
    row.action_date <= week.claimWeekEnd
  );
};

// Builds the portal-ready CSV row for a new Jobright-only application.
const toJobrightRow = (
  job: JobrightAppliedJob,
  week: WeekWindow,
  notes = "Imported from Jobright Applied tab.",
): WorkSearchRow => {
  const subject = `${job.jobTitle} at ${job.company}`;

  return {
    claim_week_start: week.claimWeekStart,
    claim_week_end: week.claimWeekEnd,
    action_date: job.appliedDate,
    action_type: ACTION_TYPE,
    company: job.company,
    job_title: job.jobTitle,
    employer_website: "",
    employer_contact: "",
    mailing_address_line_1: "",
    mailing_address_line_2: "",
    city: "",
    state: "",
    zip: "",
    source_subject: subject,
    source_sender: JOBRIGHT_SOURCE,
    source_date: job.appliedDate,
    evidence_excerpt: `Jobright Applied tab showed ${subject} as applied on ${job.appliedDateText}.`,
    source_url: job.sourceUrl,
    confidence: "0.95",
    notes,
  };
};

// Adds a note once, preserving any manual notes already present.
const appendUniqueNote = (notes: string, note: string): string => {
  if (notes.includes(note)) return notes;
  return [notes, note].filter((value) => value.trim()).join(" | ");
};

// Fills blank fields from Jobright without overwriting manual data.
const fillBlankFields = (
  row: WorkSearchRow,
  job: JobrightAppliedJob,
): { changed: boolean; row: WorkSearchRow } => {
  const nextRow = { ...row };
  let changed = false;
  const fill = (field: keyof WorkSearchRow, value: string): void => {
    if (!nextRow[field].trim() && value.trim()) {
      nextRow[field] = value;
      changed = true;
    }
  };

  fill("action_date", job.appliedDate);
  fill("company", job.company);
  fill("job_title", job.jobTitle);
  fill("source_url", job.sourceUrl);
  fill(
    "evidence_excerpt",
    `Jobright Applied tab showed ${job.jobTitle} at ${job.company} as applied on ${job.appliedDateText}.`,
  );
  fill("source_date", job.appliedDate);
  fill("confidence", "0.95");

  const matchNote = `Matched Jobright Applied tab on ${job.appliedDate}.`;
  const nextNotes = appendUniqueNote(nextRow.notes, matchNote);
  if (nextNotes !== nextRow.notes) {
    nextRow.notes = nextNotes;
    changed = true;
  }

  return { changed, row: nextRow };
};

// Finds an exact or fillable CSV match for one Jobright application.
const findMergeIndex = (
  rows: readonly WorkSearchRow[],
  job: JobrightAppliedJob,
  week: WeekWindow,
): number => {
  const jobCompany = comparableKey(job.company);
  const jobTitle = comparableKey(job.jobTitle);

  return rows.findIndex((row) => {
    if (!rowIsInWeek(row, week)) return false;
    if (row.action_date && row.action_date !== job.appliedDate) return false;

    const rowCompany = comparableKey(row.company);
    const rowTitle = comparableKey(row.job_title);
    const exact =
      rowCompany &&
      rowTitle &&
      rowCompany === jobCompany &&
      rowTitle === jobTitle;
    const fillsMissingTitle =
      rowCompany && rowCompany === jobCompany && !row.job_title.trim();
    const fillsMissingCompany =
      rowTitle && rowTitle === jobTitle && !row.company.trim();

    return Boolean(exact || fillsMissingTitle || fillsMissingCompany);
  });
};

// Finds the strongest likely duplicate that should be reviewed.
const findConflictIndex = (
  rows: readonly WorkSearchRow[],
  job: JobrightAppliedJob,
  week: WeekWindow,
): number => {
  const jobCompany = comparableKey(job.company);
  const jobTitle = comparableKey(job.jobTitle);
  let bestIndex = -1;
  let bestScore = 0;

  rows.forEach((row, index) => {
    if (!rowIsInWeek(row, week)) return;

    const rowCompany = comparableKey(row.company);
    const rowTitle = comparableKey(row.job_title);
    const companyMatch = similarKey(rowCompany, jobCompany);
    const titleMatch = similarKey(rowTitle, jobTitle);
    const sameDate = row.action_date === job.appliedDate;
    const missingCompany = !rowCompany || !jobCompany;
    if (!companyMatch && !(missingCompany && sameDate && titleMatch)) return;

    const score =
      (companyMatch ? 8 : 0) + (sameDate ? 4 : 0) + (titleMatch ? 2 : 0);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });

  return bestIndex;
};

// Merges Jobright jobs into the existing CSV row set.
export const reconcileJobrightJobs = (
  existingRows: readonly WorkSearchRow[],
  jobs: readonly JobrightAppliedJob[],
  week: WeekWindow,
): JobrightReconciliationResult => {
  const rows = existingRows.map((row) => ({ ...row }));
  const result: JobrightReconciliationResult = {
    added: 0,
    conflicts: 0,
    rows,
    unchanged: 0,
    updated: 0,
    proposedRows: [],
  };

  for (const job of jobs) {
    const mergeIndex = findMergeIndex(rows, job, week);
    if (mergeIndex >= 0) {
      const merge = fillBlankFields(rows[mergeIndex], job);
      rows[mergeIndex] = merge.row;
      if (merge.changed) {
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
    } else {
      const conflictIndex = findConflictIndex(rows, job, week);
      if (conflictIndex >= 0) {
        const existing = rows[conflictIndex];
        const row = toJobrightRow(
          job,
          week,
          `${REVIEW_PREFIX}: may match existing CSV row "${existing.job_title || existing.source_subject}" for ${existing.company || "unknown company"} on ${existing.action_date || job.appliedDate}. Imported from Jobright Applied tab.`,
        );
        rows.push(row);
        result.proposedRows.push({
          kind: "conflict",
          match: {
            actionDate: existing.action_date,
            company: existing.company,
            jobTitle: existing.job_title,
            rowIndex: conflictIndex,
            sourceSender: existing.source_sender,
            sourceSubject: existing.source_subject,
          },
          row,
          rowIndex: rows.length - 1,
        });
        result.conflicts += 1;
      } else {
        const row = toJobrightRow(job, week);
        rows.push(row);
        result.proposedRows.push({
          kind: "new",
          row,
          rowIndex: rows.length - 1,
        });
        result.added += 1;
      }
    }
  }

  return result;
};
