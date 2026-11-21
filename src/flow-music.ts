import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { FLOW_MUSIC_URL, HOME_DIR, getMusicPage } from "./chrome.js";
import { extractZip } from "./platform.js";
import type { AudioFormat, GeneratedTrackInfo, JobRunResult, MusicJob } from "./queue.js";

export interface MusicState {
  url: string;
  signedIn: boolean;
  username?: string;
  plan?: string;
  credits_remaining?: number;
  hint?: string;
}

export interface LibraryTrack {
  id: string;
  title: string;
  description: string;
  duration?: string;
  url: string;
}

const GENERATION_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

const FORMAT_MENU_LABEL: Record<AudioFormat, string> = {
  mp3: "MP3",
  wav: "WAV",
  m4a: "M4A",
  stems: "Get stems",
  video: "Download video",
};

const FORMAT_EXT: Record<AudioFormat, string> = {
  mp3: ".mp3",
  wav: ".wav",
  m4a: ".m4a",
  stems: ".zip",
  video: ".mp4",
};

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

function safeReaddir(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

function downloadsNow(): Set<string> {
  const seen = new Set<string>();
  for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) {
    for (const f of safeReaddir(dir)) seen.add(`${dir}/${f}`);
  }
  return seen;
}

async function useOwnDownloadDir(page: Page): Promise<void> {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp
    .send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    })
    .catch(() => {});
}

async function waitForDownloadedFile(page: Page, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(page, 250);
    const candidates: string[] = [];
    for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) {
      for (const f of safeReaddir(dir)) {
        if (before.has(`${dir}/${f}`) || f.endsWith(".crdownload") || f.endsWith(".tmp") || f.startsWith(".")) continue;
        candidates.push(join(dir, f));
      }
    }
    for (const filePath of candidates) {
      const size = statSync(filePath).size;
      if (stable?.path === filePath && stable.size === size && size > 0) return filePath;
      stable = { path: filePath, size };
    }
  }
  throw new Error("Flow Music triggered a download, but no completed file arrived in ~/.flow-music-mcp/downloads or ~/Downloads.");
}

function extensionOf(file: string, fallbackExt: string): string {
  const head = Buffer.alloc(16);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  // ID3v2 header or MPEG ADTS/MP3 frame sync
  if (head.subarray(0, 3).toString("latin1") === "ID3") return ".mp3";
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return ".mp3";
  // RIFF WAVE
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") return ".wav";
  // ISO Base Media (M4A / MP4)
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return fallbackExt === ".mp4" ? ".mp4" : ".m4a";
  // FLAC / OGG / ZIP
  if (head.subarray(0, 4).toString("latin1") === "fLaC") return ".flac";
  if (head.subarray(0, 4).toString("latin1") === "OggS") return ".ogg";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  const current = extname(file).toLowerCase();
  return current || fallbackExt;
}

function moveFileSafe(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  try {
    unlinkSync(src);
  } catch {
    // Ignore if source was already removed or locked.
  }
}

