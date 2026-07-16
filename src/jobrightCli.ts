import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_OUTPUT_PATH } from "./config";
import { readRows, writeRowsWithBackup } from "./csv/csv";
import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { collectJobrightAppliedJobs } from "./jobright/collect";
import {
  type JobrightProposedRow,
  type JobrightReconciliationResult,
  reconcileJobrightJobs,
} from "./jobright/reconcile";
import { truncate } from "./text";
import type { WorkSearchRow } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

type PromptResult = string | symbol;

type Prompts = {
  cancel: (message?: string) => void;
  isCancel: (value: PromptResult) => value is symbol;
  note: (message: string, title?: string) => void;
  select: (options: {
    message: string;
    options: Array<{ label: string; value: string; hint?: string }>;
  }) => Promise<string | symbol>;
};

type ReviewedJobrightResult = {
  added: number;
  conflicts: number;
  dropped: number;
  ignoredRows: WorkSearchRow[];
  rows: WorkSearchRow[];
  updatedExisting: number;
};

// Blocks old flag-based usage so weekly runs go through the menu.
const assertNoArgs = (): void => {
  if (process.argv.length > 2) {
    throw new Error("This command does not take flags. Run pnpm start.");
  }
};

// Loads Clack only for the Jobright review flow.
const loadPrompts = async (): Promise<Prompts> => {
  return import("@clack/prompts") as Promise<Prompts>;
};

// Formats one proposed Jobright row for a compact terminal review.
const formatProposedRow = (proposal: JobrightProposedRow): string => {
  const row = proposal.row;
  const lines = [
    `Jobright: ${row.action_date} | ${row.company} | ${row.job_title}`,
    `Source: ${row.source_url || "Jobright Applied tab"}`,
  ];

  if (proposal.match) {
    const match = proposal.match;
    lines.push(
      "",
      `Possible CSV match: ${match.actionDate || "(missing date)"} | ${match.company || "(missing company)"} | ${match.jobTitle || match.sourceSubject || "(missing title)"}`,
      `Match source: ${match.sourceSender || "(unknown source)"}`,
    );
  }

  if (row.notes) lines.push("", truncate(row.notes, 500));
  return lines.join("\n");
};

// Applies an explicit review choice to replace a CSV match with Jobright data.
const updateExistingFromJobright = (
  existing: WorkSearchRow,
  proposal: JobrightProposedRow,
): WorkSearchRow => {
  const jobright = proposal.row;
  const replacedNote = `Replaced email-derived row with Jobright Applied tab data. Previous CSV row: ${existing.action_date || "(missing date)"} | ${existing.company || "(missing company)"} | ${existing.job_title || existing.source_subject || "(missing title)"}`;
  return {
    ...jobright,
    notes: `Imported from Jobright Applied tab. | ${replacedNote}`,
  };
};

// Builds review options for possible Jobright duplicates.
const reviewOptionsForProposal = (): Array<{
  label: string;
  value: string;
  hint?: string;
}> => {
  return [
    {
      label: "Update existing row",
      value: "update-existing",
      hint: "Replace the possible CSV match with Jobright's application data.",
    },
    {
      label: "Add new Jobright row",
      value: "add-new",
      hint: "Write this Jobright application as a separate CSV row.",
    },
    {
      label: "Ignore Jobright row",
      value: "ignore",
      hint: "Do not write this proposed Jobright row.",
    },
    {
      label: "Ignore all remaining",
      value: "ignore-all",
      hint: "Skip this row and every remaining proposed row.",
    },
    {
      label: "Cancel without writing",
      value: "cancel",
      hint: "Abort the Jobright import.",
    },
  ];
};

// Lets the user reconcile possible Jobright duplicates before writing.
const reviewProposedRows = async (
  result: JobrightReconciliationResult,
): Promise<ReviewedJobrightResult> => {
  const conflicts = result.proposedRows.filter((proposal) => {
    return proposal.kind === "conflict";
  });

  if (conflicts.length === 0) {
    return {
      added: result.added,
      conflicts: 0,
      dropped: 0,
      ignoredRows: [],
      rows: result.rows,
      updatedExisting: 0,
    };
  }

  const prompts = await loadPrompts();
  const { cancel, isCancel, note, select } = prompts;
  const droppedIndexes = new Set<number>();
  const ignoredRows: WorkSearchRow[] = [];
  const rows = result.rows.map((row) => ({ ...row }));
  let ignored = 0;
  let ignoreRemaining = false;
  let updatedExisting = 0;

  note(
    `${conflicts.length} possible duplicate Jobright row(s) need review before writing the CSV. ${result.added} new Jobright row(s) will be added automatically.`,
    "Review Jobright rows",
  );

  for (let index = 0; index < conflicts.length; index += 1) {
    const proposal = conflicts[index];

    if (ignoreRemaining) {
      droppedIndexes.add(proposal.rowIndex);
      ignoredRows.push(proposal.row);
      ignored += 1;
    } else {
      note(
        formatProposedRow(proposal),
        `Possible duplicate ${index + 1} of ${conflicts.length}`,
      );

      const answer = await select({
        message: "How should this possible duplicate be handled?",
        options: reviewOptionsForProposal(),
      });

      if (isCancel(answer) || answer === "cancel") {
        cancel("Canceled. CSV was not changed.");
        throw new Error("Jobright review canceled.");
      }

      if (answer === "update-existing" && proposal.match) {
        rows[proposal.match.rowIndex] = updateExistingFromJobright(
          rows[proposal.match.rowIndex],
          proposal,
        );
        droppedIndexes.add(proposal.rowIndex);
        updatedExisting += 1;
      }
      if (answer === "ignore") {
        droppedIndexes.add(proposal.rowIndex);
        ignoredRows.push(proposal.row);
        ignored += 1;
      }
      if (answer === "ignore-all") {
        droppedIndexes.add(proposal.rowIndex);
        ignoredRows.push(proposal.row);
        ignored += 1;
        ignoreRemaining = true;
      }
    }
  }

  const keptProposals = result.proposedRows.filter((proposal) => {
    return !droppedIndexes.has(proposal.rowIndex);
  });

  return {
    added: result.added,
    conflicts: keptProposals.filter((proposal) => proposal.kind === "conflict")
      .length,
    dropped: ignored,
    ignoredRows,
    rows: rows.filter((_, index) => !droppedIndexes.has(index)),
    updatedExisting,
  };
};

