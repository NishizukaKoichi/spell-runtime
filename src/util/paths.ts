import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function spellHome(): string {
  return path.join(homedir(), ".spell");
}

export function spellsRoot(): string {
  return path.join(spellHome(), "spells");
}

export function logsRoot(): string {
  return path.join(spellHome(), "logs");
}

export async function ensureSpellDirs(): Promise<void> {
  await mkdir(spellsRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
}
