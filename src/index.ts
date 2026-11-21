#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalMusicCore, shapes, type MusicCore } from "./core.js";
import { RemoteMusicCore } from "./remote.js";
import { startServer } from "./server.js";

const local = new LocalMusicCore();
const role = await startServer(local);
const core: MusicCore = role === "client" ? new RemoteMusicCore() : local;

const server = new McpServer({ name: "flow-music-mcp", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
  try {
    const data = await work;
    const body = Array.isArray(data) ? data : { ...(data as object), ...extra };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }],
      isError: true,
    };
  }
};

// Keep every MCP tool call within ~40s so clients (Antigravity, Claude Code, Codex) never hit request timeouts and retry a paid generation.
const PATIENCE_MS = Number(process.env.FLOW_MUSIC_MCP_PATIENCE_MS ?? 40_000);
const WAIT_MS = Math.max(5_000, PATIENCE_MS - 4_000);

type SlowTask = {
  task_id: string;
  tool: string;
  started: string;
  status: "running" | "done" | "failed";
  result?: unknown;
  error?: string;
};
const tasks = new Map<string, SlowTask>();

const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
  const task: SlowTask = {
    task_id: `task-${randomUUID().slice(0, 8)}`,
    tool,
    started: new Date().toISOString(),
    status: "running",
  };
  const settled = work.then(
    (result) => {
      task.status = "done";
      task.result = result;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Flow Music is still working - this is not an error. Call flow_music_wait with job_ids ["${task.task_id}"] to retrieve the result without running ${tool} again.`,
  };
};

async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeout_seconds * 1000, WAIT_MS);
  const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
  const mine = (job_ids ?? []).filter(isTask);
  const jobs = job_ids?.filter((id) => !isTask(id));

  while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const done = mine.map(
    (id) =>
      tasks.get(id) ?? {
        task_id: id,
        status: "unknown",
        note: "This server process restarted since that call. Check flow_music_tracks before regenerating.",
      },
  );
  const tasksFinished = done.every((t) => t.status !== "running");
  if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };

  const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
  const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
  return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
}

server.registerTool(
  "flow_music_status",
  {
    title: "Flow Music status",
    description:
      "Check the dedicated Flow Music Chrome session (signed in, username, plan, credits remaining) and the current generation queue. Call this first.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(core.status(args)),
);

server.registerTool(
  "flow_music_generate",
  {
    title: "Batch generate Flow Music tracks",
    description:
      "Queue 1 to 50 music prompts/variations to generate sequentially in the background with human-like pacing (~5 credits per generation in Compose), save audio files directly to a local folder (output_dir or project), and enforce credit limits (max_credits_per_prompt / max_total_credits). Returns job_ids immediately; use flow_music_wait to collect downloaded files.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.generate(args)),
);

server.registerTool(
  "flow_music_create",
  {
    title: "Generate, wait, and download a track in one command",
    description:
      "All-in-one command: fills Compose in Flow Music (~5 credits per generation), generates the track, waits for completion, measures credits spent, and downloads the audio file(s) to output_dir or project. If generation takes longer than ~40s, returns a task_id for flow_music_wait so it never duplicates charges.",
    inputSchema: shapes.create,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_create", core.create(args))),
);

server.registerTool(
  "flow_music_wait",
  {
    title: "Wait for Flow Music jobs",
    description:
      "Wait for queued generation jobs (or a task_id from flow_music_create) and return status, credits spent, and local audio file paths. Returns within ~40s; call again until finished is true.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

server.registerTool(
  "flow_music_tracks",
  {
    title: "List Flow Music library tracks",
    description: "List tracks in your Flow Music library (id, title, duration, description, url).",
    inputSchema: shapes.tracks,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_tracks", core.tracks(args))),
);

server.registerTool(
  "flow_music_download",
  {
    title: "Download existing Flow Music tracks",
    description:
      "Download already-generated tracks from Flow Music by UUID or title in mp3, wav, m4a, stems, or video without spending credits.",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_download", core.download(args))),
);

server.registerTool(
  "flow_music_cancel",
  {
    title: "Cancel queued Flow Music job",
    description: "Cancel a queued job that has not started yet.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

server.registerTool(
  "flow_music_retry",
  {
    title: "Retry failed or cancelled Flow Music jobs",
    description: "Re-queue failed or cancelled jobs with the same settings.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

server.registerTool(
  "flow_music_outputs",
  {
    title: "List local downloaded music folders",
    description: "List projects and audio files saved in the default flow-music-mcp output directory.",
    inputSchema: shapes.outputs,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => reply(core.outputs()),
);

await server.connect(new StdioServerTransport());
