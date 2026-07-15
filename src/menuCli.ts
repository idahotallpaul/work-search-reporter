import { spawn } from "node:child_process";
import path from "node:path";

import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";

type PromptResult = string | boolean | symbol;

type Prompts = {
  cancel: (message?: string) => void;
  confirm: (options: {
    message: string;
    initialValue?: boolean;
  }) => Promise<boolean | symbol>;
  intro: (message?: string) => void;
  isCancel: (value: PromptResult) => value is symbol;
  note: (message: string, title?: string) => void;
  outro: (message?: string) => void;
  select: (options: {
    message: string;
    options: Array<{ label: string; value: string; hint?: string }>;
  }) => Promise<string | symbol>;
  text: (options: {
    message: string;
    placeholder?: string;
  }) => Promise<string | symbol>;
};

type MenuAction = {
  id: string;
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
    id: "count",
    label: "Count matching emails",
    description: "Show how many confirmation-like emails Gmail finds for the week.",
    command: "src/countCli.ts",
    usesWeek: true,
  },
  {
    id: "preview",
    label: "Preview collection",
    description: "Run extraction and print CSV rows without writing anything.",
    command: "src/cli.ts",
    args: ["--dry-run"],
    usesWeek: true,
  },
  {
    id: "collect",
    label: "Collect draft rows",
    description: "Append new confirmation rows to the CSV.",
    command: "src/cli.ts",
    usesWeek: true,
  },
  {
    id: "preview-enrichment",
    label: "Preview enrichment",
    description: "Look up employer details and print a CSV preview without writing.",
    command: "src/enrichCli.ts",
    args: ["--dry-run"],
  },
  {
    id: "enrich",
    label: "Enrich remaining rows",
    description: "Fill missing employer details for rows still in the CSV.",
    command: "src/enrichCli.ts",
  },
  {
    id: "change-week",
    label: "Change week",
    description: "Choose a different Sunday start date.",
    setWeek: true,
  },
  {
    id: "exit",
    label: "Exit",
    description: "Close the menu.",
    exit: true,
  },
];

async function main(): Promise<void> {
  const prompts = await loadPrompts();
  const { confirm, intro, isCancel, outro } = prompts;

  intro("Work Search Reporter");
  let weekStart: string | undefined;

  while (true) {
    const action = await promptForAction(prompts, weekStart);
    if (!action) return;
    if (action.exit) {
      outro("Done.");
      return;
    }

    if (action.setWeek) {
      weekStart = await promptForWeekStart(prompts);
      continue;
    }
    if (!action.command) {
      outro("Done.");
      return;
    }

    const args = [...(action.args || [])];
    if (action.usesWeek && weekStart) {
      args.push("--week-start", weekStart);
    }

    console.log("");
    await runTsNode(action.command, args);
    console.log("");

    const again = await confirm({
      message: "Back to menu?",
      initialValue: true,
    });
    if (isCancel(again) || !again) {
      outro("Done.");
      return;
    }
  }
}

async function promptForAction(
  prompts: Prompts,
  weekStart: string | undefined,
): Promise<MenuAction | undefined> {
  const { cancel, isCancel, note, select } = prompts;
  const activeWeek = weekStart
    ? getWeekFromStart(weekStart)
    : getLastCompletedSundayWeek();

  note(
    `${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd}`,
    "Active claim week",
  );
  const selected = await select({
    message: "Choose an action",
    options: actions.map((action) => ({
      label: action.label,
      value: action.id,
      hint: action.description,
    })),
  });

  if (isCancel(selected)) {
    cancel("Canceled.");
    return undefined;
  }
  return actions.find((action) => action.id === selected);
}

async function promptForWeekStart(
  prompts: Prompts,
): Promise<string | undefined> {
  const { cancel, isCancel, note, text } = prompts;
  const defaultWeek = getLastCompletedSundayWeek();
  const answer = await text({
    message: "Enter a Sunday start date, or leave blank for the default",
    placeholder: defaultWeek.claimWeekStart,
  });

  if (isCancel(answer)) {
    cancel("Canceled.");
    return undefined;
  }

  const weekStart = answer.trim();
  if (!weekStart) return undefined;

  const week = getWeekFromStart(weekStart);
  note(`${week.claimWeekStart} through ${week.claimWeekEnd}`, "Using claim week");
  return week.claimWeekStart;
}

async function loadPrompts(): Promise<Prompts> {
  return import("@clack/prompts") as Promise<Prompts>;
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
