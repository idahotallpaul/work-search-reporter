import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { appendRowsWithBackup, readRows } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { collectGmailMessages } from "./gmail/messages";
import { findCandidateMessages } from "./mail/candidates";
import { candidateSourceId, extractActions } from "./openai/extract";
import { filterNewRows, toWorkSearchRow } from "./rows";
import type { WorkSearchRow } from "./types";

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

  // Gmail query results are intentionally broad. OpenAI/local extraction does
  // the final confirmation-vs-noise decision before any row is written.
  const candidates = findCandidateMessages(messages);

  console.log(`Found ${candidates.length} candidate work-search messages.`);
  if (!apiKey) {
    console.log("OPENAI_API_KEY not set; using local extraction only.");
  }

  console.log(
    apiKey
      ? "Extracting candidates in batch(es) of 10."
      : "Extracting candidates with local heuristics.",
  );
  const actionsById = await extractActions(candidates, week, 10, apiKey);

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

  const existingRows = await readRows(DEFAULT_OUTPUT_PATH);
  // Preserve manual CSV edits by reading the current file before appending.
  const newRows = filterNewRows(existingRows, rows);

  if (newRows.length === 0) {
    console.log("No new application confirmation emails found.");
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
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
