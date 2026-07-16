import { DEFAULT_EXTRACT_MODEL } from "../config";
import { truncate } from "../text";
import type { CandidateMessage, ExtractedAction, WeekWindow } from "../types";
import { createResponse } from "./client";

type BatchExtractionResponse = {
  actions: ExtractedAction[];
};

const actionProperties = {
  source_message_id: { type: "string" },
  action_found: { type: "boolean" },
  action_date: { type: "string" },
  action_type: { type: "string" },
  company: { type: "string" },
  job_title: { type: "string" },
  evidence_excerpt: { type: "string" },
  confidence: { type: "number" },
  notes: { type: "string" },
} as const;

const actionRequired = [
  "source_message_id",
  "action_found",
  "action_date",
  "action_type",
  "company",
  "job_title",
  "evidence_excerpt",
  "confidence",
  "notes",
] as const;

const batchExtractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: actionProperties,
        required: actionRequired,
      },
    },
  },
  required: ["actions"],
};

// Returns the best available identifier for correlating extraction results.
export const candidateSourceId = (candidate: CandidateMessage): string => {
  // Prefer stable Gmail IDs so batch responses map back to the right email.
  return (
    candidate.sourceMessageId || candidate.messageId || candidate.dateReceived
  );
};

// Extracts one structured application result per candidate email.
export const extractActions = async (
  candidates: readonly CandidateMessage[],
  week: WeekWindow,
  batchSize: number,
  apiKey: string,
): Promise<Map<string, ExtractedAction>> => {
  const actionsById = new Map<string, ExtractedAction>();

  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    // Send only metadata plus a trimmed excerpt, never full mailbox contents.
    const response = await createResponse<BatchExtractionResponse>(
      {
        model: DEFAULT_EXTRACT_MODEL,
        input: [
          {
            role: "system",
            content:
              "Extract only job-application receipt/confirmation emails sent after the user applied for a job. A valid email must affirmatively say the application was received, submitted, or that the user applied/expressed interest in a specific role or employer. Return one result per input email, keyed by source_message_id. Return only facts supported by the email. Do not invent company names, job titles, dates, contacts, or application details. Set action_found=false for rejection emails, application-status updates, interview requests, job alerts, newsletters, digests, advertisements, recruiting outreach, expired-application notices, or any message that does not itself confirm receipt/submission of an application.",
          },
          {
            role: "user",
            content: JSON.stringify({
              claim_week_start: week.claimWeekStart,
              claim_week_end: week.claimWeekEnd,
              emails: batch.map((candidate) => ({
                source_message_id: candidateSourceId(candidate),
                sender: candidate.sender,
                subject: candidate.subject,
                date_received: candidate.dateReceived,
                date_sent: candidate.dateSent,
                excerpt: truncate(candidate.evidenceExcerpt, 700),
              })),
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "work_search_action_batch",
            strict: true,
            schema: batchExtractionSchema,
          },
        },
      },
      apiKey,
    );

    for (const action of response.actions) {
      actionsById.set(action.source_message_id, action);
    }
  }

  return actionsById;
};
