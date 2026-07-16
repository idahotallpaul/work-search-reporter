import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { chromium, type Page } from "playwright-core";

import type { WeekWindow } from "../types";

const JOBRIGHT_APPLIED_URL = "https://jobright.ai/jobs/applied";
const JOBRIGHT_PROFILE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "cache",
  "jobright-browser",
);

export type JobrightAppliedJob = {
  appliedDate: string;
  appliedDateText: string;
  company: string;
  jobTitle: string;
  sourceUrl: string;
};

type RawJobrightAppliedJob = {
  appliedDateText: string;
  company: string;
  jobTitle: string;
  sourceUrl: string;
};

type AppliedPageStatus = {
  ready: boolean;
  snippet: string;
  title: string;
  url: string;
};

type AppliedScrollStatus = {
  scrollHeight: number;
  scrollTop: number;
  targetCount: number;
};

// Waits for the user to finish login in the browser window.
const waitForEnter = async (message: string): Promise<void> => {
  const rl = createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
};

// Parses Jobright's displayed applied date into YYYY-MM-DD.
const parseAppliedDate = (value: string): string => {
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/.exec(
      value.trim(),
    );
  if (!match) throw new Error(`Unable to parse Jobright date: ${value}`);

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const [, monthName, day, year] = match;
  const month = String(monthNames.indexOf(monthName) + 1).padStart(2, "0");
  return `${year}-${month}-${day.padStart(2, "0")}`;
};

// Reads enough page state to decide whether Jobright has finished rendering.
const getAppliedPageStatus = async (page: Page): Promise<AppliedPageStatus> => {
  return page.evaluate(() => {
    const text = document.body.innerText || "";
    const onAppliedRoute =
      location.hostname.includes("jobright.ai") &&
      location.pathname.includes("/jobs/applied");
    const hasAppliedTab = /Applied\s*\(?\d*\)?/.test(text);
    const hasAppliedDate = /Applied on\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/.test(
      text,
    );

    return {
      ready:
        onAppliedRoute &&
        (hasAppliedTab ||
          hasAppliedDate ||
          document.title.includes("Applied Jobs")),
      snippet: text.slice(0, 500).replace(/\s+/g, " ").trim(),
      title: document.title,
      url: location.href,
    };
  });
};

// Waits for Jobright's client-rendered Applied tab content.
const waitForAppliedPage = async (
  page: Page,
  timeoutMs: number,
): Promise<AppliedPageStatus> => {
  const startedAt = Date.now();
  let status = await getAppliedPageStatus(page);

  while (!status.ready && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    status = await getAppliedPageStatus(page);
  }

  return status;
};

// Scrapes visible applied-job cards from the Jobright page.
const scrapeAppliedJobs = async (
  page: Page,
): Promise<RawJobrightAppliedJob[]> => {
  return page.evaluate(() => {
    type ScrapedJob = {
      appliedDateText: string;
      company: string;
      jobTitle: string;
      sourceUrl: string;
    };

    const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
    const datePattern = /Applied on\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/;

    const titleWithoutCompany = (title: string, company: string): string => {
      const atMatch = /^(.+?)\s+at\s+(.+)$/i.exec(title);
      if (!atMatch) return title;
      if (!company || clean(atMatch[2]) === company) return clean(atMatch[1]);
      return title;
    };

    const jobMap = new Map<string, ScrapedJob>();
    const cardLinks = [
      ...document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/info/"]'),
    ];

    for (const link of cardLinks) {
      const titleElement = link.querySelector<HTMLElement>(
        'h2[class*="job-title"]',
      );
      const companyElement = link.querySelector<HTMLElement>(
        '[class*="company-name"]',
      );
      const actionElement =
        link.parentElement?.querySelector<HTMLElement>('[class*="actions"]');
      const dateMatch = datePattern.exec(actionElement?.textContent || "");
      if (!dateMatch) continue;

      const titleLine = clean(titleElement?.textContent || "");
      const company = clean(companyElement?.textContent || "");
      const jobTitle = titleWithoutCompany(titleLine, company);
      if (!jobTitle || !company) continue;

      const sourceUrl = new URL(
        link.getAttribute("href") || "",
        location.origin,
      ).toString();
      const appliedDateText = dateMatch[1];
      const key = `${jobTitle}|${company}|${appliedDateText}`;

      jobMap.set(key, {
        appliedDateText,
        company,
        jobTitle,
        sourceUrl,
      });
    }

    return [...jobMap.values()];
  });
};

