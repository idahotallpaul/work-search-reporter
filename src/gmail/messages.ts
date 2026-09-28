import { type gmail_v1, google } from "googleapis";

import { APPLICATION_SEARCH_TERMS } from "../config";
import type { MailMessage, WeekWindow } from "../types";
import { getGmailAuthClient } from "./auth";

type CollectGmailArgs = {
  week: WeekWindow;
};

// messages.get costs 20 quota units. 400ms spacing keeps a burst of body
// reads under Gmail's 6,000 units/minute per-user cap.
const GMAIL_MESSAGE_GET_SPACING_MS = 400;
// messages.list with q= is a search and counts against Total Query Cost.
const GMAIL_LIST_PAGE_SPACING_MS = 1_500;
// Seven attempts cover a full per-minute quota window before giving up.
const GMAIL_MAX_ATTEMPTS = 7;
// Backoff starts at 2s and caps at 60s so retries can clear a minute window.
const GMAIL_RETRY_BASE_DELAY_MS = 2_000;
const GMAIL_RETRY_MAX_DELAY_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

// Reads HTTP status from the shapes googleapis/gaxios actually throw.
const gmailErrorStatus = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;

  if (typeof error.status === "number") return error.status;
  if (typeof error.code === "number") return error.code;
  if (typeof error.code === "string" && /^\d+$/.test(error.code)) {
    return Number(error.code);
  }

  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }

  return undefined;
};

// Prefers Google's structured reason codes, then the Error message.
const gmailErrorReason = (error: unknown): string => {
  if (!isRecord(error)) return "";

  const errors = error.errors;
  if (Array.isArray(errors)) {
    const reasons = errors.flatMap((item) => {
      if (!isRecord(item) || typeof item.reason !== "string") return [];
      return [item.reason];
    });
    if (reasons.length > 0) return reasons.join(" ");
  }

  return error instanceof Error ? error.message : String(error);
};

// Retries quota, rate-limit, 5xx, and common transport failures only.
const isRetryableGmailError = (error: unknown): boolean => {
  const status = gmailErrorStatus(error);
  const reason = gmailErrorReason(error).toLowerCase();

  if (status === 429 || status === 408) return true;
  if (status !== undefined && status >= 500) return true;
  if (
    reason.includes("quota") ||
    reason.includes("ratelimit") ||
    reason.includes("rate limit")
  ) {
    return true;
  }

  // Network failures often have no HTTP status.
  return (
    status === undefined &&
    (reason.includes("timeout") ||
      reason.includes("econn") ||
      reason.includes("etimedout") ||
      reason.includes("socket hang up") ||
      reason.includes("network"))
  );
};

// Reads a header from either a Fetch Headers object or a plain map.
const headerValue = (headers: unknown, name: string): string | undefined => {
  if (!isRecord(headers)) return undefined;

  const getter = headers.get;
  if (typeof getter === "function") {
    const value: unknown = getter.call(headers, name);
    if (typeof value === "string" && value !== "") return value;
  }

  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === "string" && direct !== "") return direct;
  if (Array.isArray(direct) && typeof direct[0] === "string") {
    return direct[0];
  }

  return undefined;
};

// Converts Google's Retry-After seconds into a millisecond delay.
const retryAfterMs = (error: unknown): number | undefined => {
  if (!isRecord(error)) return undefined;

  const response = error.response;
  if (!isRecord(response)) return undefined;

  const raw = headerValue(response.headers, "retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return seconds * 1_000;
};

// Prefers Retry-After; otherwise uses exponential backoff with jitter.
const gmailRetryDelayMs = (attemptIndex: number, error: unknown): number => {
  const fromHeader = retryAfterMs(error);
  if (fromHeader !== undefined) {
    return Math.min(Math.max(fromHeader, 1_000), GMAIL_RETRY_MAX_DELAY_MS);
  }

  const exponential = Math.min(
    GMAIL_RETRY_BASE_DELAY_MS * 2 ** attemptIndex,
    GMAIL_RETRY_MAX_DELAY_MS,
  );
  // Jitter keeps simultaneous retries from stacking on the same second.
  const jitter = Math.floor(Math.random() * 1_000);
  return exponential + jitter;
};

// Retries one Gmail call through quota and transient failures.
const withGmailRetry = async <T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let lastError: unknown = new Error(`Gmail ${label} failed`);

  for (let attempt = 0; attempt < GMAIL_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry =
        isRetryableGmailError(error) && attempt < GMAIL_MAX_ATTEMPTS - 1;

      if (canRetry) {
        const delayMs = gmailRetryDelayMs(attempt, error);
        const seconds = Math.ceil(delayMs / 1_000);
        console.log(
          `Gmail ${label} quota or transient error. Retrying in ${seconds}s (${attempt + 2}/${GMAIL_MAX_ATTEMPTS})...`,
        );
        await sleep(delayMs);
      } else {
        throw error;
      }
    }
  }

  throw lastError;
};

