import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { readRows, writeRowsWithBackup } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { enrichEmployerRow } from "./openai/enrich";
import type { EnrichedEmployer, WeekWindow, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

// Triggers lookup only when a report-critical mailing address field is missing.
const shouldEnrich = (row: WorkSearchRow): boolean => {
  if (!row.company.trim()) return false;

  return [row.mailing_address_line_1, row.city, row.state, row.zip].some(
    (value) => !value.trim(),
  );
};

// Keeps enrichment scoped to the claim week selected in the menu.
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

// Keeps the strongest confidence score after enrichment.
const mergeConfidence = (
  existing: string,
  enrichmentConfidence: number,
): string => {
  const current = Number(existing);
  if (!Number.isFinite(current)) return enrichmentConfidence.toFixed(2);
  if (!enrichmentConfidence) return existing;
  return Math.max(current, enrichmentConfidence).toFixed(2);
};

// Merges discovered employer details into one existing CSV row.
const applyEnrichment = (
  row: WorkSearchRow,
  enrichment: EnrichedEmployer,
): WorkSearchRow => {
  const notes = [row.notes, enrichment.notes]
    .filter((note) => note?.trim())
    .join(" | ");

  return {
    ...row,
    employer_website: enrichment.employer_website || row.employer_website,
    employer_contact: enrichment.employer_contact || row.employer_contact,
    mailing_address_line_1:
      enrichment.mailing_address_line_1 || row.mailing_address_line_1,
    mailing_address_line_2:
      enrichment.mailing_address_line_2 || row.mailing_address_line_2,
    city: enrichment.city || row.city,
    state: enrichment.state || row.state,
    zip: enrichment.zip || row.zip,
    source_url: enrichment.source_url || row.source_url,
    confidence: mergeConfidence(row.confidence, enrichment.confidence),
    notes,
  };
};

// Runs async work over a list without launching every lookup at once.
const runWithConcurrency = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    },
  );

  await Promise.all(workers);
};

// Blocks old flag-based usage so weekly runs go through the menu.
const assertNoArgs = (): void => {
  if (process.argv.length > 2) {
    throw new Error("This command does not take flags. Run pnpm start.");
  }
};

// Fills missing employer fields for eligible rows in the active claim week.
const main = async (): Promise<void> => {
  assertNoArgs();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to .env before fetching missing company data.",
    );
  }

  const activeWeek = process.env.WORK_SEARCH_WEEK_START
    ? getWeekFromStart(process.env.WORK_SEARCH_WEEK_START)
    : getLastCompletedSundayWeek();

  const rows = await readRows(DEFAULT_OUTPUT_PATH);
  if (rows.length === 0) {
    console.log(`No CSV entries found at ${DEFAULT_OUTPUT_PATH}.`);
    return;
  }

  const targets = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => rowIsInWeek(row, activeWeek) && shouldEnrich(row));

  if (targets.length === 0) {
    console.log(
      `No entries with missing company data found for ${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd}.`,
    );
    return;
  }

  console.log(
    `Fetching missing company data for ${targets.length} entr${targets.length === 1 ? "y" : "ies"} in ${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd} with concurrency 2.`,
  );

  const updatedRows = [...rows];
  await runWithConcurrency(targets, 2, async ({ row, index }) => {
    console.log(
      `Fetching company data: ${row.company || "(missing company)"} ${row.job_title ? `- ${row.job_title}` : ""}`,
    );
    const enrichment = await enrichEmployerRow(row, apiKey);
    updatedRows[index] = applyEnrichment(row, enrichment);
  });

  await writeRowsWithBackup(
    DEFAULT_OUTPUT_PATH,
    path.resolve(__dirname, "..", "backups"),
    updatedRows,
  );
  console.log(
    `Updated ${targets.length} entr${targets.length === 1 ? "y" : "ies"} in ${DEFAULT_OUTPUT_PATH}.`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
