type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

type ResponsesMessage = {
  role: "system" | "user";
  content: string;
};

type ResponsesTextFormat = {
  format: {
    type: "json_schema";
    name: string;
    strict: true;
    schema: JsonObject;
  };
};

type ResponsesTool = {
  type: "web_search";
};

type ResponsesRequest = {
  model: string;
  input: ResponsesMessage[];
  text?: ResponsesTextFormat;
  tools?: ResponsesTool[];
  tool_choice?: "none" | "auto" | "required";
};

type ResponsesContentItem = {
  text?: string;
};

type ResponsesOutputItem = {
  content?: ResponsesContentItem[];
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: ResponsesOutputItem[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

// Converts untrusted API JSON into the response subset this app reads.
const parseResponsesApiResponse = (value: unknown): ResponsesApiResponse => {
  if (!isRecord(value)) return {};

  const output = Array.isArray(value.output)
    ? value.output.flatMap((item): ResponsesOutputItem[] => {
        if (!isRecord(item) || !Array.isArray(item.content)) return [];

        const content = item.content.flatMap(
          (contentItem): ResponsesContentItem[] => {
            if (!isRecord(contentItem)) return [];
            return typeof contentItem.text === "string"
              ? [{ text: contentItem.text }]
              : [];
          },
        );

        return [{ content }];
      })
    : undefined;

  return {
    output_text:
      typeof value.output_text === "string" ? value.output_text : undefined,
    output,
  };
};

// Pulls text out of the Responses API response shapes this app uses.
const extractOutputText = (response: ResponsesApiResponse): string => {
  if (typeof response.output_text === "string") return response.output_text;

  // Some Responses API payloads require walking output content manually.
  const output = response.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (item.content) {
      for (const contentItem of item.content) {
        if (contentItem.text) chunks.push(contentItem.text);
      }
    }
  }

  return chunks.join("");
};

// Sends a raw Responses API request and parses the JSON output.
export const createResponse = async <T>(
  request: ResponsesRequest,
  apiKey: string,
): Promise<T> => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const rawJson: unknown = await response.json();
  const json = parseResponsesApiResponse(rawJson);

  if (!response.ok) {
    throw new Error(
      `OpenAI API error ${response.status}: ${JSON.stringify(rawJson)}`,
    );
  }

  const text = extractOutputText(json);
  if (!text) {
    throw new Error(
      `OpenAI response did not include output text: ${JSON.stringify(json)}`,
    );
  }

  // Callers supply strict JSON schemas, so a parse failure should be loud.
  return JSON.parse(text) as T;
};
