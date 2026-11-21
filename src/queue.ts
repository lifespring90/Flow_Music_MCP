import { randomUUID } from "node:crypto";

export type AudioFormat = "mp3" | "wav" | "m4a" | "stems" | "video";
export type MusicModel = "Lyria 3.5" | "Lyria 3 Pro";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TrackSpec {
  prompt: string;
  lyrics?: string;
  instrumental: boolean;
  title?: string;
  bpm?: number;
  length?: string;
  seed?: number;
  model?: MusicModel;
  format: AudioFormat;
  download_all_takes: boolean;
  max_credits?: number;
  output_dir: string;
  file_stem: string;
}

export interface GeneratedTrackInfo {
  id?: string;
  title: string;
  description?: string;
  duration?: string;
  url?: string;
  files: string[];
}

export interface BatchBudget {
  id: string;
  max_total_credits?: number;
  spent_credits: number;
  stopped_reason?: string;
}

export interface MusicJob {
  id: string;
  batch_id: string;
  index: number;
  status: JobStatus;
  params: TrackSpec;
  files: string[];
  tracks: GeneratedTrackInfo[];
  credits_before?: number;
  credits_after?: number;
  credits_spent?: number;
  attempts: number;
  note?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface JobRunResult {
  files: string[];
  tracks: GeneratedTrackInfo[];
  credits_before?: number;
  credits_after?: number;
  credits_spent?: number;
  note?: string;
}

export type MusicJobRunner = (job: MusicJob, budget: BatchBudget) => Promise<JobRunResult>;

// Human-like pacing between batch generations to avoid hammering Flow Music.
const PAUSE_MIN_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MIN_S ?? 15) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MAX_S ?? 35) * 1000;

export class MusicJobQueue {
  private jobs = new Map<string, MusicJob>();
  private batches = new Map<string, BatchBudget>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(private runner: MusicJobRunner) {}

  createBatch(max_total_credits?: number): BatchBudget {
    const budget: BatchBudget = {
      id: `batch-${randomUUID().slice(0, 8)}`,
      max_total_credits,
      spent_credits: 0,
    };
    this.batches.set(budget.id, budget);
    return budget;
  }

  getBatch(batchId: string): BatchBudget | undefined {
    return this.batches.get(batchId);
  }

  add(params: TrackSpec, batchId: string, index: number): MusicJob {
    if (!this.batches.has(batchId)) {
      this.batches.set(batchId, { id: batchId, spent_credits: 0 });
    }
    const job: MusicJob = {
      id: randomUUID().slice(0, 8),
      batch_id: batchId,
      index,
      status: "queued",
      params,
      files: [],
      tracks: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): MusicJob | undefined {
    return this.jobs.get(id);
  }

  list(): MusicJob[] {
    return [...this.jobs.values()];
  }

  retry(id: string): MusicJob | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      const budget = this.batches.get(job.batch_id);
      if (budget?.stopped_reason) budget.stopped_reason = undefined;
      job.status = "queued";
      job.error = undefined;
      job.note = undefined;
      job.finishedAt = undefined;
      void this.work();
    }
    return job;
  }

  cancel(id: string): MusicJob | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.note = "Cancelled by user before execution.";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private cancelBatchRemainder(batchId: string, reason: string): void {
    const budget = this.batches.get(batchId);
    if (budget) budget.stopped_reason = reason;
    for (const j of this.jobs.values()) {
      if (j.batch_id === batchId && j.status === "queued") {
        j.status = "cancelled";
        j.note = reason;
        j.finishedAt = new Date().toISOString();
      }
    }
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;

        const budget = this.batches.get(job.batch_id) ?? { id: job.batch_id, spent_credits: 0 };
        if (budget.stopped_reason) {
          job.status = "cancelled";
          job.note = budget.stopped_reason;
          job.finishedAt = new Date().toISOString();
          continue;
        }
        if (budget.max_total_credits !== undefined && budget.spent_credits >= budget.max_total_credits) {
          this.cancelBatchRemainder(
            job.batch_id,
            `Stopped batch: spent ${budget.spent_credits} credits, reached cap of ${budget.max_total_credits}.`,
          );
          continue;
        }

        if (this.lastFinished) {
          const pause = PAUSE_MIN_MS + Math.random() * Math.max(0, PAUSE_MAX_MS - PAUSE_MIN_MS);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }

        if (job.status !== "queued") continue;
        job.status = "running";
        job.attempts++;

        try {
          const res = await this.runner(job, budget);
          job.files = res.files;
          job.tracks = res.tracks;
          job.credits_before = res.credits_before;
          job.credits_after = res.credits_after;
          job.credits_spent = res.credits_spent;
          job.note = res.note;
          job.status = "done";
          job.error = undefined;

          if (typeof res.credits_spent === "number" && res.credits_spent > 0) {
            budget.spent_credits += res.credits_spent;
            // Enforce per-prompt and total batch caps after measuring actual spend so remaining queued items never overshoot.
            if (job.params.max_credits !== undefined && res.credits_spent > job.params.max_credits) {
              this.cancelBatchRemainder(
                job.batch_id,
                `Stopped remaining items in batch: generation spent ${res.credits_spent} credits, exceeding max_credits (${job.params.max_credits}).`,
              );
            } else if (
              budget.max_total_credits !== undefined &&
              budget.spent_credits + res.credits_spent > budget.max_total_credits
            ) {
              const left = Math.max(0, budget.max_total_credits - budget.spent_credits);
              if (left < res.credits_spent) {
                this.cancelBatchRemainder(
                  job.batch_id,
                  `Stopped remaining items in batch: ${budget.spent_credits}/${budget.max_total_credits} credits used and next track likely costs ~${res.credits_spent} credits.`,
                );
              }
            }
          }
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.status = "failed";
          if (/no credits|insufficient credits|not signed in|stopped batch/i.test(job.error)) {
            this.cancelBatchRemainder(job.batch_id, `Stopped batch: ${job.error}`);
          }
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
