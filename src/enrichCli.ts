import path from "node:path";

import dotenv from "dotenv";

import {
  DEFAULT_ENRICH_MODEL,
  DEFAULT_OPENAI_ENRICH_CONCURRENCY,
  DEFAULT_OUTPUT_PATH,
  LARGE_ENRICHMENT_RUN_ROW_COUNT,
} from "./config";
import { readRows, writeRowsWithBackup } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import type { OpenAiUsage } from "./openai/client";
import { enrichEmployerRow } from "./openai/enrich";
import {
  estimateTokensFromCharacters,
  printOpenAiUsageSummary,
  writeOpenAiUsageLog,
} from "./storage/openaiUsage";
import type { EnrichedEmployer, WeekWindow, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

type SavedField = {
  label: string;
  value: string;
};

type EnrichmentSummary = {
  missingAddressFields: string[];
  notes: string;
  savedFields: SavedField[];
};

const reportedFields = [
  ["employer_website", "Website"],
  ["employer_contact", "Contact"],
  ["mailing_address_line_1", "Address line 1"],
  ["mailing_address_line_2", "Address line 2"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
  ["source_url", "Source URL"],
] as const satisfies readonly (readonly [keyof WorkSearchRow, string])[];

const addressFields = [
  ["mailing_address_line_1", "Address line 1"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "ZIP"],
] as const satisfies readonly (readonly [keyof WorkSearchRow, string])[];

// Avoid repeat paid lookups for rows already marked as not findable.
const hasNoReliableAddressNote = (row: WorkSearchRow): boolean => {
  const notes = row.notes.toLowerCase();

  return [
    "no reliable address",
    "no reliable employer mailing address",
    "did not find a complete",
    "no complete high-confidence mailing address",
  ].some((phrase) => notes.includes(phrase));
};

// Triggers lookup only when a report-critical mailing address field is missing.
const shouldEnrich = (row: WorkSearchRow): boolean => {
  if (!row.company.trim()) return false;
  if (hasNoReliableAddressNote(row)) return false;

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

const summarizeEnrichment = (
  before: WorkSearchRow,
  after: WorkSearchRow,
): EnrichmentSummary => {
  const savedFields = reportedFields.flatMap(([key, label]): SavedField[] => {
    const beforeValue = before[key].trim();
    const afterValue = after[key].trim();

    if (afterValue && afterValue !== beforeValue) {
      return [{ label, value: afterValue }];
    }

    return [];
  });
  const missingAddressFields = addressFields.flatMap(
    ([key, label]): string[] => {
      return after[key].trim() ? [] : [label];
    },
  );
  const notes =
    after.notes.trim() && after.notes.trim() !== before.notes.trim()
      ? after.notes.trim()
      : "";

  return {
    missingAddressFields,
    notes,
    savedFields,
  };
};

const printEnrichmentSummary = (
  row: WorkSearchRow,
  summary: EnrichmentSummary,
): void => {
  const label = `${row.company || "(missing company)"}${row.job_title ? ` - ${row.job_title}` : ""}`;

  console.log(`Result: ${label}`);

  if (summary.savedFields.length > 0) {
    console.log("  Saved to CSV:");
    for (const field of summary.savedFields) {
      console.log(`  - ${field.label}: ${field.value}`);
    }
  } else {
    console.log("  Saved to CSV: no new fields");
  }

  if (summary.missingAddressFields.length > 0) {
    console.log(`  Still missing: ${summary.missingAddressFields.join(", ")}`);
  } else {
    console.log("  Still missing: none of the required address fields");
  }

  if (summary.notes) {
    console.log(`  Notes: ${summary.notes}`);
  }
};

// Estimates request size without writing row contents to the usage log.
const approximateEnrichmentInputCharacters = (
  rows: readonly WorkSearchRow[],
): number => {
  const staticPromptCharacters = 900;

  return rows.reduce((total, row) => {
    return (
      total +
      staticPromptCharacters +
      row.company.length +
      row.job_title.length +
      row.employer_website.length +
      row.source_url.length
    );
  }, 0);
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

  const targetRows = targets.map(({ row }) => row);
  const approximateInputCharacters =
    approximateEnrichmentInputCharacters(targetRows);
  const approximateInputTokens = estimateTokensFromCharacters(
    approximateInputCharacters,
  );

  console.log("OpenAI enrichment preflight:");
  console.log(`- Model: ${DEFAULT_ENRICH_MODEL}`);
  console.log(
    `- Missing-address rows: ${targets.length} in ${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd}`,
  );
  console.log(`- Concurrency: ${DEFAULT_OPENAI_ENRICH_CONCURRENCY}`);
  console.log(
    `- Approximate input size: ${approximateInputCharacters} character(s), roughly ${approximateInputTokens} token(s)`,
  );
  console.log("- Companies:");
  for (const { row } of targets) {
    console.log(
      `  - ${row.company}${row.job_title ? ` - ${row.job_title}` : ""}`,
    );
  }
  if (targets.length > LARGE_ENRICHMENT_RUN_ROW_COUNT) {
    console.log(
      `- Warning: this is larger than the normal ${LARGE_ENRICHMENT_RUN_ROW_COUNT}-row threshold.`,
    );
  }

  console.log(
    `Fetching missing company data for ${targets.length} entr${targets.length === 1 ? "y" : "ies"}.`,
  );

  const updatedRows = [...rows];
  const summaries: EnrichmentSummary[] = [];
  const usages: OpenAiUsage[] = [];
  await runWithConcurrency(
    targets,
    DEFAULT_OPENAI_ENRICH_CONCURRENCY,
    async ({ row, index }) => {
      console.log(
        `Fetching company data: ${row.company || "(missing company)"} ${row.job_title ? `- ${row.job_title}` : ""}`,
      );
      const result = await enrichEmployerRow(row, apiKey);
      const updatedRow = applyEnrichment(row, result.enrichment);
      updatedRows[index] = updatedRow;

      const summary = summarizeEnrichment(row, updatedRow);
      summaries.push(summary);
      if (result.usage) usages.push(result.usage);
      printEnrichmentSummary(updatedRow, summary);
    },
  );

  await writeOpenAiUsageLog({
    approximateInputCharacters,
    command: "enrich",
    model: DEFAULT_ENRICH_MODEL,
    rowCount: targets.length,
    usages,
  });
  printOpenAiUsageSummary(usages);

  const rowsWithSavedData = summaries.filter((summary) => {
    return summary.savedFields.length > 0;
  }).length;
  const rowsStillMissingAddress = summaries.filter((summary) => {
    return summary.missingAddressFields.length > 0;
  }).length;

  await writeRowsWithBackup(
    DEFAULT_OUTPUT_PATH,
    path.resolve(__dirname, "..", "backups"),
    updatedRows,
  );
  console.log(
    `Updated ${targets.length} entr${targets.length === 1 ? "y" : "ies"} in ${DEFAULT_OUTPUT_PATH}.`,
  );
  console.log(`Rows with newly saved data: ${rowsWithSavedData}.`);
  console.log(`Rows still missing address data: ${rowsStillMissingAddress}.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