// Groups search terms so Gmail treats them as one OR clause.
const buildOrQuery = (terms: readonly string[]): string => {
  return `(${terms.join(" OR ")})`;
};

// Builds the broad Gmail query for one claim week.
export const buildGmailQuery = (week: WeekWindow): string => {
  const after = week.claimWeekStart.replace(/-/g, "/");
  const before =
    week.queryEndExclusive.year.toString().padStart(4, "0") +
    "/" +
    String(week.queryEndExclusive.month).padStart(2, "0") +
    "/" +
    String(week.queryEndExclusive.day).padStart(2, "0");

  return [
    `after:${after}`,
    `before:${before}`,
    "-in:sent",
    "-in:trash",
    // Broad terms prevent missed confirmations; extraction filters false hits.
    buildOrQuery(APPLICATION_SEARCH_TERMS),
  ].join(" ");
};

// Lists matching Gmail message IDs, pausing and retrying between search pages.
const listMessageIds = async (
  gmail: gmail_v1.Gmail,
  query: string,
): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    // Search pages are billed as query cost; pause between pages.
    if (page > 0) {
      await sleep(GMAIL_LIST_PAGE_SPACING_MS);
    }
    page += 1;

    const response = await withGmailRetry(`messages.list page ${page}`, () => {
      return gmail.users.messages.list({
        userId: "me",
        q: query,
        includeSpamTrash: false,
        maxResults: 100,
        pageToken,
      });
    });

    ids.push(
      ...(response.data.messages || [])
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id)),
    );
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return ids;
};

// Reads one named Gmail header from a message payload.
const header = (
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string => {
  const found = headers.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value || "";
};

// Treats only plain text and HTML parts as readable email bodies.
const isReadableMime = (mimeType?: string | null): boolean => {
  return mimeType === "text/plain" || mimeType === "text/html";
};

// Gmail stores MIME bodies as URL-safe base64.
const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
};

// Extracts readable text from Gmail's nested MIME payload.
const extractBody = (part?: gmail_v1.Schema$MessagePart): string => {
  if (!part) return "";

  // Gmail messages can be nested multipart trees; collect readable leaves.
  if (part.body?.data && isReadableMime(part.mimeType)) {
    return decodeBase64Url(part.body.data);
  }

  const childText = (part.parts || []).map(extractBody).filter(Boolean);
  return childText.join("\n\n");
};

// Converts one Gmail API message into the app's simpler mail shape.
const toMailMessage = (
  message: gmail_v1.Schema$Message,
  account: string,
): MailMessage => {
  const headers = message.payload?.headers || [];
  const subject = header(headers, "Subject");
  const sender = header(headers, "From");
  const messageId = header(headers, "Message-ID");
  const dateHeader = header(headers, "Date");
  const internalDate = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : "";

  // Prefer Gmail's internal received timestamp when available.
  return {
    sourceMessageId: message.id || "",
    messageId: messageId || message.id || "",
    account,
    mailbox: (message.labelIds || []).join("|"),
    subject,
    sender,
    dateReceived: internalDate || dateHeader,
    dateSent: dateHeader,
    body: extractBody(message.payload),
    headers: headers.map((item) => `${item.name}: ${item.value}`).join("\n"),
  };
};

// Fetches matching Gmail bodies for one claim week, with pacing and retries.
export const collectGmailMessages = async ({
  week,
}: CollectGmailArgs): Promise<MailMessage[]> => {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  // Profile, search, and body reads share the same per-user minute budget.
  const profile = await withGmailRetry("users.getProfile", () => {
    return gmail.users.getProfile({ userId: "me" });
  });
  const account = profile.data.emailAddress || "me";
  const query = buildGmailQuery(week);
  console.log(`Gmail query: ${query}`);

  const ids = await listMessageIds(gmail, query);
  const messages: MailMessage[] = [];

  if (ids.length > 0) {
    console.log(
      `Downloading ${ids.length} Gmail message(s) with throttling to stay under quota...`,
    );
  }

  for (const [index, id] of ids.entries()) {
    // Space body reads so a large week does not burst the per-minute cap.
    if (index > 0) {
      await sleep(GMAIL_MESSAGE_GET_SPACING_MS);
    }

    // Log enough progress that a throttled download does not look hung.
    const shouldLogProgress =
      index === 0 || (index + 1) % 25 === 0 || index + 1 === ids.length;
    if (shouldLogProgress) {
      console.log(`Downloading Gmail message ${index + 1}/${ids.length}...`);
    }

    const response = await withGmailRetry(`messages.get ${index + 1}`, () => {
      return gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
    });
    messages.push(toMailMessage(response.data, account));
  }

  return messages;
};
