import fs from "node:fs/promises";
import path from "node:path";

import { CSV_COLUMNS } from "../config";
import type { WorkSearchRow } from "../types";

type CsvColumn = (typeof CSV_COLUMNS)[number];

const parseRecords = (content: string): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

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
  return new Date().toISOString().replace(/[:.]/g, "-");
};

export const appendRowsWithBackup = async (
  csvPath: string,
  backupDir: string,
  rows: WorkSearchRow[],
): Promise<void> => {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  const existing = await fileExists(csvPath);
  if (existing) {
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

export const writeRowsWithBackup = async (
  csvPath: string,
  backupDir: string,
  rows: WorkSearchRow[],
): Promise<void> => {
  await fs.mkdir(path.dirname(csvPath), { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  const existing = await fileExists(csvPath);
  if (existing) {
    const backupPath = path.join(
      backupDir,
      `idaho_work_search_log_${timestampForFile()}.csv`,
    );
    await fs.copyFile(csvPath, backupPath);
  }

  await fs.writeFile(csvPath, stringifyCsv(rows), "utf8");
};
