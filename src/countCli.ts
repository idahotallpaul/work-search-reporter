import path from "node:path";

import dotenv from "dotenv";

import { getLastCompletedSundayWeek, getWeekFromStart } from "./dates";
import { countGmailMessages } from "./gmail/messages";

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

// Blocks old flag-based usage so weekly runs go through the menu.
const assertNoArgs = (): void => {
  if (process.argv.length > 2) {
    throw new Error("This command does not take flags. Run pnpm start.");
  }
};

// Counts broad Gmail matches for the active claim week without reading bodies.
const main = async (): Promise<void> => {
  assertNoArgs();

  const week = process.env.WORK_SEARCH_WEEK_START
    ? getWeekFromStart(process.env.WORK_SEARCH_WEEK_START)
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
