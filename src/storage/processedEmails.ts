import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROCESSED_EMAIL_CACHE_PATH } from "../config";
import { normalizeForKey } from "../text";
import type { CandidateMessage, WeekWindow } from "../types";

type ProcessedEmailRecord = {
  key: string;
  source_message_id: string;
  message_id: string;
  subject: string;
  sender: string;
  date_received: string;
  date_sent: string;
  claim_week_start: string;
  claim_week_end: string;
  processed_at: string;
};

type ProcessedEmailCache = {
  version: 1;
  emails: ProcessedEmailRecord[];
};

// The cache tracks only enough metadata to skip repeat OpenAI extraction.
const emptyCache = (): ProcessedEmailCache => {
  return {
    version: 1,
    emails: [],
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isProcessedEmailRecord = (
  value: unknown,
): value is ProcessedEmailRecord => {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.source_message_id === "string" &&
    typeof value.message_id === "string" &&
    typeof value.subject === "string" &&
    typeof value.sender === "string" &&
    typeof value.date_received === "string" &&
    typeof value.date_sent === "string" &&
    typeof value.claim_week_start === "string" &&
    typeof value.claim_week_end === "string" &&
    typeof value.processed_at === "string"
  );
};

const parseCache = (value: unknown): ProcessedEmailCache => {
  if (!isRecord(value) || !Array.isArray(value.emails)) return emptyCache();

  // Ignore malformed records instead of failing the whole weekly run.
  return {
    version: 1,
    emails: value.emails.filter(isProcessedEmailRecord),
  };
};

// Builds a stable metadata-only key. No email body or excerpt is stored.
export const processedEmailKey = (candidate: CandidateMessage): string => {
  return (
    candidate.sourceMessageId ||
    candidate.messageId ||
    normalizeForKey(
      `${candidate.subject}|${candidate.sender}|${candidate.dateReceived || candidate.dateSent}`,
    )
  );
};

// Reads the local metadata cache, treating a missing file as empty.
export const readProcessedEmailCache =
  async (): Promise<ProcessedEmailCache> => {
    try {
      const raw = await fs.readFile(DEFAULT_PROCESSED_EMAIL_CACHE_PATH, "utf8");
      return parseCache(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyCache();
      }
      throw error;
    }
  };

export const filterUnprocessedCandidates = (
  candidates: readonly CandidateMessage[],
  cache: ProcessedEmailCache,
): CandidateMessage[] => {
  const processedKeys = new Set(cache.emails.map((email) => email.key));
  // Only new candidates should reach OpenAI; old noise stays skipped too.
  return candidates.filter((candidate) => {
    return !processedKeys.has(processedEmailKey(candidate));
  });
};

const toProcessedEmailRecord = (
  candidate: CandidateMessage,
  week: WeekWindow,
  processedAt: string,
): ProcessedEmailRecord => {
  return {
    key: processedEmailKey(candidate),
    source_message_id: candidate.sourceMessageId,
    message_id: candidate.messageId,
    subject: candidate.subject,
    sender: candidate.sender,
    date_received: candidate.dateReceived,
    date_sent: candidate.dateSent,
    claim_week_start: week.claimWeekStart,
    claim_week_end: week.claimWeekEnd,
    processed_at: processedAt,
  };
};

// Marks emails as processed only after OpenAI extraction succeeds.
export const writeProcessedEmailCache = async (
  cache: ProcessedEmailCache,
  candidates: readonly CandidateMessage[],
  week: WeekWindow,
): Promise<void> => {
  const processedAt = new Date().toISOString();
  const recordsByKey = new Map(
    cache.emails.map((email) => [email.key, email] as const),
  );

  // Upsert so reprocessing a candidate updates metadata without duplicating it.
  for (const candidate of candidates) {
    const record = toProcessedEmailRecord(candidate, week, processedAt);
    recordsByKey.set(record.key, record);
  }

  await fs.mkdir(path.dirname(DEFAULT_PROCESSED_EMAIL_CACHE_PATH), {
    recursive: true,
  });
  await fs.writeFile(
    DEFAULT_PROCESSED_EMAIL_CACHE_PATH,
    `${JSON.stringify({ version: 1, emails: [...recordsByKey.values()] }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
};
