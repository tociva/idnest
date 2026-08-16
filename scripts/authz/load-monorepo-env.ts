import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadMonorepoEnv(): void {
  const workingDirectory = process.cwd();
  const directCandidate = resolve(workingDirectory, ".env");
  const nestedCandidate = resolve(workingDirectory, "monorepo/.env");
  const envPath = existsSync(nestedCandidate) ? nestedCandidate : directCandidate;
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = parseEnvValue(rawValue);
    }
  }
}
