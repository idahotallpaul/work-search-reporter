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

// Pulls the address portion out of common "Name <email>" sender strings.
export const extractEmailAddress = (sender: string): string => {
  const angleMatch = /<([^>]+)>/.exec(sender);
  if (angleMatch) return angleMatch[1].toLowerCase();
  const emailMatch = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(sender);
  return emailMatch ? emailMatch[0].toLowerCase() : "";
};

// Returns a readable sender name, falling back to the email local part.
export const senderDisplayName = (sender: string): string => {
  const withoutEmail = sender.replace(/<[^>]+>/g, "").replace(/["']/g, "");
  const cleaned = normalizeWhitespace(withoutEmail);
  if (cleaned) return cleaned;
  const email = extractEmailAddress(sender);
  return email ? email.split("@")[0] : "";
};
