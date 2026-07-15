import path from "node:path";
import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { readRows, appendRowsWithBackup, stringifyCsv } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { collectGmailMessages } from "./gmail/messages";
import { findCandidateMessages } from "./mail/candidates";
import { candidateSourceId, extractActions } from "./openai/extract";
import { filterNewRows, toWorkSearchRow } from "./rows";
import type { CliOptions, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const week = options.weekStart
    ? getWeekFromStart(options.weekStart)
    : getLastCompletedSundayWeek();

  const apiKey =
    options.noOpenAI || !process.env.OPENAI_API_KEY
      ? undefined
      : process.env.OPENAI_API_KEY;

  console.log(
    `Searching Gmail for ${week.claimWeekStart} through ${week.claimWeekEnd}...`,
  );

  const messages = await collectGmailMessages({
    week,
    maxResults: options.limit,
  });

  console.log(`Read ${messages.length} matching message(s) from Gmail.`);

  const candidates = findCandidateMessages(messages);

  console.log(`Found ${candidates.length} candidate work-search messages.`);
  if (!apiKey) {
    console.log("OPENAI_API_KEY not set or --no-openai used; using local extraction only.");
  }

  console.log(
    apiKey
      ? `Extracting candidates in batch(es) of ${options.batchSize}.`
      : "Extracting candidates with local heuristics.",
  );
  const actionsById = await extractActions(
    candidates,
    week,
    options.batchSize,
    apiKey,
  );

  const rows: WorkSearchRow[] = [];
  for (const [index, candidate] of candidates.entries()) {
    console.log(
      `Preparing ${index + 1}/${candidates.length}: ${candidate.subject || "(no subject)"}`,
    );

    const action = actionsById.get(candidateSourceId(candidate));
    if (!action) continue;
    if (!action.action_found) continue;

    rows.push(toWorkSearchRow(week, candidate, action, emptyEnrichment()));
  }

  const existingRows = await readRows(options.outputPath);
  const newRows = filterNewRows(existingRows, rows);

  if (options.dryRun) {
    console.log(
      `Dry run: ${newRows.length} application confirmation(s) would be added.`,
    );
    process.stdout.write(stringifyCsv(newRows));
    return;
  }

  if (newRows.length === 0) {
    console.log("No new application confirmation emails found.");
    return;
  }

  await appendRowsWithBackup(
    options.outputPath,
    path.resolve(__dirname, "..", "backups"),
    newRows,
  );
  console.log(
    `Added ${newRows.length} application confirmation(s) to ${options.outputPath}.`,
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 10,
    dryRun: false,
    noOpenAI: false,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--":
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
      case "--batch-size":
        options.batchSize = Number(requiredValue(args, ++i, arg));
        if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
          throw new Error("--batch-size must be a positive integer.");
        }
        break;
      case "--no-openai":
        options.noOpenAI = true;
        break;
      case "--output":
        options.outputPath = path.resolve(requiredValue(args, ++i, arg));
        break;
      case "--week-start":
        options.weekStart = requiredValue(args, ++i, arg);
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
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelpAndExit(): never {
  console.log(`Usage: pnpm collect -- [options]

Options:
  --dry-run              Print application confirmations without writing the output file.
  --limit <n>            Testing only: process only the first n Gmail matches.
  --batch-size <n>       OpenAI extraction emails per request. Defaults to 10.
  --no-openai            Disable OpenAI extraction.
  --week-start <date>    Claim week Sunday as YYYY-MM-DD. Defaults to last completed Sunday week.
  --output <path>        CSV output path. Defaults to ${DEFAULT_OUTPUT_PATH}.
  --help                 Show this help.
`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function emptyEnrichment() {
  return {
    employer_website: "",
    employer_contact: "",
    mailing_address_line_1: "",
    mailing_address_line_2: "",
    city: "",
    state: "",
    zip: "",
    source_url: "",
    confidence: 0,
    notes: "Needs missing company data",
  };
}
