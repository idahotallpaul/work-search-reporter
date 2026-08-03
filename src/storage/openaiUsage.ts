import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_OPENAI_USAGE_LOG_PATH } from "../config";
import type { OpenAiUsage } from "../openai/client";

type OpenAiUsageLogRecord = {
  approximate_input_characters: number;
  cached_input_tokens?: number;
  candidate_count?: number;
  command: "enrich" | "extract";
  created_at: string;
  input_tokens?: number;
  model: string;
  output_tokens?: number;
  reasoning_tokens?: number;
  row_count?: number;
  total_tokens?: number;
};

export type OpenAiUsageLogArgs = {
  approximateInputCharacters: number;
  candidateCount?: number;
  command: "enrich" | "extract";
  model: string;
  rowCount?: number;
  usages: readonly OpenAiUsage[];
};

// Rough token estimate used only for preflight output, not billing.
export const estimateTokensFromCharacters = (characters: number): number => {
  return Math.ceil(characters / 4);
};

const sumUsageField = (
  usages: readonly OpenAiUsage[],
  key: keyof OpenAiUsage,
): number | undefined => {
  const values = usages.flatMap((usage): number[] => {
    const value = usage[key];
    return typeof value === "number" ? [value] : [];
  });

  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0);
};

// Appends metadata only; no prompts, email bodies, CSV contents, or secrets.
export const writeOpenAiUsageLog = async ({
  approximateInputCharacters,
  candidateCount,
  command,
  model,
  rowCount,
  usages,
}: OpenAiUsageLogArgs): Promise<void> => {
  const record: OpenAiUsageLogRecord = {
    approximate_input_characters: approximateInputCharacters,
    cached_input_tokens: sumUsageField(usages, "cachedInputTokens"),
    candidate_count: candidateCount,
    command,
    created_at: new Date().toISOString(),
    input_tokens: sumUsageField(usages, "inputTokens"),
    model,
    output_tokens: sumUsageField(usages, "outputTokens"),
    reasoning_tokens: sumUsageField(usages, "reasoningTokens"),
    row_count: rowCount,
    total_tokens: sumUsageField(usages, "totalTokens"),
  };

  await fs.mkdir(path.dirname(DEFAULT_OPENAI_USAGE_LOG_PATH), {
    recursive: true,
  });
  await fs.appendFile(
    DEFAULT_OPENAI_USAGE_LOG_PATH,
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
};

export const printOpenAiUsageSummary = (
  usages: readonly OpenAiUsage[],
): void => {
  const totalTokens = sumUsageField(usages, "totalTokens");
  const inputTokens = sumUsageField(usages, "inputTokens");
  const outputTokens = sumUsageField(usages, "outputTokens");

  if (totalTokens === undefined) {
    console.log("OpenAI usage: token totals were not reported.");
    return;
  }

  console.log(
    `OpenAI usage: ${totalTokens} total token(s), ${inputTokens ?? 0} input, ${outputTokens ?? 0} output.`,
  );
};
