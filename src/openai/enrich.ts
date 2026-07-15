import { DEFAULT_ENRICH_MODEL } from "../config";
import type {
  EnrichedEmployer,
  ExtractedAction,
  WorkSearchRow,
} from "../types";
import { createResponse } from "./client";

const emptyEnrichment = (notes: string): EnrichedEmployer => {
  return {
    employer_website: "",
    employer_contact: "",
    mailing_address_line_1: "",
    mailing_address_line_2: "",
    city: "",
    state: "",
    zip: "",
    source_url: "",
    confidence: 0,
    notes,
  };
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

export const enrichEmployer = async (
  action: ExtractedAction,
  apiKey?: string,
): Promise<EnrichedEmployer> => {
  if (!apiKey || !action.company || action.confidence < 0.5) {
    return emptyEnrichment("Needs lookup");
  }

  try {
    return await createResponse<EnrichedEmployer>(
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
  } catch (error) {
    return emptyEnrichment(
      `OpenAI company data lookup failed. ${(error as Error).message}`,
    );
  }
};

export const enrichEmployerRow = async (
  row: WorkSearchRow,
  apiKey?: string,
): Promise<EnrichedEmployer> => {
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
  );
};
