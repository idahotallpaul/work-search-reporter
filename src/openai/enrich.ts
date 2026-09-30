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
  knownAddress: {
    city: string;
    line1: string;
    line2: string;
    state: string;
    zip: string;
  };
  sourceUrl: string;
};

const EMPTY_ENRICHMENT_CONTEXT: EnrichmentContext = {
  employerWebsite: "",
  knownAddress: {
    city: "",
    line1: "",
    line2: "",
    state: "",
    zip: "",
  },
  sourceUrl: "",
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
  context: EnrichmentContext = EMPTY_ENRICHMENT_CONTEXT,
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
          content: [
            "Find the best available employer mailing address for a government work-search report.",
            "A usable complete mailing address is the primary goal; employer website and contact details are secondary.",
            "Search broadly and return one best address. Prefer sources in this order: current official employer pages or filings; investor, press, or government records; the employer's verified LinkedIn or Google business listing; reputable business directories or databases; then a registered-agent or incorporation address as a last resort.",
            "The address may be a headquarters, office, corporate mailing address, or registered address. It does not need to be the job's work location or an address that accepts applications.",
            "Do not leave address fields blank merely because the employer does not publish a clearly designated mailing address or because credible sources conflict. Choose the most plausible current complete address, lower confidence appropriately, and explain the source type and uncertainty in notes.",
            "Only leave an address field blank after web search finds no plausible value. Keep all returned address parts internally consistent and set source_url to the page that best supports the chosen address.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            company: action.company,
            job_title: action.job_title,
            known_employer_website: context.employerWebsite,
            known_partial_address: context.knownAddress,
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
      knownAddress: {
        city: row.city,
        line1: row.mailing_address_line_1,
        line2: row.mailing_address_line_2,
        state: row.state,
        zip: row.zip,
      },
      sourceUrl: row.source_url,
    },
  );
};
