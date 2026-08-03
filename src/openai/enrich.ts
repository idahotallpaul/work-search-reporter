import { DEFAULT_ENRICH_MODEL } from "../config";
import type {
  EnrichedEmployer,
  ExtractedAction,
  WorkSearchRow,
} from "../types";
import { createResponseWithUsage, type OpenAiUsage } from "./client";

export type EnrichEmployerRowResult = {
  enrichment: EnrichedEmployer;
  usage?: OpenAiUsage;
};

type EnrichmentContext = {
  employerWebsite: string;
  sourceUrl: string;
};

const enrichmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    employer_website: { type: "string" },
    employer_contact: { type: "string" },
    mailing_address_line_1: { type: "string" },
    mailing_address_line_2: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    zip: { type: "string" },
    source_url: { type: "string" },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
  required: [
    "employer_website",
    "employer_contact",
    "mailing_address_line_1",
    "mailing_address_line_2",
    "city",
    "state",
    "zip",
    "source_url",
    "confidence",
    "notes",
  ],
};

// Looks up employer website, contact, address, and source URL.
export const enrichEmployer = async (
  action: ExtractedAction,
  apiKey: string,
  context: EnrichmentContext = { employerWebsite: "", sourceUrl: "" },
): Promise<EnrichEmployerRowResult> => {
  if (!action.company) {
    throw new Error(
      "Cannot fetch missing company data without a company name.",
    );
  }

  // Force web search so employer details come from current public sources.
  const response = await createResponseWithUsage<EnrichedEmployer>(
    {
      model: DEFAULT_ENRICH_MODEL,
      input: [
        {
          role: "system",
          content:
            "Find employer contact details for a job-search report. Prefer the official employer website, careers page, or contact page. Do not use registered-agent addresses unless no better employer address is available. If uncertain, leave fields blank and explain in notes.",
        },
        {
          role: "user",
          content: JSON.stringify({
            company: action.company,
            job_title: action.job_title,
            known_employer_website: context.employerWebsite,
            known_source_url: context.sourceUrl,
          }),
        },
      ],
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      text: {
        format: {
          type: "json_schema",
          name: "employer_enrichment",
          strict: true,
          schema: enrichmentSchema,
        },
      },
    },
    apiKey,
  );

  return {
    enrichment: response.data,
    usage: response.usage,
  };
};

// Adapts an existing CSV row into the enrichment request shape.
export const enrichEmployerRow = async (
  row: WorkSearchRow,
  apiKey: string,
): Promise<EnrichEmployerRowResult> => {
  // Reuse the action-based enrichment path for rows already stored in CSV.
  return enrichEmployer(
    {
      source_message_id: row.source_subject,
      action_found: true,
      action_date: row.action_date,
      action_type: row.action_type,
      company: row.company,
      job_title: row.job_title,
      evidence_excerpt: row.evidence_excerpt,
      confidence: Number(row.confidence) || 0.75,
      notes: row.notes,
    },
    apiKey,
    {
      employerWebsite: row.employer_website,
      sourceUrl: row.source_url,
    },
  );
};
