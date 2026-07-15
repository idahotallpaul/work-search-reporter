import { DEFAULT_EXTRACT_MODEL } from "../config";
import { senderDisplayName, truncate } from "../text";
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

export const candidateSourceId = (candidate: CandidateMessage): string => {
  return (
    candidate.sourceMessageId || candidate.messageId || candidate.dateReceived
  );
};

const inferCompany = (candidate: CandidateMessage): string => {
  const subjectPatterns = [
    /thank you for applying to\s+(.+?)(?:[.!|:-]|$)/i,
    /application (?:to|with|at)\s+(.+?)(?:[.!|:-]|$)/i,
    /your application (?:to|with|at)\s+(.+?)(?:[.!|:-]|$)/i,
  ];

  for (const pattern of subjectPatterns) {
    const match = pattern.exec(candidate.subject);
    if (match?.[1]) return truncate(match[1], 120);
  }

  return truncate(senderDisplayName(candidate.sender), 120);
};

const inferJobTitle = (subject: string, excerpt: string): string => {
  const text = `${subject}. ${excerpt}`;
  const patterns = [
    /(?:for|position of|role of)\s+([A-Z][^.!|:\n]{2,80})/i,
    /job title[:\s]+([^.!|:\n]{2,80})/i,
    /position[:\s]+([^.!|:\n]{2,80})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return truncate(match[1], 120);
  }

  return "";
};

const normalizeMailDate = (value: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
};

const localExtractAction = (candidate: CandidateMessage): ExtractedAction => {
  const subject = candidate.subject;
  const excerpt = candidate.evidenceExcerpt;
  const actionType = "Job application confirmation";
  const company = inferCompany(candidate);
  const jobTitle = inferJobTitle(subject, excerpt);

  return {
    source_message_id: candidateSourceId(candidate),
    action_found: true,
    action_date: normalizeMailDate(
      candidate.dateReceived || candidate.dateSent,
    ),
    action_type: actionType,
    company,
    job_title: jobTitle,
    evidence_excerpt: truncate(excerpt, 700),
    confidence: candidate.localScore,
    notes: `Local heuristic extraction. Matched: ${candidate.matchedTerms.join(", ")}`,
  };
};

export const extractActions = async (
  candidates: readonly CandidateMessage[],
  week: WeekWindow,
  batchSize: number,
  apiKey?: string,
): Promise<Map<string, ExtractedAction>> => {
  const actionsById = new Map<string, ExtractedAction>();

  if (!apiKey) {
    for (const candidate of candidates) {
      actionsById.set(
        candidateSourceId(candidate),
        localExtractAction(candidate),
      );
    }
    return actionsById;
  }

  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    try {
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
        if (!action.source_message_id) continue;
        actionsById.set(action.source_message_id, action);
      }
    } catch (error) {
      for (const candidate of batch) {
        const fallback = localExtractAction(candidate);
        fallback.notes = `OpenAI batch extraction failed; used local fallback. ${(error as Error).message}`;
        fallback.confidence = Math.min(fallback.confidence, 0.35);
        actionsById.set(candidateSourceId(candidate), fallback);
      }
    }
  }

  return actionsById;
};
