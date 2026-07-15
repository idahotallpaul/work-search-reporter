import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";

type MenuAction = {
  label: string;
  description: string;
  command?: string;
  args?: string[];
  usesWeek?: boolean;
  setWeek?: boolean;
  exit?: boolean;
};

const actions: MenuAction[] = [
  {
    label: "Count matching emails",
    description: "Show how many confirmation-like emails Gmail finds for the week.",
    command: "src/countCli.ts",
    usesWeek: true,
  },
  {
    label: "Preview collection",
    description: "Run extraction and print CSV rows without writing anything.",
    command: "src/cli.ts",
    args: ["--dry-run"],
    usesWeek: true,
  },
  {
    label: "Collect draft rows",
    description: "Append new confirmation rows to the CSV.",
    command: "src/cli.ts",
    usesWeek: true,
  },
  {
    label: "Preview enrichment",
    description: "Look up employer details and print a CSV preview without writing.",
    command: "src/enrichCli.ts",
    args: ["--dry-run"],
  },
  {
    label: "Enrich remaining rows",
    description: "Fill missing employer details for rows still in the CSV.",
    command: "src/enrichCli.ts",
  },
  {
    label: "Change week",
    description: "Choose a different Sunday start date.",
    setWeek: true,
  },
  {
    label: "Exit",
    description: "Close the menu.",
    exit: true,
  },
];

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  let weekStart: string | undefined;
  try {
    while (true) {
      const choice = await promptForAction(rl, weekStart);
      const action = actions[choice];
      if (action.exit) return;
      if (action.setWeek) {
        weekStart = await promptForWeekStart(rl);
        continue;
      }
      if (!action.command) return;

      const args = [...(action.args || [])];
      if (action.usesWeek && weekStart) {
        args.push("--week-start", weekStart);
      }

      console.log("");
      await runTsNode(action.command, args);
      console.log("");

      const again = await safeQuestion(rl, "Back to menu? [Y/n] ");
      if (again === undefined || again.trim().toLowerCase() === "n") return;
    }
  } finally {
    rl.close();
  }
}

async function safeQuestion(
  rl: readline.Interface,
  prompt: string,
): Promise<string | undefined> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if ((error as Error).message.includes("readline was closed")) {
      return undefined;
    }
    throw error;
  }
}

async function promptForAction(
  rl: readline.Interface,
  weekStart: string | undefined,
): Promise<number> {
  const activeWeek = weekStart
    ? getWeekFromStart(weekStart)
    : getLastCompletedSundayWeek();
  console.log("\nWork Search Reporter");
  console.log("====================");
  console.log(
    `Active claim week: ${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd}`,
  );
  actions.forEach((action, index) => {
    console.log(`${index + 1}. ${action.label}`);
    console.log(`   ${action.description}`);
  });

  while (true) {
    const answer = await rl.question("\nChoose an option: ");
    const choice = Number(answer.trim());
    if (Number.isInteger(choice) && choice >= 1 && choice <= actions.length) {
      return choice - 1;
    }
    console.log(`Enter a number from 1 to ${actions.length}.`);
  }
}

async function promptForWeekStart(
  rl: readline.Interface,
): Promise<string | undefined> {
  const defaultWeek = getLastCompletedSundayWeek();
  console.log(
    `\nDefault claim week: ${defaultWeek.claimWeekStart} through ${defaultWeek.claimWeekEnd}`,
  );
  const answer = await rl.question(
    "Press Enter to return to the default, or enter a Sunday start date (YYYY-MM-DD): ",
  );
  const weekStart = answer.trim();
  if (!weekStart) return undefined;

  const week = getWeekFromStart(weekStart);
  console.log(`Using claim week: ${week.claimWeekStart} through ${week.claimWeekEnd}`);
  return week.claimWeekStart;
}

function runTsNode(scriptPath: string, args: string[]): Promise<void> {
  const tsNodePath = path.resolve(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    "ts-node",
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      tsNodePath,
      ["--project", "tsconfig.json", scriptPath, ...args],
      {
        cwd: path.resolve(__dirname, ".."),
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${scriptPath} exited with code ${code}`));
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
