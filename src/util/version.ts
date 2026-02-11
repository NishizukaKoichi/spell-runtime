export function selectLatestVersion(versions: string[]): string {
  const sorted = [...versions].sort(compareVersionDesc);
  return sorted[0];
}

export function compareVersionDesc(a: string, b: string): number {
  const aParts = parseSemverParts(a);
  const bParts = parseSemverParts(b);

  if (aParts && bParts) {
    for (let i = 0; i < 3; i += 1) {
      if (aParts[i] !== bParts[i]) {
        return bParts[i] - aParts[i];
      }
    }
    return b.localeCompare(a);
  }

  if (aParts && !bParts) {
    return -1;
  }

  if (!aParts && bParts) {
    return 1;
  }

  return b.localeCompare(a);
}

function parseSemverParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
