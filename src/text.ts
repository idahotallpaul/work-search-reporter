export const normalizeWhitespace = (value: string): string => {
  return value.replace(/\s+/g, " ").trim();
};

// Produces a stable lowercase comparison key for dedupe.
export const normalizeForKey = (value: string): string => {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
};

export const truncate = (value: string, maxLength: number): string => {
  const cleaned = normalizeWhitespace(value);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}...`;
};
