import fs from "node:fs/promises";
import path from "node:path";

import { CSV_COLUMNS } from "../config";
import { formatBackupTimestamp } from "../dates";
import type { WorkSearchRow } from "../types";

type CsvColumn = (typeof CSV_COLUMNS)[number];

//
// Parses CSV records from a string, correctly handling quoted fields, embedded commas,
// and line breaks inside quoted values. Returns an array of records, where each record
// is an array of strings representing the CSV columns.
//
// Handles:
//   - Quoted fields: "foo,bar"
//   - Escaped quotes: "my ""quote"""
//   - Newlines inside quotes: "foo\nbar"
//   - Standard unquoted fields
//
// Example:
//   Input:
//     a,b,"c,d"
//     1,2,"hello
//     world"
//   Output:
//     [
//       ["a", "b", "c,d"],
//       ["1", "2", "hello\nworld"]
//     ]
//
// This parser does not handle all edge cases (e.g., malformed CSV), but covers
// the cases needed for local CSV reporting typical in this project.
//
const parseRecords = (content: string): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  // Walk through each character in the CSV string.
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    const isQuote = char === '"';
    const isNextQuote = next === '"';
    const isComma = char === ",";
    const isNewline = char === "\n";
    const isCarriageReturn = char === "\r";

    // Handle double quote ("") as escaped quote within quoted field
    if (inQuotes && isQuote && isNextQuote) {
      field += '"';
      i += 1; // Skip the next quote
    }
    // Closing quote for a quoted field
    else if (inQuotes && isQuote) {
      inQuotes = false;
    }
    // Inside quoted field, just accumulate the character
    else if (inQuotes) {
      field += char;
    }
    // Opening quote for a quoted field
    else if (isQuote) {
      inQuotes = true;
    }
    // Comma outside of quotes marks the end of a field
    else if (isComma) {
      record.push(field);
      field = "";
    }
    // Newline outside quotes marks the end of a record/row
    else if (isNewline) {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    }
    // Ignore carriage returns to handle \r\n or Mac line endings
    else if (!isCarriageReturn) {
      field += char;
    }
  }

  // Add the last field/row if not already added (end of input)
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
};

const emptyRow = (): WorkSearchRow => {
  const row = {} as Record<CsvColumn, string>;
  for (const column of CSV_COLUMNS) row[column] = "";
  return row as WorkSearchRow;
};

// Converts CSV text into typed rows using the header row as the map.
const parseCsv = (content: string): WorkSearchRow[] => {
  const records = parseRecords(content);
  if (records.length === 0) return [];

  const [header, ...rows] = records;
  const headerIndexes = new Map<string, number>();
  header.forEach((column, index) => {
    headerIndexes.set(column, index);
  });

  return rows
    .filter((record) => record.some((cell) => cell.trim() !== ""))
    .map((record) => {
      const row = emptyRow();
      for (const column of CSV_COLUMNS) {
        const index = headerIndexes.get(column);
        row[column] = index === undefined ? "" : (record[index] ?? "");
      }
      return row;
    });
};

// Reads the local ledger, treating a missing file as an empty ledger.
export const readRows = async (csvPath: string): Promise<WorkSearchRow[]> => {
  try {
    const content = await fs.readFile(csvPath, "utf8");
    return parseCsv(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const escapeCsv = (value: string): string => {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
};

// Serializes rows using the fixed Idaho reporting column order.
export const stringifyCsv = (rows: WorkSearchRow[]): string => {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((column) => escapeCsv(row[column] ?? "")).join(","),
  );
  return `${[header, ...lines].join("\n")}\n`;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const timestampForFile = (): string => {
  return formatBackupTimestamp();
};

// Appends new rows after backing up the current CSV.
export const appendRowsWithBackup = async (
  csvPath: string,
  backupDir: string,
  rows: WorkSearchRow[],
): Promise<void> => {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  const existing = await fileExists(csvPath);
  if (existing) {
    // Always backup before appending so manual spreadsheet edits are recoverable.
    const backupPath = path.join(
      backupDir,
      `idaho_work_search_log_${timestampForFile()}.csv`,
    );
    await fs.copyFile(csvPath, backupPath);
  }

  const currentRows = await readRows(csvPath);
  const nextRows = [...currentRows, ...rows];
  await fs.writeFile(csvPath, stringifyCsv(nextRows), "utf8");
};

// Rewrites the CSV after backing up the current file.
export const writeRowsWithBackup = async (
  csvPath: string,
  backupDir: string,
  rows: WorkSearchRow[],
): Promise<void> => {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  const existing = await fileExists(csvPath);
  if (existing) {
    // Enrichment rewrites the file, so backup first.
    const backupPath = path.join(
      backupDir,
      `idaho_work_search_log_${timestampForFile()}.csv`,
    );
    await fs.copyFile(csvPath, backupPath);
  }

  await fs.writeFile(csvPath, stringifyCsv(rows), "utf8");
};
