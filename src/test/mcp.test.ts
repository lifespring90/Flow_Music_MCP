import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OUTPUT_ROOT, resolveOutputDir } from "../core.js";
import { slugify } from "../flow-music.js";
import { MusicJobQueue } from "../queue.js";

test("resolveOutputDir supports absolute output_dir and project subfolders", () => {
  const abs = join(tmpdir(), "custom-video-audio");
  assert.equal(resolveOutputDir(abs), abs);
  assert.equal(resolveOutputDir(undefined, "My Video 01!"), join(OUTPUT_ROOT, "My_Video_01_"));
  assert.throws(() => resolveOutputDir("relative/path"), /absolute path/i);
});

test("slugify creates clean cross-platform filenames", () => {
  assert.equal(slugify("Promoción Salud Postural!"), "promocion_salud_postural");
  assert.equal(slugify("   "), "track");
});

test("MusicJobQueue stops remaining batch items when max_total_credits cap is reached", async () => {
  let runs = 0;
  const queue = new MusicJobQueue(async () => {
    runs++;
    return {
      files: [`/tmp/track-${runs}.mp3`],
      tracks: [{ title: `Track ${runs}`, files: [`/tmp/track-${runs}.mp3`] }],
      credits_before: 100 - (runs - 1) * 10,
      credits_after: 90 - (runs - 1) * 10,
      credits_spent: 10,
    };
  });

  const budget = queue.createBatch(15);
  const common = {
    prompt: "test beat",
    instrumental: true,
    format: "mp3" as const,
    download_all_takes: true,
    output_dir: tmpdir(),
  };

  const j1 = queue.add({ ...common, file_stem: "01_a" }, budget.id, 1);
  const j2 = queue.add({ ...common, file_stem: "02_b" }, budget.id, 2);

  while (j1.status === "queued" || j1.status === "running" || j2.status === "queued" || j2.status === "running") {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.equal(runs, 1);
  assert.equal(j1.status, "done");
  assert.equal(j2.status, "cancelled");
  assert.match(j2.note ?? "", /Stopped remaining items in batch/i);
});

test("MCP stdio server exposes all expected flow_music tools", async () => {
  const testHome = join(tmpdir(), `flow-music-mcp-test-${Date.now()}`);
  const testOut = join(testHome, "out");
  mkdirSync(join(testOut, "Demo"), { recursive: true });
  writeFileSync(join(testOut, "Demo", "sample.mp3"), "dummy");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      FLOW_MUSIC_MCP_HOME: testHome,
      FLOW_MUSIC_MCP_OUTPUT: testOut,
      FLOW_MUSIC_MCP_PORT: "18788",
      FLOW_MUSIC_MCP_CDP_PORT: "19334",
    },
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "flow_music_cancel",
      "flow_music_create",
      "flow_music_download",
      "flow_music_generate",
      "flow_music_outputs",
      "flow_music_retry",
      "flow_music_status",
      "flow_music_tracks",
      "flow_music_wait",
    ]);

    const res = await client.callTool({ name: "flow_music_outputs", arguments: {} });
    const content = res.content as { type: string; text?: string }[];
    const textItem = content.find((c) => c.type === "text");
    assert.ok(textItem?.text);
    const parsed = JSON.parse(textItem.text) as { projects: { project: string; files: string[] }[] };
    assert.equal(parsed.projects.length, 1);
    assert.equal(parsed.projects[0].project, "Demo");
    assert.ok(existsSync(parsed.projects[0].files[0]));
  } finally {
    await client.close().catch(() => {});
    rmSync(testHome, { recursive: true, force: true });
  }
});