function uniquePath(dir: string, stem: string, ext: string): string {
  const safeStem = stem.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "track";
  let candidate = join(dir, `${safeStem}${ext}`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${safeStem}-${n}${ext}`);
    n++;
  }
  return candidate;
}

export function slugify(text: string, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.slice(0, maxLen) || "track";
}

async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const openMenu = page.locator("[role='menu'], [role='dialog']").first();
    if (!(await openMenu.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape").catch(() => {});
    await pause(page, 250);
  }
}

async function ensureSignedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (/accounts\.google\.com|\/auth\b/.test(url)) return false;
  if (!/^https:\/\/(www\.)?flowmusic\.app/.test(url)) {
    await page.goto(FLOW_MUSIC_URL, { waitUntil: "domcontentloaded" });
    await pause(page, 1500);
    if (/accounts\.google\.com|\/auth\b/.test(page.url())) return false;
  }
  const settingsBtn = page.getByRole("button", { name: "Settings menu" });
  return settingsBtn.isVisible({ timeout: 4000 }).catch(() => false);
}

async function readAccountInfo(page: Page): Promise<{ username?: string; plan?: string; credits_remaining?: number }> {
  await dismissOverlays(page);
  const settingsBtn = page.getByRole("button", { name: "Settings menu" });
  if (!(await settingsBtn.isVisible({ timeout: 4000 }).catch(() => false))) return {};

  await settingsBtn.click({ timeout: 5000 });
  try {
    const menu = page.getByRole("menu").last();
    await menu.waitFor({ state: "visible", timeout: 5000 });
    const text = (await menu.innerText()).trim();
    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const creditsMatch = text.match(/([\d,]+)\s+credits/i);
    const credits_remaining = creditsMatch ? Number(creditsMatch[1].replace(/,/g, "")) : undefined;
    const username = lines[0];
    const plan = lines[1] && !/theme|account|credits/i.test(lines[1]) ? lines[1] : undefined;
    return { username, plan, credits_remaining };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await pause(page, 250);
  }
}

export async function getMusicState(detailed = false): Promise<MusicState> {
  const page = await getMusicPage();
  const signedIn = await ensureSignedIn(page);
  const state: MusicState = { url: page.url(), signedIn };
  if (!signedIn) {
    state.hint = "Not signed in to Flow Music. Run `npm run login` and sign in with Google in the Flow Music Chrome window.";
    return state;
  }
  if (detailed) {
    const info = await readAccountInfo(page).catch(() => ({}));
    Object.assign(state, info);
  }
  return state;
}

async function extractMySongsRows(page: Page): Promise<LibraryTrack[]> {
  return page.evaluate(() => {
    const out: { id: string; title: string; description: string; duration?: string; url: string }[] = [];
    const seen = new Set<string>();
    const buttons = [...document.querySelectorAll("button[aria-label^='More options for ']")];

    for (const btn of buttons) {
      const label = btn.getAttribute("aria-label") || "";
      const fallbackTitle = label.slice("More options for ".length).trim();
      let row: HTMLElement | null = btn.parentElement;
      let link: HTMLAnchorElement | null = null;
      for (let depth = 0; depth < 6 && row; depth++) {
        const found = row.querySelector<HTMLAnchorElement>("a[href^='/song/']");
        if (found) {
          link = found;
          break;
        }
        row = row.parentElement;
      }
      if (!link || !row) continue;
      const href = link.getAttribute("href") || "";
      const idMatch = href.match(/\/song\/([0-9a-f-]{36})/i);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const lines = (row.innerText || "")
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const duration = lines.find((l) => /^\d+:\d{2}$/.test(l));
      const cleanLines = lines.filter((l) => l !== duration);
      const title = fallbackTitle || cleanLines[0] || id;
      const description = cleanLines.filter((l) => l !== title).join(" ").trim();

      out.push({
        id,
        title,
        description,
        duration,
        url: `https://www.flowmusic.app/song/${id}`,
      });
    }
    return out;
  });
}

async function openMySongs(page: Page): Promise<void> {
  if (!/\/library\/my-songs/.test(page.url())) {
    await page.goto("https://www.flowmusic.app/library/my-songs", { waitUntil: "domcontentloaded" });
  } else {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page
    .locator("button[aria-label^='More options for ']")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  await pause(page, 600);
}

export async function listTracks(limit = 30, query?: string): Promise<LibraryTrack[]> {
  const page = await getMusicPage();
  if (!(await ensureSignedIn(page))) {
    throw new Error("Not signed in to Flow Music. Run `npm run login` and sign in with Google first.");
  }
  await openMySongs(page);
  let tracks = await extractMySongsRows(page);
  if (query) {
    const q = query.trim().toLowerCase();
    tracks = tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.id.toLowerCase() === q,
    );
  }
  return tracks.slice(0, limit);
}

