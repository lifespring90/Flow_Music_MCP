import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_MUSIC_URL = "https://www.flowmusic.app/";
export const HOME_DIR = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const CDP_PORT = Number(process.env.FLOW_MUSIC_MCP_CDP_PORT ?? 9334);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const FLOW_MUSIC_HOST = /^https:\/\/(www\.)?flowmusic\.app(\/|$)/;

const CHROME_PATHS = [
  process.env.FLOW_MUSIC_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;
let lastUrl: string | undefined;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    throw new Error("Google Chrome not found. Set FLOW_MUSIC_MCP_CHROME to the Chrome executable path.");
  }
  return chromePath;
}

async function launchChrome(): Promise<void> {
  const chromePath = chromeExecutable();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      FLOW_MUSIC_URL,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

export async function getMusicPage(): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Music Chrome window.");
  const pages = context.pages();
  const existing =
    pages.find((p) => FLOW_MUSIC_HOST.test(p.url()) && !/accounts\.google\.com/.test(p.url())) ??
    pages.find((p) => FLOW_MUSIC_HOST.test(p.url()) || /accounts\.google\.com/.test(p.url()));

  if (existing) {
    if (FLOW_MUSIC_HOST.test(existing.url())) lastUrl = existing.url();
    return existing;
  }

  const page = await context.newPage();
  await page.goto(lastUrl ?? FLOW_MUSIC_URL, { waitUntil: "domcontentloaded" });
  return page;
}