// Formats a row into the compact details printed after a Jobright run.
const rowSummary = (row: WorkSearchRow): string => {
  return `${row.action_date || "(missing date)"} | ${row.company || "(missing company)"} | ${row.job_title || row.source_subject || "(missing title)"}`;
};

// Checks whether any persisted CSV field changed.
const rowChanged = (before: WorkSearchRow, after: WorkSearchRow): boolean => {
  return Object.keys(before).some((key) => {
    const field = key as keyof WorkSearchRow;
    return before[field] !== after[field];
  });
};

// Prints concrete rows that were added, updated, or ignored.
const printChangeDetails = (
  beforeRows: readonly WorkSearchRow[],
  reviewed: ReviewedJobrightResult,
): void => {
  const updatedRows = beforeRows
    .map((before, index) => ({
      after: reviewed.rows[index],
      before,
    }))
    .filter(({ after, before }) => after && rowChanged(before, after));
  const addedRows = reviewed.rows.slice(beforeRows.length);

  if (
    addedRows.length === 0 &&
    updatedRows.length === 0 &&
    reviewed.ignoredRows.length === 0
  ) {
    return;
  }

  console.log("");
  console.log("Jobright change details:");

  if (addedRows.length > 0) {
    console.log("Added:");
    addedRows.forEach((row) => {
      console.log(`  + ${rowSummary(row)}`);
    });
  }

  if (updatedRows.length > 0) {
    console.log("Updated:");
    updatedRows.forEach(({ after, before }) => {
      console.log(`  ~ ${rowSummary(after)}`);
      console.log(`    was: ${rowSummary(before)}`);
    });
  }

  if (reviewed.ignoredRows.length > 0) {
    console.log("Ignored:");
    reviewed.ignoredRows.forEach((row) => {
      console.log(`  - ${rowSummary(row)}`);
    });
  }
};

// Reads Jobright applied jobs and reconciles them into the CSV.
const main = async (): Promise<void> => {
  assertNoArgs();

  const week = process.env.WORK_SEARCH_WEEK_START
    ? getWeekFromStart(process.env.WORK_SEARCH_WEEK_START)
    : getLastCompletedSundayWeek();

  console.log(
    `Reading Jobright Applied tab for ${week.claimWeekStart} through ${week.claimWeekEnd}...`,
  );

  const jobs = await collectJobrightAppliedJobs(week);
  console.log(`Found ${jobs.length} Jobright applied job(s) in claim week.`);

  if (jobs.length === 0) {
    console.log("No Jobright applications found for the selected week.");
    return;
  }

  const existingRows = await readRows(DEFAULT_OUTPUT_PATH);
  const result = reconcileJobrightJobs(existingRows, jobs, week);
  const reviewed = await reviewProposedRows(result);

  if (
    reviewed.added === 0 &&
    result.updated === 0 &&
    reviewed.updatedExisting === 0 &&
    reviewed.conflicts === 0
  ) {
    console.log("No CSV changes needed after Jobright reconciliation.");
    return;
  }

  await writeRowsWithBackup(
    DEFAULT_OUTPUT_PATH,
    path.resolve(__dirname, "..", "backups"),
    reviewed.rows,
  );

  console.log(
    [
      `Jobright reconciliation complete for ${DEFAULT_OUTPUT_PATH}.`,
      `Added: ${reviewed.added}`,
      `Updated: ${result.updated + reviewed.updatedExisting}`,
      `Updated from review: ${reviewed.updatedExisting}`,
      `Review conflicts kept: ${reviewed.conflicts}`,
      `Ignored during review: ${reviewed.dropped}`,
      `Unchanged: ${result.unchanged}`,
    ].join("\n"),
  );
  printChangeDetails(existingRows, reviewed);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