async function downloadRowByUuid(
  page: Page,
  track: Pick<LibraryTrack, "id" | "title">,
  outputDir: string,
  fileStem: string,
  format: AudioFormat,
): Promise<string[]> {
  await dismissOverlays(page);
  await useOwnDownloadDir(page);

  const rowBtn = page
    .locator("div")
    .filter({ has: page.locator(`a[href="/song/${track.id}"]`) })
    .filter({ has: page.locator("button[aria-label^='More options for ']") })
    .last()
    .locator("button[aria-label^='More options for ']")
    .first();

  await rowBtn.waitFor({ state: "visible", timeout: 10_000 });
  await rowBtn.scrollIntoViewIfNeeded();

  const targetLabel = FORMAT_MENU_LABEL[format];
  const fallbackExt = FORMAT_EXT[format];

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dismissOverlays(page);
      const before = downloadsNow();

      await rowBtn.click({ timeout: 5000 });
      const dlItem = page.getByRole("menuitem", { name: /^Download$/i }).first();
      await dlItem.waitFor({ state: "visible", timeout: 5000 });
      const dlBox = await dlItem.boundingBox();
      if (dlBox) {
        await page.mouse.move(dlBox.x + dlBox.width / 2, dlBox.y + dlBox.height / 2);
      } else {
        await dlItem.hover();
      }
      await pause(page, 250);

      const formatItem = page.getByRole("menuitem", { name: targetLabel, exact: true }).first();
      if (!(await formatItem.isVisible({ timeout: 2500 }).catch(() => false))) {
        await dlItem.click().catch(() => {});
        await formatItem.waitFor({ state: "visible", timeout: 4000 });
      }
      // Move horizontally into the Radix submenu first so the pointer never crosses sibling menu items and closes it.
      const fmtBox = await formatItem.boundingBox();
      if (dlBox && fmtBox) {
        const targetX = fmtBox.x + fmtBox.width / 2;
        const targetY = fmtBox.y + fmtBox.height / 2;
        await page.mouse.move(targetX, dlBox.y + dlBox.height / 2, { steps: 5 });
        await page.mouse.move(targetX, targetY, { steps: 5 });
        await pause(page, 120);
        await page.mouse.click(targetX, targetY);
      } else {
        await formatItem.click({ timeout: 5000 });
      }

      const arrived = await waitForDownloadedFile(page, before, 90_000);
      const ext = extensionOf(arrived, fallbackExt);
      mkdirSync(outputDir, { recursive: true });

      if (format === "stems" && ext === ".zip") {
        const stemsDir = join(outputDir, `${fileStem.replace(/[^\w.-]+/g, "_")}_stems`);
        const tmp = mkdtempSync(join(tmpdir(), "flow-music-stems-"));
        try {
          const extracted = extractZip(arrived, tmp);
          const outFiles: string[] = [];
          for (const item of extracted) {
            const dest = uniquePath(stemsDir, basename(item, extname(item)), extname(item) || ".wav");
            moveFileSafe(item, dest);
            outFiles.push(dest);
          }
          try {
            unlinkSync(arrived);
          } catch {}
          if (!outFiles.length) throw new Error("Stems ZIP was empty.");
          return outFiles;
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }

      const dest = uniquePath(outputDir, fileStem, ext);
      moveFileSafe(arrived, dest);
      return [dest];
    } catch (err) {
      lastError = err;
      await dismissOverlays(page);
      await pause(page, 1000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function downloadTracks(
  queries: string[],
  outputDir: string,
  format: AudioFormat = "mp3",
): Promise<{ downloaded: { query: string; id: string; title: string; files: string[] }[]; not_found: string[] }> {
  const page = await getMusicPage();
  if (!(await ensureSignedIn(page))) {
    throw new Error("Not signed in to Flow Music. Run `npm run login` and sign in with Google first.");
  }

  await openMySongs(page);
  const allTracks = await extractMySongsRows(page);

  const downloaded: { query: string; id: string; title: string; files: string[] }[] = [];
  const not_found: string[] = [];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i].trim();
    const ql = q.toLowerCase();
    const match =
      allTracks.find((t) => t.id.toLowerCase() === ql) ??
      allTracks.find((t) => t.title.toLowerCase() === ql) ??
      allTracks.find((t) => t.title.toLowerCase().startsWith(ql)) ??
      allTracks.find((t) => t.title.toLowerCase().includes(ql));

    if (!match) {
      not_found.push(q);
      continue;
    }

    const prefix = String(i + 1).padStart(2, "0");
    const stem = `${prefix}_${slugify(match.title)}`;
    const files = await downloadRowByUuid(page, match, outputDir, stem, format);
    downloaded.push({ query: q, id: match.id, title: match.title, files });
  }

  return { downloaded, not_found };
}

async function openComposePanel(page: Page): Promise<Locator> {
  const composePanel = page.locator("[data-panel]").filter({ has: page.getByRole("button", { name: "Generate", exact: true }) }).first();
  const isOpen = async () => {
    if (!(await composePanel.isVisible().catch(() => false))) return false;
    const box = await composePanel.boundingBox().catch(() => null);
    return Boolean(box && box.width > 120);
  };

  if (!(await isOpen())) {
    const openBtn = page.getByRole("button", { name: /Open compose panel|Toggle compose panel/i }).first();
    await openBtn.waitFor({ state: "visible", timeout: 10_000 });
    await openBtn.click();
    await pause(page, 800);
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isOpen()) return composePanel;
    await pause(page, 250);
  }
  throw new Error("Could not open the Compose panel in Flow Music.");
}

