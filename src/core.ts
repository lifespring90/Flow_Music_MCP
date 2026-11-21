import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { downloadTracks, getMusicState, listTracks, runMusicGeneration, slugify } from "./flow-music.js";
import { MusicJobQueue, type MusicJob } from "./queue.js";

export const OUTPUT_ROOT = process.env.FLOW_MUSIC_MCP_OUTPUT ?? join(homedir(), "flow-music-mcp-out");

export function resolveOutputDir(outputDir?: string, project?: string): string {
  if (outputDir && outputDir.trim()) {
    if (!isAbsolute(outputDir)) {
      throw new Error(`output_dir must be an absolute path (received "${outputDir}"). Use \`project\` for a folder under ${OUTPUT_ROOT}.`);
    }
    return resolve(outputDir);
  }
  const folder = (project?.trim() || "tracks").replace(/[^\w.-]+/g, "_");
  return resolve(OUTPUT_ROOT, folder);
}

const formatSchema = z.enum(["mp3", "wav", "m4a", "stems", "video"]).default("mp3");
const modelSchema = z.enum(["Lyria 3.5", "Lyria 3 Pro"]).optional();

const trackPromptSchema = z.object({
  prompt: z.string().min(1).describe("Music/sound description: genre, mood, instruments, tempo, vocal style, production notes."),
  lyrics: z.string().optional().describe("Optional custom lyrics (ignored when instrumental is true)."),
  instrumental: z.boolean().default(false).describe("Set true for instrumental tracks with no vocals."),
  title: z.string().max(120).optional().describe("Optional song title in Flow Music."),
  bpm: z.number().int().min(30).max(300).optional().describe("Optional BPM (opens Advanced dynamics)."),
  length: z.string().max(32).optional().describe("Optional length setting (e.g. '60' or '1:30') in Advanced dynamics."),
  seed: z.number().int().min(0).optional().describe("Optional numeric seed for reproducible style."),
  model: modelSchema.describe("Music model: 'Lyria 3.5' (default flagship) or 'Lyria 3 Pro' (legacy)."),
  format: formatSchema.optional().describe("Audio download format for this track: mp3 (default), wav, m4a, stems, or video."),
  download_all_takes: z.boolean().default(true).describe("If Flow Music produces multiple takes for a prompt, true downloads all takes and false downloads only the first."),
  file_name: z.string().max(80).optional().describe("Optional base filename (without extension) for downloaded files."),
});

export const shapes = {
  status: {
    detailed: z.boolean().default(true).describe("Reads username, plan, and remaining credits from Flow Music's Settings menu."),
  },
  generate: {
    project: z.string().optional().describe(`Subfolder name under ${OUTPUT_ROOT} when output_dir is not provided.`),
    output_dir: z.string().optional().describe("Absolute path to a local folder where audio files will be saved (e.g. your video project's audio folder)."),
    format: formatSchema.describe("Default audio download format for the batch: mp3 (default), wav, m4a, stems, or video."),
    max_credits_per_prompt: z.number().int().min(1).optional().describe("Safety limit per prompt: stops remaining queued items if one generation spends more than this."),
    max_total_credits: z.number().int().min(1).optional().describe("Total credit budget for the entire batch: stops remaining items before exceeding this cap."),
    tracks: z.array(trackPromptSchema).min(1).max(50).describe("List of prompts/variations to generate sequentially in the background."),
  },
  create: {
    prompt: z.string().min(1).describe("Music/sound description: genre, mood, instruments, tempo, vocal style, production notes."),
    lyrics: z.string().optional().describe("Optional custom lyrics (ignored when instrumental is true)."),
    instrumental: z.boolean().default(false).describe("Set true for instrumental tracks with no vocals."),
    title: z.string().max(120).optional().describe("Optional song title."),
    bpm: z.number().int().min(30).max(300).optional(),
    length: z.string().max(32).optional(),
    seed: z.number().int().min(0).optional(),
    model: modelSchema,
    format: formatSchema.describe("Download format: mp3 (default), wav, m4a, stems, or video."),
    download_all_takes: z.boolean().default(true).describe("If Flow Music creates multiple takes for this prompt, true downloads all takes and false downloads only the first."),
    max_credits: z.number().int().min(1).optional().describe("Optional credit guard recorded on the job."),
    file_name: z.string().max(80).optional().describe("Optional base filename (without extension)."),
    project: z.string().optional().describe(`Subfolder under ${OUTPUT_ROOT} when output_dir is omitted.`),
    output_dir: z.string().optional().describe("Absolute path to save the downloaded track(s) directly into a project folder."),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job IDs (or task_id) to wait for. Default: all jobs in the queue."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("Each call waits at most ~40 s to stay inside MCP client timeouts; repeat until finished is true."),
  },
  cancel: {
    job_id: z.string().min(1),
  },
  retry: {
    job_ids: z.array(z.string()).optional().describe("Failed or cancelled job IDs to re-queue. Default: all failed jobs."),
  },
  tracks: {
    limit: z.number().int().min(1).max(200).default(30),
    query: z.string().optional().describe("Optional filter matching title, prompt description, or song UUID."),
  },
  download: {
    tracks: z.array(z.string().min(1)).min(1).max(30).describe("Song UUIDs, exact titles, or title prefixes from flow_music_tracks."),
    format: formatSchema.describe("Download format: mp3 (default), wav, m4a, stems, or video."),
    project: z.string().optional().describe(`Subfolder under ${OUTPUT_ROOT} when output_dir is omitted.`),
    output_dir: z.string().optional().describe("Absolute path where the downloaded audio files will be saved."),
  },
  outputs: {},
};

