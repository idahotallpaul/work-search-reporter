import { rowSourceKey } from "../rows";
import { normalizeForKey } from "../text";
import type { WeekWindow, WorkSearchRow } from "../types";

type EmailReconciliation = {
  added: number;
  merged: number;
  rows: WorkSearchRow[];
  sourceAliases: Map<string, string>;
};

// ZipRecruiter is also a real employer. Only its platform receipt template
// identifies a second confirmation on behalf of another company.
const isPlatformReceipt = (row: WorkSearchRow): boolean => {
  return (
    /@ziprecruiter\.com\b/i.test(row.source_sender) &&
    /^Your .+ application is complete$/i.test(row.source_subject.trim())
  );
};

const companyKey = (company: string): string => {
  return normalizeForKey(company)
    .replace(/\b(inc|incorporated|llc|ltd|corporation|corp)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

// Restrict automatic pairing to the same day and named employer. Titles must
// agree, or a blank title must have exactly one possible role in that group.
export const reconcileEmailRows = (
  existingRows: readonly WorkSearchRow[],
  candidates: readonly WorkSearchRow[],
  week: WeekWindow,
): EmailReconciliation => {
  const rows = existingRows.map((row) => ({ ...row }));
  const sourceKeys = new Set(rows.map(rowSourceKey));
  for (const candidate of candidates) {
    const key = rowSourceKey(candidate);
    if (!sourceKeys.has(key)) {
      rows.push({ ...candidate });
      sourceKeys.add(key);
    }
  }

  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const company = companyKey(row.company);
    if (
      company &&
      row.action_date >= week.claimWeekStart &&
      row.action_date <= week.claimWeekEnd
    ) {
      const key = `${row.action_date}|${company}`;
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    }
  });

  const removed = new Set<number>();
  const existingRepresentatives = new Set(
    existingRows.map((_, index) => index),
  );
  const sourceAliases = new Map<string, string>();
  for (const group of groups.values()) {
    const titles = new Set(
      group
        .map((index) => normalizeForKey(rows[index].job_title))
        .filter(Boolean),
    );
    for (const platformIndex of group.filter((index) =>
      isPlatformReceipt(rows[index]),
    )) {
      if (!removed.has(platformIndex)) {
        const platform = rows[platformIndex];
        const title = normalizeForKey(platform.job_title);
        const matches = group.filter((index) => {
          const otherTitle = normalizeForKey(rows[index].job_title);
          return (
            index !== platformIndex &&
            !removed.has(index) &&
            ((title && title === otherTitle) ||
              (titles.size === 1 && (!title || !otherTitle)))
          );
        });
        // Keep an employer receipt when available, and prefer an existing CSV
        // row over another platform receipt so manual edits remain authoritative.
        const matchIndex =
          matches.find((index) => !isPlatformReceipt(rows[index])) ??
          matches[0];
        if (matchIndex !== undefined) {
          // A later employer email must not overwrite fields already edited or
          // enriched on a platform row from a previous run.
          const keepIndex =
            platformIndex < existingRows.length &&
            matchIndex >= existingRows.length
              ? platformIndex
              : matchIndex;
          const duplicateIndex =
            keepIndex === platformIndex ? matchIndex : platformIndex;
          const duplicate = rows[duplicateIndex];
          const retained = rows[keepIndex];
          for (const key of Object.keys(retained) as (keyof WorkSearchRow)[]) {
            if (!retained[key].trim()) retained[key] = duplicate[key];
          }
          const note = `Also confirmed by ${duplicate.source_sender} on ${duplicate.source_date}: ${duplicate.source_subject}`;
          for (const extraNote of [duplicate.notes, note]) {
            if (extraNote && !retained.notes.includes(extraNote)) {
              retained.notes = [retained.notes, extraNote]
                .filter(Boolean)
                .join(" | ");
            }
          }
          sourceAliases.set(rowSourceKey(duplicate), rowSourceKey(retained));
          removed.add(duplicateIndex);
          if (existingRepresentatives.has(duplicateIndex)) {
            existingRepresentatives.add(keepIndex);
          }
        }
      }
    }
  }

  return {
    added: rows.filter(
      (_, index) => !removed.has(index) && !existingRepresentatives.has(index),
    ).length,
    merged: removed.size,
    rows: rows.filter((_, index) => !removed.has(index)),
    sourceAliases,
  };
};
