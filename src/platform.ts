import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

/** Unpacks a ZIP archive using built-in OS tools and returns every extracted file path. */
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") || entry === "__MACOSX") continue;
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dest);
  return files;
}
