import { SpellBundleManifest } from "../types";

export function renderExecutionSummary(manifest: SpellBundleManifest): string {
  const lines: string[] = [];
  lines.push("=== Execution Summary ===");
  lines.push(`id@version: ${manifest.id}@${manifest.version}`);
  lines.push(`risk: ${manifest.risk}`);

  lines.push("effects:");
  if (manifest.effects.length === 0) {
    lines.push("  - none");
  } else {
    for (const effect of manifest.effects) {
      lines.push(`  - type=${effect.type}, target=${effect.target}, mutates=${effect.mutates}`);
    }
  }

  lines.push("permissions:");
  if (manifest.permissions.length === 0) {
    lines.push("  - none");
  } else {
    for (const permission of manifest.permissions) {
      lines.push(`  - connector=${permission.connector}, scopes=${permission.scopes.join(",")}`);
    }
  }

  lines.push(
    `billing: enabled=${manifest.billing.enabled}, mode=${manifest.billing.mode}, max_amount=${manifest.billing.max_amount}, currency=${manifest.billing.currency}`
  );
  lines.push(
    `runtime: execution=${manifest.runtime.execution}, docker_image=${manifest.runtime.docker_image ?? "-"}`
  );

  return lines.join("\n");
}