const summarizeJob = (j: MusicJob) => ({
  id: j.id,
  batch_id: j.batch_id,
  index: j.index,
  status: j.status,
  prompt: j.params.prompt.slice(0, 120),
  format: j.params.format,
  output_dir: j.params.output_dir,
  files: j.files,
  tracks: j.tracks,
  credits_spent: j.credits_spent,
  credits_after: j.credits_after,
  note: j.note,
  error: j.error,
});

export interface MusicCore {
  status(args: { detailed: boolean }): Promise<unknown>;
  generate(args: z.infer<z.ZodObject<typeof shapes.generate>>): Promise<unknown>;
  create(args: z.infer<z.ZodObject<typeof shapes.create>>): Promise<unknown>;
  wait(args: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown>;
  cancel(args: { job_id: string }): Promise<unknown>;
  retry(args: { job_ids?: string[] }): Promise<unknown>;
  tracks(args: { limit: number; query?: string }): Promise<unknown>;
  download(args: z.infer<z.ZodObject<typeof shapes.download>>): Promise<unknown>;
  outputs(): Promise<unknown>;
}

export class LocalMusicCore implements MusicCore {
  private queue = new MusicJobQueue((job) => runMusicGeneration(job));

  async status({ detailed }: { detailed: boolean }) {
    const flow_music = await getMusicState(detailed && !this.queue.busy);
    const jobs = this.queue.list();
    return {
      flow_music,
      output_root: OUTPUT_ROOT,
      queue: {
        busy: this.queue.busy,
        paused_reason: this.queue.pausedReason,
        counts: {
          queued: jobs.filter((j) => j.status === "queued").length,
          running: jobs.filter((j) => j.status === "running").length,
          done: jobs.filter((j) => j.status === "done").length,
          failed: jobs.filter((j) => j.status === "failed").length,
          cancelled: jobs.filter((j) => j.status === "cancelled").length,
        },
        jobs: jobs.slice(-20).map(summarizeJob),
      },
    };
  }

  async generate(args: z.infer<z.ZodObject<typeof shapes.generate>>) {
    const outputDir = resolveOutputDir(args.output_dir, args.project);
    mkdirSync(outputDir, { recursive: true });

    const state = await getMusicState(true);
    if (!state.signedIn) {
      throw new Error(state.hint || "Not signed in to Flow Music. Run `npm run login` first.");
    }
    if (state.credits_remaining !== undefined && state.credits_remaining <= 0) {
      throw new Error("Flow Music reports 0 credits remaining.");
    }

    const budget = this.queue.createBatch(args.max_total_credits);
    const created: MusicJob[] = [];

    for (let i = 0; i < args.tracks.length; i++) {
      const t = args.tracks[i];
      const num = String(i + 1).padStart(2, "0");
      const base = t.file_name ? slugify(t.file_name, 50) : slugify(t.title || t.prompt, 36);
      const job = this.queue.add(
        {
          prompt: t.prompt,
          lyrics: t.lyrics,
          instrumental: t.instrumental,
          title: t.title,
          bpm: t.bpm,
          length: t.length,
          seed: t.seed,
          model: t.model,
          format: t.format ?? args.format,
          download_all_takes: t.download_all_takes,
          max_credits: args.max_credits_per_prompt,
          output_dir: outputDir,
          file_stem: `${num}_${base}`,
        },
        budget.id,
        i + 1,
      );
      created.push(job);
    }

    return {
      queued: true,
      batch_id: budget.id,
      output_dir: outputDir,
      credits_remaining_start: state.credits_remaining,
      max_total_credits: args.max_total_credits,
      max_credits_per_prompt: args.max_credits_per_prompt,
      job_ids: created.map((j) => j.id),
      jobs: created.map(summarizeJob),
      next_step: "Call flow_music_wait with these job_ids to collect completed audio files.",
    };
  }

