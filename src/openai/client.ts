type ResponsesRequest = {
  model: string;
  input: unknown;
  text?: unknown;
  tools?: unknown[];
  tool_choice?: "none" | "auto" | "required";
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

// Pulls text out of the Responses API response shapes this app uses.
const extractOutputText = (response: Record<string, unknown>): string => {
  if (typeof response.output_text === "string") return response.output_text;

  // Some Responses API payloads require walking output content manually.
  const output = response.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (isRecord(item) && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (isRecord(contentItem) && typeof contentItem.text === "string") {
          chunks.push(contentItem.text);
        }
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

  const json = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      `OpenAI API error ${response.status}: ${JSON.stringify(json)}`,
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