async function setSwitch(sw: Locator, target: boolean): Promise<void> {
  const current = (await sw.getAttribute("aria-checked")) === "true";
  if (current !== target) {
    await sw.click();
    await sw.page().waitForTimeout(250);
  }
}

async function fillComposeForm(page: Page, panel: Locator, job: MusicJob): Promise<void> {
  const { prompt, lyrics, instrumental, title, bpm, length, seed, model } = job.params;

  // Lyrics / Instrumental
  const instSwitch = panel.getByRole("switch", { name: "Toggle instrumental mode" });
  const lyricsBox = panel.getByRole("textbox", { name: "Lyrics" });
  if (instrumental) {
    await setSwitch(instSwitch, true);
  } else {
    await setSwitch(instSwitch, false);
    if (await lyricsBox.isVisible().catch(() => false)) {
      await lyricsBox.fill(lyrics ?? "");
    }
  }

  // Sound description (required)
  const soundBox = panel.getByRole("textbox", { name: "Sound description" });
  await soundBox.waitFor({ state: "visible", timeout: 5000 });
  await soundBox.fill(prompt);

  // Advanced settings: BPM, Length, Seed, Model
  const advSwitch = panel.getByRole("switch", { name: "Toggle advanced sound mode" });
  const needsAdvanced = bpm !== undefined || length !== undefined || seed !== undefined || model !== undefined;
  if (needsAdvanced) {
    await setSwitch(advSwitch, true);
    await pause(page, 300);

    const autoInputs = panel.locator("input[placeholder='Auto']");
    if (bpm !== undefined) await autoInputs.nth(0).fill(String(bpm));
    else await autoInputs.nth(0).fill("").catch(() => {});

    if (length !== undefined) await autoInputs.nth(1).fill(String(length));
    else await autoInputs.nth(1).fill("").catch(() => {});

    if (seed !== undefined) await autoInputs.nth(2).fill(String(seed));
    else await autoInputs.nth(2).fill("").catch(() => {});

    if (model) {
      const modelBtn = panel.locator("button").filter({ hasText: /Lyria/i }).first();
      if (await modelBtn.isVisible().catch(() => false)) {
        const currentModel = (await modelBtn.innerText()).trim();
        if (!currentModel.includes(model)) {
          await modelBtn.click();
          const option = page
            .locator("[role='menuitem'], [role='menuitemradio'], [role='option']")
            .filter({ hasText: model })
            .first();
          await option.waitFor({ state: "visible", timeout: 4000 });
          await option.click();
          await pause(page, 300);
        }
      }
    }
  } else {
    await setSwitch(advSwitch, false).catch(() => {});
  }

  // Optional title inside Details
  const expandDetails = panel.getByRole("button", { name: "Expand Details section" });
  if (title) {
    if (await expandDetails.isVisible().catch(() => false)) {
      await expandDetails.click();
      await pause(page, 300);
    }
    const titleBox = panel.locator("textarea:not([aria-label='Lyrics']):not([aria-label='Sound description'])").first();
    if (await titleBox.isVisible().catch(() => false)) {
      await titleBox.fill(title);
    }
  } else {
    const titleBox = panel.locator("textarea:not([aria-label='Lyrics']):not([aria-label='Sound description'])").first();
    if (await titleBox.isVisible().catch(() => false)) {
      await titleBox.fill("").catch(() => {});
    }
  }
}

async function extractSessionTracks(page: Page): Promise<LibraryTrack[]> {
  return page.evaluate(() => {
    const out: { id: string; title: string; description: string; duration?: string; url: string }[] = [];
    const seen = new Set<string>();
    const buttons = [...document.querySelectorAll("button[aria-label^='More options for ']")];
    for (const btn of buttons) {
      const label = btn.getAttribute("aria-label") || "";
      const title = label.slice("More options for ".length).trim();
      let row: HTMLElement | null = btn.parentElement;
      let link: HTMLAnchorElement | null = null;
      for (let depth = 0; depth < 6 && row; depth++) {
        const found = row.querySelector<HTMLAnchorElement>("a[href^='/song/']");
        if (found) {
          link = found;
          break;
        }
        row = row.parentElement;
      }
      if (!link || !row) continue;
      const idMatch = (link.getAttribute("href") || "").match(/\/song\/([0-9a-f-]{36})/i);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: title || id,
        description: (row.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
        url: `https://www.flowmusic.app/song/${id}`,
      });
    }
    return out;
  });
}

