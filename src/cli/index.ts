#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { installBundle } from "../bundle/install";
import { listInstalledSpells, readSchemaFromManifest, resolveInstalledBundle, summarizeSchema } from "../bundle/store";
import { generateSigningKeypair, signBundleFromPrivateKey } from "../signature/signing";
import { castSpell } from "../runner/cast";
import { listTrustedPublishers, removeTrustedPublisher, upsertTrustedPublisherKey } from "../signature/trustStore";
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
    .option("--require-signature", "Require verified signature", false)
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
          requireSignature: boolean;
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
          requireSignature: options.requireSignature,
          verbose: options.verbose,
          profile: options.profile
        });

        process.stdout.write(`execution_id: ${result.executionId}\n`);
        process.stdout.write(`log: ${result.logPath}\n`);
      }
    );

  const signCmd = program.command("sign").description("Create signing keys and sign spell bundles");

  signCmd
    .command("keygen")
    .description("Generate an ed25519 keypair for spell signing")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .option("--key-id <id>", "Key id", "default")
    .option("--out-dir <dir>", "Output directory", ".spell-keys")
    .action(async (publisher: string, options: { keyId: string; outDir: string }) => {
      const result = await generateSigningKeypair({
        publisher,
        keyId: options.keyId,
        outDir: options.outDir
      });

      process.stdout.write(`publisher: ${result.publisher}\n`);
      process.stdout.write(`key_id: ${result.keyId}\n`);
      process.stdout.write(`private_key: ${result.privateKeyPath}\n`);
      process.stdout.write(`public_key_file: ${result.publicKeyPath}\n`);
      process.stdout.write(`public_key_base64url: ${result.publicKeyBase64Url}\n`);
      process.stdout.write(
        `trust_add: spell trust add ${result.publisher} ${result.publicKeyBase64Url} --key-id ${result.keyId}\n`
      );
    });

  signCmd
    .command("bundle")
    .description("Create spell.sig.json for a local spell bundle")
    .argument("<local-path>", "Path to local bundle containing spell.yaml")
    .requiredOption("--private-key <file>", "PKCS#8 private key (PEM)")
    .option("--key-id <id>", "Key id", "default")
    .option("--publisher <name>", "Publisher override (defaults to id prefix)")
    .action(
      async (
        localPath: string,
        options: {
          privateKey: string;
          keyId: string;
          publisher?: string;
        }
      ) => {
        const result = await signBundleFromPrivateKey({
          bundlePath: localPath,
          privateKeyPath: options.privateKey,
          keyId: options.keyId,
          publisher: options.publisher
        });

        process.stdout.write(`signed: ${result.signaturePath}\n`);
        process.stdout.write(`publisher: ${result.publisher}\n`);
        process.stdout.write(`key_id: ${result.keyId}\n`);
        process.stdout.write(`digest: ${result.digestHex}\n`);
      }
    );

  const trust = program.command("trust").description("Manage trusted publisher keys");

  trust
    .command("add")
    .description("Add or update a trusted publisher public key")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .argument("<public-key>", "ed25519 public key (spki der) as base64url")
    .option("--key-id <id>", "Key id", "default")
    .action(async (publisher: string, publicKey: string, options: { keyId: string }) => {
      const trimmed = publicKey.trim();
      try {
        const der = Buffer.from(trimmed, "base64url");
        createPublicKey({ key: der, format: "der", type: "spki" });
      } catch (error) {
        throw new SpellError(`invalid public key: ${(error as Error).message}`);
      }

      await upsertTrustedPublisherKey(publisher, {
        key_id: options.keyId,
        algorithm: "ed25519",
        public_key: trimmed
      });

      process.stdout.write(`trusted publisher=${publisher} key_id=${options.keyId}\n`);
    });

  trust
    .command("list")
    .description("List trusted publishers")
    .action(async () => {
      const publishers = await listTrustedPublishers();
      if (publishers.length === 0) {
        process.stdout.write("No trusted publishers\n");
        return;
      }

      process.stdout.write("publisher\tkey_ids\n");
      for (const entry of publishers) {
        const ids = entry.keys.map((k) => k.key_id).sort().join(",");
        process.stdout.write(`${entry.publisher}\t${ids}\n`);
      }
    });

  trust
    .command("remove")
    .description("Remove a trusted publisher (all keys)")
    .argument("<publisher>", "Publisher")
    .action(async (publisher: string) => {
      const removed = await removeTrustedPublisher(publisher);
      if (!removed) {
        throw new SpellError(`trusted publisher not found: ${publisher}`);
      }
      process.stdout.write(`removed publisher=${publisher}\n`);
    });

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
