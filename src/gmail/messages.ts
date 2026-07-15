import { google, gmail_v1 } from "googleapis";

import type { MailMessage, WeekWindow } from "../types";
import { getGmailAuthClient } from "./auth";

type CollectGmailArgs = {
  week: WeekWindow;
  maxResults?: number;
};

export async function countGmailMessages(week: WeekWindow): Promise<{
  count: number;
  query: string;
}> {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const query = buildGmailQuery(week);
  const ids = await listMessageIds(gmail, query);

  return {
    count: ids.length,
    query,
  };
}

export async function collectGmailMessages({
  week,
  maxResults,
}: CollectGmailArgs): Promise<MailMessage[]> {
  const auth = await getGmailAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const account = profile.data.emailAddress || "me";
  const query = buildGmailQuery(week);
  console.log(`Gmail query: ${query}`);

  const ids = await listMessageIds(gmail, query, maxResults);
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
}

export function buildGmailQuery(week: WeekWindow): string {
  const after = week.claimWeekStart.replace(/-/g, "/");
  const before = week.queryEndExclusive.year.toString().padStart(4, "0") +
    "/" +
    String(week.queryEndExclusive.month).padStart(2, "0") +
    "/" +
    String(week.queryEndExclusive.day).padStart(2, "0");

  return [
    `after:${after}`,
    `before:${before}`,
    "-in:sent",
    "-in:trash",
    "(application OR applied OR applying OR applicant OR candidacy OR candidate)",
  ].join(" ");
}

async function listMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults?: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const remaining =
      maxResults === undefined ? 100 : Math.max(1, maxResults - ids.length);
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      includeSpamTrash: false,
      maxResults: Math.min(100, remaining),
      pageToken,
    });

    ids.push(
      ...(response.data.messages || [])
        .map((message) => message.id)
        .filter((id): id is string => Boolean(id)),
    );
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken && (maxResults === undefined || ids.length < maxResults));

  return maxResults === undefined ? ids : ids.slice(0, maxResults);
}

function toMailMessage(message: gmail_v1.Schema$Message, account: string): MailMessage {
  const headers = message.payload?.headers || [];
  const subject = header(headers, "Subject");
  const sender = header(headers, "From");
  const messageId = header(headers, "Message-ID");
  const dateHeader = header(headers, "Date");
  const internalDate = message.internalDate
    ? new Date(Number(message.internalDate)).toISOString()
    : "";

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
}

function header(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string {
  const found = headers.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value || "";
}

function extractBody(part?: gmail_v1.Schema$MessagePart): string {
  if (!part) return "";

  if (part.body?.data && isReadableMime(part.mimeType)) {
    return decodeBase64Url(part.body.data);
  }

  const childText = (part.parts || []).map(extractBody).filter(Boolean);
  return childText.join("\n\n");
}

function isReadableMime(mimeType?: string | null): boolean {
  return mimeType === "text/plain" || mimeType === "text/html";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}