  async create(args: z.infer<z.ZodObject<typeof shapes.create>>) {
    const outputDir = resolveOutputDir(args.output_dir, args.project);
    mkdirSync(outputDir, { recursive: true });

    const state = await getMusicState(true);
    if (!state.signedIn) {
      throw new Error(state.hint || "Not signed in to Flow Music. Run `npm run login` first.");
    }
    if (state.credits_remaining !== undefined && state.credits_remaining <= 0) {
      throw new Error("Flow Music reports 0 credits remaining.");
    }

    const budget = this.queue.createBatch(args.max_credits);
    const stem = args.file_name ? slugify(args.file_name, 50) : slugify(args.title || args.prompt, 36);
    const job = this.queue.add(
      {
        prompt: args.prompt,
        lyrics: args.lyrics,
        instrumental: args.instrumental,
        title: args.title,
        bpm: args.bpm,
        length: args.length,
        seed: args.seed,
        model: args.model,
        format: args.format,
        download_all_takes: args.download_all_takes,
        max_credits: args.max_credits,
        output_dir: outputDir,
        file_stem: stem,
      },
      budget.id,
      1,
    );

    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const cur = this.queue.get(job.id);
      if (cur && cur.status !== "queued" && cur.status !== "running") {
        if (cur.status === "failed") throw new Error(cur.error || "Track generation failed.");
        return {
          finished: true,
          output_dir: outputDir,
          job: summarizeJob(cur),
        };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Timed out waiting for job ${job.id}. Check flow_music_wait with job_ids ["${job.id}"].`);
  }

  async wait({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }) {
    const deadline = Date.now() + timeout_seconds * 1000;
    const pick = () => (job_ids?.length ? job_ids.map((id) => this.queue.get(id)).filter((j): j is MusicJob => Boolean(j)) : this.queue.list());

    let jobs = pick();
    while (Date.now() < deadline && jobs.some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 1500));
      jobs = pick();
    }

    const finished = jobs.every((j) => j.status !== "queued" && j.status !== "running");
    const batchIds = [...new Set(jobs.map((j) => j.batch_id))];
    const budgets = batchIds.map((id) => this.queue.getBatch(id)).filter(Boolean);
    const totalCreditsSpent = jobs.reduce((sum, j) => sum + (j.credits_spent ?? 0), 0);

    return {
      finished,
      paused_reason: this.queue.pausedReason,
      total_credits_spent: totalCreditsSpent,
      budgets,
      jobs: jobs.map(summarizeJob),
    };
  }

  async cancel({ job_id }: { job_id: string }) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`Unknown job_id "${job_id}".`);
    return { job: summarizeJob(job) };
  }

  async retry({ job_ids }: { job_ids?: string[] }) {
    const targets = job_ids?.length
      ? job_ids.map((id) => this.queue.get(id)).filter((j): j is MusicJob => Boolean(j))
      : this.queue.list().filter((j) => j.status === "failed");

    const retried: ReturnType<typeof summarizeJob>[] = [];
    for (const j of targets) {
      const updated = this.queue.retry(j.id);
      if (updated) retried.push(summarizeJob(updated));
    }
    return { retried_count: retried.length, jobs: retried };
  }

  async tracks({ limit, query }: { limit: number; query?: string }) {
    const items = await listTracks(limit, query);
    return { count: items.length, tracks: items };
  }

  async download(args: z.infer<z.ZodObject<typeof shapes.download>>) {
    const outputDir = resolveOutputDir(args.output_dir, args.project);
    mkdirSync(outputDir, { recursive: true });
    const result = await downloadTracks(args.tracks, outputDir, args.format);
    return { output_dir: outputDir, format: args.format, ...result };
  }

  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { output_root: OUTPUT_ROOT, projects: [] };
    const entries = readdirSync(OUTPUT_ROOT).filter((name) => !name.startsWith("."));
    const projects = entries
      .map((name) => {
        const dir = join(OUTPUT_ROOT, name);
        if (!statSync(dir).isDirectory()) return null;
        const files = readdirSync(dir)
          .filter((f) => !f.startsWith("."))
          .map((f) => join(dir, f));
        return { project: name, dir, files };
      })
      .filter(Boolean);
    return { output_root: OUTPUT_ROOT, projects };
  }
}