export async function runMusicGeneration(job: MusicJob): Promise<JobRunResult> {
  const page = await getMusicPage();
  if (!(await ensureSignedIn(page))) {
    throw new Error("Not signed in to Flow Music. Run `npm run login` and sign in with Google first.");
  }

  const beforeAccount = await readAccountInfo(page);
  const creditsBefore = beforeAccount.credits_remaining;
  if (creditsBefore !== undefined && creditsBefore <= 0) {
    throw new Error("Insufficient credits: Flow Music reports 0 credits remaining.");
  }

  // Capture existing track IDs before triggering a new generation so new outputs are unambiguously matched.
  await openMySongs(page);
  const beforeTracks = await extractMySongsRows(page);
  const beforeIds = new Set(beforeTracks.map((t) => t.id));

  // Start a clean session and fill Compose
  await page.goto(FLOW_MUSIC_URL, { waitUntil: "domcontentloaded" });
  await pause(page, 1200);
  const panel = await openComposePanel(page);
  await fillComposeForm(page, panel, job);

  const generateBtn = panel.getByRole("button", { name: "Generate", exact: true });
  await generateBtn.waitFor({ state: "visible", timeout: 5000 });
  if (await generateBtn.isDisabled()) {
    throw new Error("Generate button is disabled; check that the prompt is valid.");
  }
  await generateBtn.click();

  // Wait for new tracks to appear and settle in the session
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let newTracks: LibraryTrack[] = [];
  let firstSeenAt = 0;

  while (Date.now() < deadline) {
    await pause(page, 2500);

    const failureText = await page
      .evaluate(() => {
        const mainText = document.querySelector("main")?.innerText || "";
        const alerts = [...document.querySelectorAll("[role='alert'], [role='status']")].map((e) => e.textContent || "").join(" ");
        const m = `${mainText} ${alerts}`.match(/(insufficient credits|out of credits|generation failed|unable to generate|something went wrong)/i);
        return m ? m[0] : null;
      })
      .catch(() => null);

    if (failureText && newTracks.length === 0) {
      throw new Error(`Flow Music reported an error: ${failureText}`);
    }

    const currentSessionTracks = await extractSessionTracks(page);
    const fresh = currentSessionTracks.filter((t) => !beforeIds.has(t.id));

    if (fresh.length > 0) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      newTracks = fresh;
      const stillLoading = await page
        .evaluate(() => /generating|composing|creating|loading/i.test((document.querySelector("main")?.textContent || "").slice(-500)))
        .catch(() => false);
      // Wait briefly after the first track settles in case a second take appears.
      if (fresh.length >= 2 || (!stillLoading && Date.now() - firstSeenAt >= 4000)) {
        break;
      }
    }
  }

  // Fallback check directly in /library/my-songs in case tracks finished without rendering in the session view
  await openMySongs(page);
  const libraryAfter = await extractMySongsRows(page);
  const freshInLibrary = libraryAfter.filter((t) => !beforeIds.has(t.id));
  const resolvedTracks = freshInLibrary.length ? freshInLibrary : newTracks;

  if (!resolvedTracks.length) {
    throw new Error("Timed out waiting for Flow Music to create new tracks.");
  }

  const toDownload = job.params.download_all_takes ? resolvedTracks : resolvedTracks.slice(0, 1);
  const downloadedTracks: GeneratedTrackInfo[] = [];
  const allFiles: string[] = [];

  for (let i = 0; i < toDownload.length; i++) {
    const track = toDownload[i];
    const stem = toDownload.length > 1 ? `${job.params.file_stem}_v${i + 1}` : job.params.file_stem;
    const files = await downloadRowByUuid(page, track, job.params.output_dir, stem, job.params.format);
    allFiles.push(...files);
    downloadedTracks.push({
      id: track.id,
      title: track.title,
      description: track.description,
      duration: track.duration,
      url: track.url,
      files,
    });
  }

  const afterAccount = await readAccountInfo(page).catch(() => ({ credits_remaining: undefined }));
  const creditsAfter = afterAccount.credits_remaining;
  const creditsSpent =
    creditsBefore !== undefined && creditsAfter !== undefined ? Math.max(0, creditsBefore - creditsAfter) : undefined;

  return {
    files: allFiles,
    tracks: downloadedTracks,
    credits_before: creditsBefore,
    credits_after: creditsAfter,
    credits_spent: creditsSpent,
  };
}
