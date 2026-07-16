import { spawn } from "node:child_process";
import path from "node:path";

import {
  formatLocalDate,
  getCurrentSundayWeek,
  getLastCompletedSundayWeek,
  getWeekFromStart,
  parseIsoLocalDate,
  subtractLocalWeeks,
} from "./dates";

type PromptResult = string | symbol;

type Prompts = {
  cancel: (message?: string) => void;
  intro: (message?: string) => void;
  isCancel: (value: PromptResult) => value is symbol;
  note: (message: string, title?: string) => void;
  outro: (message?: string) => void;
  select: (options: {
    message: string;
    options: Array<{ label: string; value: string; hint?: string }>;
    initialValue?: string;
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
  usesWeek?: boolean;
  setWeek?: boolean;
  exit?: boolean;
};

type WeekChoice = {
  label: string;
  value: string;
  hint?: string;
};

const actions: MenuAction[] = [
  {
    id: "change-week",
    label: "Change week",
    description: "Choose a different Sunday start date.",
    setWeek: true,
  },
  {
    id: "count",
    label: "Count matching emails",
    description:
      "Show how many confirmation-like emails Gmail finds for the week.",
    command: "src/countCli.ts",
    usesWeek: true,
  },
  {
    id: "collect",
    label: "Fetch application confirmation emails",
    description: "Find confirmation emails and add them to the CSV.",
    command: "src/cli.ts",
    usesWeek: true,
  },
  {
    id: "jobright",
    label: "Fetch Jobright applied jobs",
    description: "Read Jobright's Applied tab and reconcile rows into the CSV.",
    command: "src/jobrightCli.ts",
    usesWeek: true,
  },
  {
    id: "enrich",
    label: "Fetch missing company data",
    description:
      "Fill missing website, contact, and address fields in the CSV.",
    command: "src/enrichCli.ts",
  },
  {
    id: "exit",
    label: "Exit",
    description: "Close the menu.",
    exit: true,
  },
];

// Shows the main menu and returns the selected action.
const promptForAction = async (
  prompts: Prompts,
  weekStart: string | undefined,
): Promise<MenuAction | undefined> => {
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
      hint:
        action.id === "change-week"
          ? `Current selection: ${activeWeek.claimWeekStart} through ${activeWeek.claimWeekEnd}`
          : action.description,
    })),
  });

  if (isCancel(selected)) {
    cancel("Canceled.");
    return undefined;
  }
  return actions.find((action) => action.id === selected);
};

// Builds the selectable Sunday-start weeks shown in the week picker.
const buildWeekChoices = (
  activeWeekStart: string | undefined,
): WeekChoice[] => {
  const currentWeek = getCurrentSundayWeek();
  const lastCompletedWeek = getLastCompletedSundayWeek();
  const weekStarts = new Set<string>([
    currentWeek.claimWeekStart,
    lastCompletedWeek.claimWeekStart,
  ]);
  if (activeWeekStart) weekStarts.add(activeWeekStart);

  // Keep enough recent Sundays visible for normal weekly reporting.
  let previousStart = parseIsoLocalDate(lastCompletedWeek.claimWeekStart);
  for (let i = 0; i < 8; i += 1) {
    weekStarts.add(formatLocalDate(previousStart));
    previousStart = subtractLocalWeeks(previousStart, 1);
  }

  const choices: WeekChoice[] = [...weekStarts]
    .sort()
    .reverse()
    .map((start) => {
      const week = getWeekFromStart(start);
      const labels = [];
      if (start === activeWeekStart) labels.push("active week");
      if (start === currentWeek.claimWeekStart) labels.push("current week");
      if (start === lastCompletedWeek.claimWeekStart) {
        labels.push("last completed week");
      }

      return {
        label: `${week.claimWeekStart} through ${week.claimWeekEnd}`,
        value: week.claimWeekStart,
        hint: labels.join(", ") || undefined,
      };
    });

  choices.push(
    {
      label: "Enter a date manually",
      value: "manual",
      hint: "Use a Sunday start date",
    },
    {
      label: "Back to menu",
      value: "back",
    },
  );

  return choices;
};

// Prompts for a new claim week while preserving the old selection on cancel.
const promptForWeekStart = async (
  prompts: Prompts,
  currentWeekStart: string | undefined,
): Promise<string | undefined> => {
  const { cancel, isCancel, note, select, text } = prompts;
  const defaultWeek = getLastCompletedSundayWeek();
  const activeWeekStart = currentWeekStart ?? defaultWeek.claimWeekStart;
  const selected = await select({
    message: "Choose claim week",
    options: buildWeekChoices(activeWeekStart),
    initialValue: activeWeekStart,
  });

  if (isCancel(selected)) {
    cancel("Canceled.");
    return currentWeekStart;
  }

  if (selected === "back") return currentWeekStart;
  if (selected !== "manual") {
    const week = getWeekFromStart(selected);
    note(
      `${week.claimWeekStart} through ${week.claimWeekEnd}`,
      "Using claim week",
    );
    return week.claimWeekStart;
  }

  const answer = await text({
    message: "Enter a Sunday start date",
    placeholder: defaultWeek.claimWeekStart,
  });

  if (isCancel(answer)) {
    cancel("Canceled.");
    return currentWeekStart;
  }

  const weekStart = answer.trim();
  if (!weekStart) return currentWeekStart;

  const week = getWeekFromStart(weekStart);
  note(
    `${week.claimWeekStart} through ${week.claimWeekEnd}`,
    "Using claim week",
  );
  return week.claimWeekStart;
};

// Loads Clack lazily so the command modules stay non-interactive.
const loadPrompts = async (): Promise<Prompts> => {
  return import("@clack/prompts") as Promise<Prompts>;
};

// Runs one internal command script from the menu process.
const runTsNode = (
  scriptPath: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> => {
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
      ["--project", "tsconfig.json", scriptPath],
      {
        cwd: path.resolve(__dirname, ".."),
        // The selected week is internal state, not a user-facing CLI flag.
        env: { ...process.env, ...env },
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
};

// Keeps the menu open until the user exits or cancels.
const main = async (): Promise<void> => {
  const prompts = await loadPrompts();
  const { intro, outro } = prompts;

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
      weekStart = await promptForWeekStart(prompts, weekStart);
      continue;
    }
    if (!action.command) {
      outro("Done.");
      return;
    }

    const env =
      action.usesWeek && weekStart ? { WORK_SEARCH_WEEK_START: weekStart } : {};

    console.log("");
    await runTsNode(action.command, env);
    console.log("");
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
