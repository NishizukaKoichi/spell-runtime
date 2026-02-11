#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { installBundle } from "../bundle/install";
import { listInstalledSpells, readSchemaFromManifest, resolveInstalledBundle, summarizeSchema } from "../bundle/store";
import { castSpell } from "../runner/cast";
import { SpellError } from "../util/errors";
import { logsRoot } from "../util/paths";

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = new Command();

  program
    .name("spell")
    .description("Minimal runtime for SpellBundle v1")
    .showHelpAfterError(true);

  program
    .command("install")
    .description("Install a local spell bundle")
    .argument("<local-path>", "Path to local spell bundle")
    .action(async (localPath: string) => {
      const result = await installBundle(localPath);
      process.stdout.write(`${result.id}@${result.version}\n`);
    });

  program
    .command("list")
    .description("List installed spells")
    .action(async () => {
      const spells = await listInstalledSpells();
      if (spells.length === 0) {
        process.stdout.write("No spells installed\n");
        return;
      }

      process.stdout.write("id@version\tname\trisk\tbilling.enabled\truntime.execution\n");
      for (const spell of spells) {
        process.stdout.write(
          `${spell.id}@${spell.version}\t${spell.name}\t${spell.risk}\t${spell.billingEnabled}\t${spell.runtimeExecution}\n`
        );
      }
    });

  program
    .command("inspect")
    .description("Inspect installed spell")
    .argument("<id>", "Spell id")
    .option("--version <version>", "Specific version")
    .action(async (id: string, options: { version?: string }) => {
      const loaded = await resolveInstalledBundle(id, options.version);
      const schema = await readSchemaFromManifest(loaded.manifest, loaded.bundlePath);
      const schemaSummary = summarizeSchema(schema);

      const manifest = loaded.manifest;
      process.stdout.write(`識別\n`);
      process.stdout.write(`  id@version: ${manifest.id}@${manifest.version}\n`);
      process.stdout.write(`  name: ${manifest.name}\n`);
      process.stdout.write(`  summary: ${manifest.summary}\n`);

      process.stdout.write("供物\n");
      process.stdout.write(`  required: ${schemaSummary.required.join(",") || "(none)"}\n`);
      process.stdout.write(`  key types: ${schemaSummary.keyTypes.join(",") || "(none)"}\n`);

      process.stdout.write("鍵穴\n");
      if (manifest.permissions.length === 0) {
        process.stdout.write("  (none)\n");
      } else {
        for (const permission of manifest.permissions) {
          process.stdout.write(`  connector=${permission.connector} scopes=${permission.scopes.join(",")}\n`);
        }
      }

      process.stdout.write("作用\n");
      for (const effect of manifest.effects) {
        process.stdout.write(`  type=${effect.type} target=${effect.target} mutates=${effect.mutates}\n`);
      }

      process.stdout.write("代償\n");
      process.stdout.write(
        `  enabled=${manifest.billing.enabled} mode=${manifest.billing.mode} max_amount=${manifest.billing.max_amount} currency=${manifest.billing.currency}\n`
      );

      process.stdout.write("実行\n");
      process.stdout.write(
        `  execution=${manifest.runtime.execution} docker_image=${manifest.runtime.docker_image ?? "-"} platforms=${manifest.runtime.platforms.join(",")}\n`
      );

      process.stdout.write("封印\n");
      for (const check of manifest.checks) {
        process.stdout.write(`  type=${check.type} params=${JSON.stringify(check.params)}\n`);
      }
    });

  program
    .command("cast")
    .description("Cast a spell")
    .argument("<id>", "Spell id")
    .option("--version <version>", "Specific version")
    .option("-p, --param <key=value>", "Input override", collectParams, [])
    .option("--input <file>", "Input JSON file")
    .option("--dry-run", "Validate and summarize only", false)
    .option("--yes", "Acknowledge high or critical risk", false)
    .option("--allow-billing", "Allow billing-enabled spells", false)
    .option("--verbose", "Verbose logs", false)
    .option("--profile <name>", "Reserved for future use")
    .action(
      async (
        id: string,
        options: {
          version?: string;
          param: string[];
          input?: string;
          dryRun: boolean;
          yes: boolean;
          allowBilling: boolean;
          verbose: boolean;
          profile?: string;
        }
      ) => {
        const result = await castSpell({
          id,
          version: options.version,
          paramPairs: options.param,
          inputFile: options.input,
          dryRun: options.dryRun,
          yes: options.yes,
          allowBilling: options.allowBilling,
          verbose: options.verbose,
          profile: options.profile
        });

        process.stdout.write(`execution_id: ${result.executionId}\n`);
        process.stdout.write(`log: ${result.logPath}\n`);
      }
    );

  program
    .command("log")
    .description("Show execution log")
    .argument("<execution-id>", "Execution log file name")
    .action(async (executionId: string) => {
      const fileName = executionId.endsWith(".json") ? executionId : `${executionId}.json`;
      const filePath = path.join(logsRoot(), fileName);

      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch {
        throw new SpellError(`log not found: ${executionId}`);
      }

      process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

function collectParams(value: string, previous: string[]): string[] {
  return [...previous, value];
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
