import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { readRows, stringifyCsv, writeRowsWithBackup } from "./csv/csv";
import { enrichEmployerRow } from "./openai/enrich";
import type { EnrichedEmployer, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

type EnrichOptions = {
  concurrency: number;
  dryRun: boolean;
  limit?: number;
  outputPath: string;
};

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

const requiredValue = (args: string[], index: number, flag: string): string => {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

const printHelpAndExit = (): never => {
  console.log(`Usage: pnpm enrich -- [options]

Options:
  --dry-run              Print CSV with missing company data without writing the output file.
  --limit <n>            Fetch company data for only the first n matching entries.
  --concurrency <n>      Parallel company data lookups. Defaults to 2.
  --output <path>        CSV output path. Defaults to ${DEFAULT_OUTPUT_PATH}.
  --help                 Show this help.
`);
  process.exit(0);
};

const parseArgs = (args: string[]): EnrichOptions => {
  const options: EnrichOptions = {
    concurrency: 2,
    dryRun: false,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--":
        break;
      case "--concurrency":
        options.concurrency = Number(requiredValue(args, ++i, arg));
        if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
          throw new Error("--concurrency must be a positive integer.");
        }
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--limit":
        options.limit = Number(requiredValue(args, ++i, arg));
        if (!Number.isInteger(options.limit) || options.limit < 1) {
          throw new Error("--limit must be a positive integer.");
        }
        break;
      case "--output":
        options.outputPath = path.resolve(requiredValue(args, ++i, arg));
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to .env before fetching missing company data.",
    );
  }

  const rows = await readRows(options.outputPath);
  if (rows.length === 0) {
    console.log(`No CSV entries found at ${options.outputPath}.`);
    return;
  }

  const targets = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => shouldEnrich(row))
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);

  if (targets.length === 0) {
    console.log("No entries with missing company data found.");
    return;
  }

  console.log(
    `Fetching missing company data for ${targets.length} entr${targets.length === 1 ? "y" : "ies"} with concurrency ${options.concurrency}.`,
  );

  const updatedRows = [...rows];
  await runWithConcurrency(
    targets,
    options.concurrency,
    async ({ row, index }) => {
      console.log(
        `Fetching company data: ${row.company || "(missing company)"} ${row.job_title ? `- ${row.job_title}` : ""}`,
      );
      const enrichment = await enrichEmployerRow(row, apiKey);
      updatedRows[index] = applyEnrichment(row, enrichment);
    },
  );

  if (options.dryRun) {
    console.log(
      "Dry run: CSV with missing company data follows; no file was written.",
    );
    process.stdout.write(stringifyCsv(updatedRows));
    return;
  }

  await writeRowsWithBackup(
    options.outputPath,
    path.resolve(__dirname, "..", "backups"),
    updatedRows,
  );
  console.log(
    `Updated ${targets.length} entr${targets.length === 1 ? "y" : "ies"} in ${options.outputPath}.`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
