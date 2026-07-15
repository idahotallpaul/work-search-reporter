import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { readRows, writeRowsWithBackup } from "./csv/csv";
import { enrichEmployerRow } from "./openai/enrich";
import type { EnrichedEmployer, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const shouldEnrich = (row: WorkSearchRow): boolean => {
  if (!row.company.trim()) return false;

  return [
    row.employer_website,
    row.employer_contact,
    row.mailing_address_line_1,
    row.city,
    row.state,
    row.zip,
  ].some((value) => !value.trim());
};

const mergeConfidence = (
  existing: string,
  enrichmentConfidence: number,
): string => {
  const current = Number(existing);
  if (!Number.isFinite(current)) return enrichmentConfidence.toFixed(2);
  if (!enrichmentConfidence) return existing;
  return Math.max(current, enrichmentConfidence).toFixed(2);
};

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

const assertNoArgs = (): void => {
  if (process.argv.length > 2) {
    throw new Error("This command does not take flags. Run pnpm start.");
  }
};

const main = async (): Promise<void> => {
  assertNoArgs();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to .env before fetching missing company data.",
    );
  }

  const rows = await readRows(DEFAULT_OUTPUT_PATH);
  if (rows.length === 0) {
    console.log(`No CSV entries found at ${DEFAULT_OUTPUT_PATH}.`);
    return;
  }

  const targets = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => shouldEnrich(row));

  if (targets.length === 0) {
    console.log("No entries with missing company data found.");
    return;
  }

  console.log(
    `Fetching missing company data for ${targets.length} entr${targets.length === 1 ? "y" : "ies"} with concurrency 2.`,
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