// Moves the nested Jobright jobs pane back to the top before scanning.
const resetAppliedListScroll = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const scrollElement =
      document.querySelector<HTMLElement>("#jobs-page-main-content") ||
      document.scrollingElement;
    if (scrollElement) scrollElement.scrollTop = 0;
  });
  await page.waitForTimeout(800);
};

// Advances the nested jobs pane and returns the new scroll state.
const advanceAppliedListScroll = async (
  page: Page,
): Promise<AppliedScrollStatus> => {
  return page.evaluate(() => {
    const text = document.body.innerText || "";
    const targetMatch = /Applied\((\d+)\)/.exec(text);
    const targetCount = targetMatch ? Number(targetMatch[1]) : 0;
    const scrollElement =
      document.querySelector<HTMLElement>("#jobs-page-main-content") ||
      ([...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.scrollHeight > element.clientHeight + 100)
        .sort((left, right) => {
          return (
            right.scrollHeight -
            right.clientHeight -
            (left.scrollHeight - left.clientHeight)
          );
        })[0] ??
        document.scrollingElement);

    if (scrollElement) {
      scrollElement.scrollTop += Math.max(
        scrollElement.clientHeight * 0.85,
        700,
      );
      scrollElement.dispatchEvent(new Event("scroll", { bubbles: true }));
      scrollElement.dispatchEvent(new Event("wheel", { bubbles: true }));
    }

    return {
      scrollHeight: scrollElement?.scrollHeight ?? 0,
      scrollTop: scrollElement?.scrollTop ?? 0,
      targetCount,
    };
  });
};

// Scans virtualized/infinite Jobright cards by scraping each scroll position.
const scrapeAllAppliedJobs = async (
  page: Page,
): Promise<RawJobrightAppliedJob[]> => {
  const jobMap = new Map<string, RawJobrightAppliedJob>();
  let previousStatus: AppliedScrollStatus | undefined;
  let previousSize = -1;
  let stablePasses = 0;

  await resetAppliedListScroll(page);

  for (let pass = 0; pass < 80; pass += 1) {
    const visibleJobs = await scrapeAppliedJobs(page);
    for (const job of visibleJobs) {
      const key = `${job.jobTitle}|${job.company}|${job.appliedDateText}`;
      jobMap.set(key, job);
    }

    const status = await advanceAppliedListScroll(page);
    const reachedKnownTotal =
      status.targetCount > 0 && jobMap.size >= status.targetCount;
    const unchanged =
      previousStatus &&
      jobMap.size === previousSize &&
      status.scrollHeight === previousStatus.scrollHeight &&
      status.scrollTop === previousStatus.scrollTop;

    if (unchanged) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      previousSize = jobMap.size;
      previousStatus = status;
    }

    if (reachedKnownTotal || stablePasses >= 4) return [...jobMap.values()];

    await page.waitForTimeout(1200);
  }

  return [...jobMap.values()];
};

// Reads Jobright Applied jobs from the dedicated browser profile.
export const collectJobrightAppliedJobs = async (
  week: WeekWindow,
): Promise<JobrightAppliedJob[]> => {
  await fs.mkdir(JOBRIGHT_PROFILE_PATH, { recursive: true });

  const context = await chromium.launchPersistentContext(
    JOBRIGHT_PROFILE_PATH,
    {
      channel: "chrome",
      headless: false,
      viewport: { width: 1440, height: 1000 },
    },
  );

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(JOBRIGHT_APPLIED_URL, { waitUntil: "domcontentloaded" });

    let status = await waitForAppliedPage(page, 10_000);
    if (!status.ready) {
      await waitForEnter(
        "Log into Jobright in the opened browser, go to the Applied tab, then press Enter here.",
      );
      await page.goto(JOBRIGHT_APPLIED_URL, { waitUntil: "domcontentloaded" });
      status = await waitForAppliedPage(page, 15_000);
    }

    if (!status.ready) {
      throw new Error(
        [
          "Jobright Applied tab was not visible after login.",
          `Current page: ${status.url}`,
          `Title: ${status.title || "(none)"}`,
          `Page text: ${status.snippet || "(empty)"}`,
        ].join("\n"),
      );
    }

    const rawJobs = await scrapeAllAppliedJobs(page);
    const jobs = rawJobs.map((job) => ({
      ...job,
      appliedDate: parseAppliedDate(job.appliedDateText),
    }));

    return jobs.filter((job) => {
      return (
        job.appliedDate >= week.claimWeekStart &&
        job.appliedDate <= week.claimWeekEnd
      );
    });
  } finally {
    await context.close();
  }
};
