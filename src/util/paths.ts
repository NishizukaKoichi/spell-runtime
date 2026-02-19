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

export function trustRoot(): string {
  return path.join(spellHome(), "trust");
}

export function trustedPublishersRoot(): string {
  return path.join(trustRoot(), "publishers");
}

export function licensesRoot(): string {
  return path.join(spellHome(), "licenses");
}

export function registryConfigPath(): string {
  return path.join(spellHome(), "registry.json");
}

export function runtimePolicyPath(): string {
  return path.join(spellHome(), "policy.json");
}

export async function ensureSpellDirs(): Promise<void> {
  await mkdir(spellsRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
  await mkdir(trustedPublishersRoot(), { recursive: true });
  await mkdir(licensesRoot(), { recursive: true });
}
