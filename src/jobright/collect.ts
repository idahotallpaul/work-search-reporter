import fs from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "playwright-core";

import { parseJobrightAppliedDate } from "../dates";
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
  authenticated: boolean;
  loggedOut: boolean;
  ready: boolean;
  snippet: string;
  title: string;
  url: string;
};

const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

type AppliedScrollStatus = {
  scrollHeight: number;
  scrollTop: number;
  targetCount: number;
};

// True for Jobright pages. OAuth windows such as accounts.google.com stay outside
// this check so an in-progress sign-in is not interrupted.
const isJobrightHost = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "jobright.ai" || hostname.endsWith(".jobright.ai");
  } catch {
    return false;
  }
};

// Distinguishes a signed-out homepage, a valid login, and a fully rendered list.
// Jobright displays the Applied tab and page title while its job-card request is
// still in flight, so those signals alone must not allow scraping to begin.
const getAppliedPageStatus = async (page: Page): Promise<AppliedPageStatus> => {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const hostname = location.hostname;
    const onJobright =
      hostname === "jobright.ai" || hostname.endsWith(".jobright.ai");
    const onAppliedRoute =
      onJobright && location.pathname.includes("/jobs/applied");
    const onMarketingHome = onJobright && location.pathname === "/";
    const buttonLabels = [...document.querySelectorAll("button")].map(
      (button) => (button.textContent || "").replace(/\s+/g, " ").trim(),
    );
    const hasSignInButton = buttonLabels.includes("SIGN IN");
    const hasLoginForm = Boolean(
      document.querySelector("#basic_email, #basic_password"),
    );
    const loggedOut =
      onJobright && (hasSignInButton || hasLoginForm || onMarketingHome);
    const appliedCountMatch = /Applied\((\d+)\)/.exec(text);
    const appliedCount = appliedCountMatch
      ? Number(appliedCountMatch[1])
      : undefined;
    const hasAppliedDate = /Applied on\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/.test(
      text,
    );
    const authenticated =
      onAppliedRoute &&
      !loggedOut &&
      (appliedCount !== undefined || document.title.includes("Applied Jobs"));

    return {
      authenticated,
      loggedOut,
      ready: authenticated && (hasAppliedDate || appliedCount === 0),
      snippet: text.slice(0, 500).replace(/\s+/g, " ").trim(),
      title: document.title,
      url: location.href,
    };
  });
};

// Opens the homepage sign-in dialog. The user still completes Google, Apple, or
// email sign-in themselves; this only reveals that form.
const openSignInDialog = async (page: Page): Promise<boolean> => {
  const emailField = page.locator("#basic_email");
  if (await emailField.isVisible().catch(() => false)) return true;

  try {
    await page
      .getByRole("button", { name: "SIGN IN", exact: true })
      .first()
      .click({ timeout: 8_000 });
    await emailField.waitFor({ state: "visible", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
};

// Waits for Jobright's client-rendered Applied tab content.
const waitForAppliedPage = async (
  page: Page,
  timeoutMs: number,
): Promise<AppliedPageStatus> => {
  const startedAt = Date.now();
  let status = await getAppliedPageStatus(page);

  while (
    !status.ready &&
    !status.loggedOut &&
    Date.now() - startedAt < timeoutMs
  ) {
    await page.waitForTimeout(500);
    status = await getAppliedPageStatus(page);
  }

  // A signed-out visit can paint the Applied title for a moment before Jobright
  // redirects home. Confirm the list is still present before scraping.
  if (status.ready) {
    await page.waitForTimeout(750);
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

      if (dateMatch) {
        const titleLine = clean(titleElement?.textContent || "");
        const company = clean(companyElement?.textContent || "");
        const jobTitle = titleWithoutCompany(titleLine, company);

        if (jobTitle && company) {
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
      }
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

// Jobright lists applied jobs newest first. Newer out-of-week jobs can appear
// before the selected week, so only an older-than-week row is a safe cutoff.
const hasReachedOlderApplications = (
  jobs: readonly RawJobrightAppliedJob[],
  week: WeekWindow,
): boolean => {
  return jobs.some((job) => {
    return parseJobrightAppliedDate(job.appliedDateText) < week.claimWeekStart;
  });
};

// Scans virtualized/infinite Jobright cards by scraping each scroll position.
const scrapeAllAppliedJobs = async (
  page: Page,
  week: WeekWindow,
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

    if (hasReachedOlderApplications(visibleJobs, week)) {
      console.log(
        `Reached Jobright applications older than ${week.claimWeekStart}; stopping scan.`,
      );
      return [...jobMap.values()];
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

// Describes the page captured when Jobright auth or loading fails.
const describeAppliedPage = (status: AppliedPageStatus): string => {
  return [
    `Current page: ${status.url}`,
    `Title: ${status.title || "(none)"}`,
    `Page text: ${status.snippet || "(empty)"}`,
  ].join("\n");
};

// Opens sign-in when the saved browser profile is logged out, then waits until
// the Applied tab is ready. Sign-in itself stays in the browser window.
const ensureSignedInAppliedPage = async (
  page: Page,
): Promise<AppliedPageStatus> => {
  const startedAt = Date.now();
  let announced = false;
  let lastOpenAttempt = 0;

  while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
    const status = await getAppliedPageStatus(page);
    if (status.ready) {
      await page.waitForTimeout(750);
      const confirmed = await getAppliedPageStatus(page);
      if (confirmed.ready) return confirmed;
    } else if (!isJobrightHost(status.url)) {
      if (!announced) {
        announced = true;
        console.log(
          "Complete Jobright sign-in in the browser window. Scraping continues after the Applied tab loads.",
        );
      }
    } else if (status.loggedOut) {
      const dialogOpen = await page
        .locator("#basic_email")
        .isVisible()
        .catch(() => false);
      if (!dialogOpen && Date.now() - lastOpenAttempt > 3_000) {
        lastOpenAttempt = Date.now();
        const opened = await openSignInDialog(page);
        if (!announced) {
          announced = true;
          console.log(
            opened
              ? "Jobright is not signed in. Complete sign-in in the browser window. Scraping continues after the Applied tab loads."
              : "Jobright is not signed in. Use SIGN IN in the browser window. Scraping continues after the Applied tab loads.",
          );
        }
      } else if (!announced) {
        announced = true;
        console.log(
          "Jobright is not signed in. Complete sign-in in the browser window. Scraping continues after the Applied tab loads.",
        );
      }
    } else if (!status.authenticated) {
      // Stay on the Applied route while it renders. Only leave other Jobright
      // pages, such as the post-login recommendations screen.
      if (!status.url.includes("/jobs/applied")) {
        await page.goto(JOBRIGHT_APPLIED_URL, {
          waitUntil: "domcontentloaded",
        });
      }
    } else {
      const loaded = await waitForAppliedPage(page, 15_000);
      if (loaded.ready) return loaded;
    }

    await page.waitForTimeout(500);
  }

  return getAppliedPageStatus(page);
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

    let status = await waitForAppliedPage(page, 12_000);
    if (!status.ready) {
      status = await ensureSignedInAppliedPage(page);
    }

    if (!status.ready) {
      const reason = status.loggedOut
        ? "Jobright sign-in was not completed."
        : status.authenticated
          ? "Jobright is logged in, but the Applied jobs list did not finish loading."
          : "Jobright Applied tab was not visible after login.";
      throw new Error([reason, describeAppliedPage(status)].join("\n"));
    }

    const rawJobs = await scrapeAllAppliedJobs(page, week);
    const jobs = rawJobs.map((job) => ({
      ...job,
      appliedDate: parseJobrightAppliedDate(job.appliedDateText),
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
