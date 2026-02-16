export function detectHostPlatform(): string {
  return `${process.platform}/${process.arch}`;
}

export function detectDockerPlatformForHost(): string {
  // Docker execution runs in a linux container even on darwin/win32 hosts.
  return `linux/${normalizeArch(process.arch)}`;
}

export function platformMatches(supported: string[], target: string): boolean {
  const expanded = expandPlatformAliases(target);
  return supported.some((entry) => expanded.includes(entry));
}

function expandPlatformAliases(platform: string): string[] {
  const trimmed = platform.trim();
  if (!trimmed.includes("/")) {
    return [trimmed];
  }

  const [os, archRaw] = trimmed.split("/", 2);
  const arch = normalizeArch(archRaw);

  const out = new Set<string>();
  out.add(`${os}/${archRaw}`);
  out.add(`${os}/${arch}`);

  // Treat x64 and amd64 as aliases across OSes.
  if (arch === "amd64") {
    out.add(`${os}/x64`);
  }
  if (arch === "x64") {
    out.add(`${os}/amd64`);
  }

  return Array.from(out);
}

function normalizeArch(arch: string): string {
  if (arch === "x64") {
    return "amd64";
  }
  if (arch === "amd64") {
    return "amd64";
  }
  return arch;
}
