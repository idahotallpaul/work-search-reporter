import path from "node:path";

import dotenv from "dotenv";

import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { countGmailMessages } from "./gmail/messages";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

type CountOptions = {
  weekStart?: string;
};

const requiredValue = (args: string[], index: number, flag: string): string => {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
};

const printHelpAndExit = (): never => {
  console.log(`Usage: pnpm count -- [options]

Options:
  --week-start <date>    Claim week Sunday as YYYY-MM-DD. Defaults to last completed Sunday week.
  --help                 Show this help.
`);
  process.exit(0);
};

const parseArgs = (args: string[]): CountOptions => {
  const options: CountOptions = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--":
        break;
      case "--week-start":
        options.weekStart = requiredValue(args, ++i, arg);
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const week = options.weekStart
    ? getWeekFromStart(options.weekStart)
    : getLastCompletedSundayWeek();
  const { count, query } = await countGmailMessages(week);

  console.log(
    `Claim week: ${week.claimWeekStart} through ${week.claimWeekEnd}`,
  );
  console.log(`Gmail query: ${query}`);
  console.log(`Matching messages: ${count}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
