import { CANDIDATE_TERMS } from "../config";
import { normalizeWhitespace, truncate } from "../text";
import type { CandidateMessage, MailMessage } from "../types";

// Pulls a short body snippet around the matched application evidence.
const findEvidenceExcerpt = (
  message: MailMessage,
  matchedTerms: readonly string[],
): string => {
  const cleanedBody = normalizeWhitespace(message.body);
  const lowerBody = cleanedBody.toLowerCase();
  const firstTerm = matchedTerms
    .map((term) => term.toLowerCase())
    .find((term) => lowerBody.includes(term));

  if (!firstTerm) {
    return truncate(`${message.subject}. ${cleanedBody}`, 700);
  }

  // Keep the excerpt centered near evidence, not at the top of long emails.
  const index = lowerBody.indexOf(firstTerm);
  const start = Math.max(0, index - 220);
  const end = Math.min(cleanedBody.length, index + 480);
  return truncate(cleanedBody.slice(start, end), 700);
};

// Removes repeated Gmail hits before extraction runs.
const dedupeCandidates = (
  candidates: CandidateMessage[],
): CandidateMessage[] => {
  const seen = new Set<string>();
  const deduped: CandidateMessage[] = [];

  for (const candidate of candidates) {
    const key =
      candidate.messageId ||
      `${candidate.subject}|${candidate.sender}|${candidate.dateReceived}|${candidate.dateSent}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(candidate);
    }
  }

  return deduped;
};

// Finds messages that are worth sending to extraction.
export const findCandidateMessages = (
  messages: MailMessage[],
): CandidateMessage[] => {
  const candidates: CandidateMessage[] = [];

  for (const message of messages) {
    // This is only the first pass; OpenAI confirms later.
    const haystack =
      `${message.subject}\n${message.sender}\n${message.body}`.toLowerCase();
    const matchedTerms = CANDIDATE_TERMS.filter((term) =>
      haystack.includes(term.toLowerCase()),
    );

    if (matchedTerms.length > 0) {
      const evidenceExcerpt = findEvidenceExcerpt(message, matchedTerms);

      candidates.push({
        ...message,
        evidenceExcerpt,
      });
    }
  }

  return dedupeCandidates(candidates);
};
