import { type gmail_v1, google } from "googleapis";

import { APPLICATION_SEARCH_TERMS } from "../config";
import type { MailMessage, WeekWindow } from "../types";
import { getGmailAuthClient } from "./auth";

type CollectGmailArgs = {
  week: WeekWindow;
};

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

// Lists all matching Gmail message IDs, following pagination.
const listMessageIds = async (
  gmail: gmail_v1.Gmail,
  query: string,
): Promise<string[]> => {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      includeSpamTrash: false,
      maxResults: 100,
      pageToken,
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

const isReadableMime = (mimeType?: string | null): boolean => {
  return mimeType === "text/plain" || mimeType === "text/html";
};

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

// Fetches every Gmail message body that matches the week query.
export const collectGmailMessages = async ({
  week,
}: CollectGmailArgs): Promise<MailMessage[]> => {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const account = profile.data.emailAddress || "me";
  const query = buildGmailQuery(week);
  console.log(`Gmail query: ${query}`);

  const ids = await listMessageIds(gmail, query);
  const messages: MailMessage[] = [];

  for (const id of ids) {
    const response = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    messages.push(toMailMessage(response.data, account));
  }

  return messages;
};
