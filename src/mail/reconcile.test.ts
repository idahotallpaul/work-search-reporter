import assert from "node:assert/strict";
import test from "node:test";

import { CSV_COLUMNS } from "../config";
import { getWeekFromStart } from "../dates";
import { candidateSourceRowKey, rowSourceKey } from "../rows";
import {
  filterUnprocessedCandidates,
  linkProcessedEmailSources,
} from "../storage/processedEmails";
import type { CandidateMessage, WorkSearchRow } from "../types";
import { findCandidateMessages } from "./candidates";
import { reconcileEmailRows } from "./reconcile";

const week = getWeekFromStart("2026-10-11");
const employer = (overrides: Partial<WorkSearchRow> = {}): WorkSearchRow => ({
  ...(Object.fromEntries(
    CSV_COLUMNS.map((column) => [column, ""]),
  ) as WorkSearchRow),
  claim_week_start: week.claimWeekStart,
  claim_week_end: week.claimWeekEnd,
  action_date: "2026-10-15",
  company: "EvenUp",
  job_title: "Frontend Engineer, Growth & Agents",
  source_subject: "Thanks for applying to EvenUp!",
  source_sender: "EvenUp <no-reply@ashbyhq.com>",
  source_date: "2026-10-15T18:00:00.000Z",
  ...overrides,
});
const platform = (overrides: Partial<WorkSearchRow> = {}): WorkSearchRow =>
  employer({
    source_subject:
      'Your "Frontend Engineer, Growth & Agents" application is complete',
    source_sender: '"Phil @ ZipRecruiter" <phil@ziprecruiter.com>',
    source_date: "2026-10-15T18:01:00.000Z",
    ...overrides,
  });

test("platform and employer receipts merge in either order, preserving manual fields", () => {
  const direct = employer({
    employer_website: "https://evenuplaw.com",
    notes: "Manual note",
  });
  const receipt = platform({ employer_website: "https://other.example" });
  for (const input of [
    [direct, receipt],
    [receipt, direct],
  ]) {
    const result = reconcileEmailRows([], input, week);
    assert.equal(result.added, 1);
    assert.equal(result.merged, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].source_sender, direct.source_sender);
    assert.equal(result.rows[0].employer_website, direct.employer_website);
    assert.match(result.rows[0].notes, /^Manual note/);
    assert.equal(
      result.sourceAliases.get(rowSourceKey(receipt)),
      rowSourceKey(direct),
    );
  }
});

test("Substack's blank employer title is filled from its unique platform receipt", () => {
  const direct = employer({ company: "Substack", job_title: "" });
  const receipt = platform({
    company: "Substack Inc.",
    job_title: "Full Stack Software Engineer - Payments",
  });
  const result = reconcileEmailRows([direct, receipt], [], week);
  assert.equal(result.added, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].job_title, receipt.job_title);
  assert.deepEqual(direct.job_title, "");
  assert.equal(reconcileEmailRows(result.rows, [], week).merged, 0);
});

test("different companies, dates, roles, and ambiguous blank titles stay separate", () => {
  const receipt = platform();
  for (const direct of [
    employer({ company: "Other employer" }),
    employer({ action_date: "2026-10-16" }),
    employer({ job_title: "Backend Engineer" }),
  ]) {
    assert.equal(reconcileEmailRows([direct], [receipt], week).rows.length, 2);
  }
  assert.equal(
    reconcileEmailRows(
      [employer({ job_title: "" })],
      [
        receipt,
        platform({
          job_title: "Backend Engineer",
          source_date: "2026-10-15T19:00:00.000Z",
        }),
      ],
      week,
    ).rows.length,
    3,
  );
});

test("source duplicates stay skipped and ZipRecruiter employer receipts are preserved", () => {
  const direct = employer({
    company: "ZipRecruiter",
    source_sender: "no-reply@ziprecruiter.com",
  });
  const result = reconcileEmailRows([direct], [direct], week);
  assert.equal(result.rows.length, 1);
  assert.equal(result.added, 0);
  assert.equal(result.merged, 0);
});

test("an employer receipt arriving later preserves existing platform row edits", () => {
  const receipt = platform({
    city: "Manual city",
    employer_website: "https://manual.example",
  });
  const result = reconcileEmailRows(
    [receipt],
    [employer({ employer_website: "https://new.example" })],
    week,
  );
  assert.equal(result.added, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].city, "Manual city");
  assert.equal(result.rows[0].employer_website, receipt.employer_website);
  assert.equal(result.rows[0].source_sender, receipt.source_sender);
});

test("merged email cache links skip repeat extraction but allow deleted-row retests", () => {
  const receipt = platform();
  const direct = employer();
  const candidate: CandidateMessage = {
    sourceMessageId: "gmail-id",
    messageId: "message-id",
    account: "",
    mailbox: "",
    subject: receipt.source_subject,
    sender: receipt.source_sender,
    dateReceived: receipt.source_date,
    dateSent: receipt.source_date,
    body: "",
    headers: "",
    evidenceExcerpt: "",
  };
  const cache = linkProcessedEmailSources(
    {
      version: 1,
      emails: [
        {
          key: candidate.sourceMessageId,
          source_message_id: candidate.sourceMessageId,
          message_id: candidate.messageId,
          subject: candidate.subject,
          sender: candidate.sender,
          date_received: candidate.dateReceived,
          date_sent: candidate.dateSent,
          claim_week_start: week.claimWeekStart,
          claim_week_end: week.claimWeekEnd,
          extraction_result: "row_written",
          processed_at: receipt.source_date,
        },
      ],
    },
    new Map([[candidateSourceRowKey(candidate), rowSourceKey(direct)]]),
  );
  assert.equal(
    filterUnprocessedCandidates(
      [candidate],
      cache,
      new Set([rowSourceKey(direct)]),
    ).length,
    0,
  );
  assert.equal(
    filterUnprocessedCandidates([candidate], cache, new Set()).length,
    1,
  );
});

test("NDA follow-ups are excluded without rejecting confirmations mentioning NDAs in the body", () => {
  const message: CandidateMessage = {
    sourceMessageId: "id",
    messageId: "id",
    account: "",
    mailbox: "",
    subject: "ZipRecruiter - NDA",
    sender: "ed.vitela@ziprecruiter.com",
    dateReceived: "",
    dateSent: "",
    body: "Thank you for applying. Please sign our NDA.",
    headers: "",
    evidenceExcerpt: "",
  };
  assert.equal(findCandidateMessages([message]).length, 0);
  assert.equal(
    findCandidateMessages([{ ...message, subject: "Application received" }])
      .length,
    1,
  );
});
