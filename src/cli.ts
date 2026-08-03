import path from "node:path";

import dotenv from "dotenv";

import {
  DEFAULT_EXTRACT_MODEL,
  DEFAULT_OPENAI_EXTRACT_BATCH_SIZE,
  DEFAULT_OUTPUT_PATH,
  LARGE_EXTRACTION_RUN_EMAIL_COUNT,
} from "./config";
import { appendRowsWithBackup, readRows } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { collectGmailMessages } from "./gmail/messages";
import { findCandidateMessages } from "./mail/candidates";
import { candidateSourceId, extractActions } from "./openai/extract";
import { filterNewRows, rowSourceKey, toWorkSearchRow } from "./rows";
import {
  estimateTokensFromCharacters,
  printOpenAiUsageSummary,
  writeOpenAiUsageLog,
} from "./storage/openaiUsage";
import {
  filterUnprocessedCandidates,
  type ProcessedEmailOutcome,
  processedEmailKey,
  readProcessedEmailCache,
  writeProcessedEmailCache,
} from "./storage/processedEmails";
import type { CandidateMessage, WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

// Creates blank company fields for rows that still need enrichment.
const emptyEnrichment = () => {
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
};

// Estimates the request size without storing or logging email contents.
const approximateExtractionInputCharacters = (
  candidates: readonly CandidateMessage[],
): number => {
  const staticPromptCharacters = 1_500;
  const candidateCharacters = candidates.reduce((total, candidate) => {
    return (
      total +
      candidate.sender.length +
      candidate.subject.length +
      candidate.dateReceived.length +
      candidate.dateSent.length +
      candidate.evidenceExcerpt.length
    );
  }, 0);

  return staticPromptCharacters + candidateCharacters;
};

// Blocks old flag-based usage so weekly runs go through the menu.
const assertNoArgs = (): void => {
  if (process.argv.length > 2) {
    throw new Error("This command does not take flags. Run pnpm start.");
  }
};

// Fetches candidate Gmail messages and appends confirmed applications to CSV.
const main = async (): Promise<void> => {
  assertNoArgs();

  const week = process.env.WORK_SEARCH_WEEK_START
    ? getWeekFromStart(process.env.WORK_SEARCH_WEEK_START)
    : getLastCompletedSundayWeek();

  const apiKey = process.env.OPENAI_API_KEY;

  console.log(
    `Searching Gmail for ${week.claimWeekStart} through ${week.claimWeekEnd}...`,
  );

  const messages = await collectGmailMessages({ week });

  console.log(`Read ${messages.length} matching message(s) from Gmail.`);

  // Gmail query results are intentionally broad; OpenAI does the final
  // confirmation-vs-noise decision before any row is written.
  const candidates = findCandidateMessages(messages);

  console.log(`Found ${candidates.length} candidate work-search messages.`);
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Add it to .env before fetching application confirmation emails.",
    );
  }

  const processedEmailCache = await readProcessedEmailCache();
  const existingRows = await readRows(DEFAULT_OUTPUT_PATH);
  const existingSourceKeys = new Set(
    existingRows.map(rowSourceKey).filter((key) => key !== ""),
  );

  // Skip cached emails only when their CSV row still exists or they were known
  // no-action messages. Deleted CSV rows can be rebuilt during manual retests.
  const unprocessedCandidates = filterUnprocessedCandidates(
    candidates,
    processedEmailCache,
    existingSourceKeys,
  );
  const skippedCandidates = candidates.length - unprocessedCandidates.length;
  console.log(
    `Skipped ${skippedCandidates} candidate email(s) already represented in the CSV or known not to be application confirmations.`,
  );

  if (unprocessedCandidates.length === 0) {
    console.log("No new candidate emails to send to OpenAI.");
    return;
  }

  const batchCount = Math.ceil(
    unprocessedCandidates.length / DEFAULT_OPENAI_EXTRACT_BATCH_SIZE,
  );
  const approximateInputCharacters = approximateExtractionInputCharacters(
    unprocessedCandidates,
  );
  const approximateInputTokens = estimateTokensFromCharacters(
    approximateInputCharacters,
  );

  console.log("OpenAI extraction preflight:");
  console.log(`- Model: ${DEFAULT_EXTRACT_MODEL}`);
  console.log(`- New candidate emails: ${unprocessedCandidates.length}`);
  console.log(`- Batches: ${batchCount}`);
  console.log(
    `- Approximate input size: ${approximateInputCharacters} character(s), roughly ${approximateInputTokens} token(s)`,
  );
  if (unprocessedCandidates.length > LARGE_EXTRACTION_RUN_EMAIL_COUNT) {
    console.log(
      `- Warning: this is larger than the normal ${LARGE_EXTRACTION_RUN_EMAIL_COUNT}-email threshold.`,
    );
  }

  const { actionsById, usages } = await extractActions(
    unprocessedCandidates,
    week,
    DEFAULT_OPENAI_EXTRACT_BATCH_SIZE,
    apiKey,
  );
  await writeOpenAiUsageLog({
    approximateInputCharacters,
    candidateCount: unprocessedCandidates.length,
    command: "extract",
    model: DEFAULT_EXTRACT_MODEL,
    usages,
  });
  printOpenAiUsageSummary(usages);

  const rows: WorkSearchRow[] = [];
  const processedOutcomes = new Map<string, ProcessedEmailOutcome>();
  for (const [index, candidate] of unprocessedCandidates.entries()) {
    console.log(
      `Preparing ${index + 1}/${unprocessedCandidates.length}: ${candidate.subject || "(no subject)"}`,
    );

    const action = actionsById.get(candidateSourceId(candidate));
    if (action?.action_found) {
      rows.push(toWorkSearchRow(week, candidate, action, emptyEnrichment()));
      processedOutcomes.set(processedEmailKey(candidate), "row_written");
    } else {
      processedOutcomes.set(processedEmailKey(candidate), "no_action");
    }
  }

  // Preserve manual CSV edits by reading the current file before appending.
  const newRows = filterNewRows(existingRows, rows);

  if (newRows.length === 0) {
    console.log("No new application confirmation emails found.");
    // Cache processed candidates even when OpenAI rejects them all.
    await writeProcessedEmailCache(
      processedEmailCache,
      unprocessedCandidates,
      week,
      processedOutcomes,
    );
    return;
  }

  await appendRowsWithBackup(
    DEFAULT_OUTPUT_PATH,
    path.resolve(__dirname, "..", "backups"),
    newRows,
  );
  console.log(
    `Added ${newRows.length} application confirmation(s) to ${DEFAULT_OUTPUT_PATH}.`,
  );
  // Cache after successful CSV work so an interrupted run can be retried.
  await writeProcessedEmailCache(
    processedEmailCache,
    unprocessedCandidates,
    week,
    processedOutcomes,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
