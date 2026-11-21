import { readFileSync } from "node:fs";
import type { MusicCore } from "./core.js";
import { PORT, TOKEN_FILE } from "./server.js";

async function call(method: string, args: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-flow-music-token": readFileSync(TOKEN_FILE, "utf8").trim(),
    },
    body: JSON.stringify(args ?? {}),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `flow-music-mcp owner answered ${res.status}`);
  return data;
}

export class RemoteMusicCore implements MusicCore {
  status = (a: unknown) => call("status", a);
  generate = (a: unknown) => call("generate", a);
  create = (a: unknown) => call("create", a);
  cancel = (a: unknown) => call("cancel", a);
  retry = (a: unknown) => call("retry", a);
  tracks = (a: unknown) => call("tracks", a);
  download = (a: unknown) => call("download", a);
  outputs = () => call("outputs", {});

  async wait(a: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await call("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}
