#!/usr/bin/env node
import { createHash, createPublicKey } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { installBundle } from "../bundle/install";
import {
  addRegistryIndex,
  resolveRegistryInstallSource,
  readRegistryConfigIfExists,
  removeRegistryIndex,
  setDefaultRegistryIndex,
  validateRegistryIndexes
} from "../bundle/registry";
import { listInstalledSpells, readSchemaFromManifest, resolveInstalledBundle, summarizeSchema } from "../bundle/store";
import { generateSigningKeypair, signBundleFromPrivateKey } from "../signature/signing";
import { castSpell } from "../runner/cast";
import { verifyBundleSignature } from "../signature/verify";
import { inspectLicense, listLicenses, removeLicense, restoreLicense, revokeLicense, upsertLicense } from "../license/store";
import { loadRuntimePolicy, parseRuntimePolicyFile, runtimePolicyFilePath } from "../policy";
import {
  loadPublisherTrust,
  listTrustedPublishers,
  removeTrustedPublisherKey,
  removeTrustedPublisher,
  restoreTrustedPublisherKey,
  revokeTrustedPublisherKey,
  upsertTrustedPublisherKey
} from "../signature/trustStore";
import { SpellError } from "../util/errors";
import { readExecutionLogJson, readExecutionLogRaw, readOutputFromExecutionLog } from "../logging/readExecutionLog";

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = new Command();

  program
    .name("spell")
    .description("Minimal runtime for SpellBundle v1")
    .showHelpAfterError(true);

  program
    .command("install")
    .description("Install a spell bundle from local path, git URL, OCI image, or registry locator")
    .argument(
      "<source>",
      "Path, git URL (requires #<ref>), oci:<image-ref>, or registry:<id>[@<version|latest>]"
    )
    .option("--registry <name>", "Registry index name (for registry:<id> sources)")
    .action(async (source: string, options: { registry?: string }) => {
      const result = await installBundle(source, { registryName: options.registry });
      process.stdout.write(`${result.id}@${result.version}\n`);
    });

  const registry = program.command("registry").description("Manage spell registry indexes");

  registry
    .command("set")
    .description("Set or replace the default registry index URL")
    .argument("<url>", "URL to spell-index.v1.json")
    .action(async (url: string) => {
      const config = await setDefaultRegistryIndex(url);
      process.stdout.write(`default\t${config.indexes[0].url}\n`);
    });

  registry
    .command("add")
    .description("Add a named registry index")
    .argument("<name>", "Unique registry index name")
    .argument("<url>", "URL to spell-index.v1.json")
    .action(async (name: string, url: string) => {
      const config = await addRegistryIndex(name, url);
      const added = config.indexes.find((index) => index.name === name.trim());
      process.stdout.write(`${added?.name ?? name.trim()}\t${added?.url ?? url}\n`);
    });

  registry
    .command("remove")
    .description("Remove a named registry index")
    .argument("<name>", "Registry index name to remove")
    .action(async (name: string) => {
      await removeRegistryIndex(name);
      process.stdout.write(`removed\t${name.trim()}\n`);
    });

  registry
    .command("validate")
    .description("Fetch and validate configured registry indexes")
    .option("--name <name>", "Validate only one configured registry index by name")
    .action(async (options: { name?: string }) => {
      const results = await validateRegistryIndexes(options.name);
      for (const result of results) {
        process.stdout.write(`${result.name}\t${result.url}\t${result.spellCount}\n`);
      }
    });

  registry
    .command("resolve")
    .description("Resolve a registry locator to concrete source and pins")
    .argument("<source>", "registry:<id> or registry:<id>@<version|latest>")
    .option("--name <name>", "Registry index name (default: default)")
    .action(async (source: string, options: { name?: string }) => {
      const resolved = await resolveRegistryInstallSource(source, options.name);
      process.stdout.write(`registry\t${resolved.registryName}\t${resolved.registryUrl}\n`);
      process.stdout.write(`id@version\t${resolved.id}@${resolved.version}\n`);
      process.stdout.write(`source\t${resolved.source}\n`);
      process.stdout.write(`commit\t${resolved.expectedCommit ?? "-"}\n`);
      process.stdout.write(`digest\t${resolved.expectedDigest ?? "-"}\n`);
    });

  registry
    .command("show")
    .description("Show configured registry indexes")
    .action(async () => {
      const config = await readRegistryConfigIfExists();
      if (!config) {
        process.stdout.write("No registry indexes configured\n");
        return;
      }

      process.stdout.write("name\turl\n");
      for (const index of config.indexes) {
        process.stdout.write(`${index.name}\t${index.url}\n`);
      }
    });

  const policy = program.command("policy").description("Manage runtime policy");

  policy
    .command("show")
    .description("Show current runtime policy")
    .action(async () => {
      const configuredPolicy = await loadRuntimePolicy();
      if (!configuredPolicy) {
        process.stdout.write(`No runtime policy configured at ${runtimePolicyFilePath()}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(configuredPolicy, null, 2)}\n`);
    });

  policy
    .command("validate")
    .description("Validate a runtime policy file")
    .requiredOption("--file <path>", "Path to policy JSON")
    .action(async (options: { file: string }) => {
      const candidateFile = path.resolve(options.file);
      await parseRuntimePolicyFile(candidateFile);
      process.stdout.write("policy valid\n");
    });

  policy
    .command("set")
    .description("Validate and set runtime policy")
    .requiredOption("--file <path>", "Path to policy JSON")
    .action(async (options: { file: string }) => {
      const candidateFile = path.resolve(options.file);
      const policyConfig = await parseRuntimePolicyFile(candidateFile);
      const destination = runtimePolicyFilePath();

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(policyConfig, null, 2)}\n`, "utf8");

      process.stdout.write(`policy written: ${destination}\n`);
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
    .command("verify")
    .description("Verify installed spell signature and trust chain")
    .argument("<id>", "Spell id")
    .option("--version <version>", "Specific version")
    .action(async (id: string, options: { version?: string }) => {
      const loaded = await resolveInstalledBundle(id, options.version);
      const result = await verifyBundleSignature(loaded.manifest, loaded.bundlePath);

      process.stdout.write(`id@version: ${loaded.manifest.id}@${loaded.manifest.version}\n`);
      process.stdout.write(`status: ${result.status}\n`);
      process.stdout.write(`publisher: ${result.publisher}\n`);
      process.stdout.write(`key_id: ${result.key_id ?? "-"}\n`);
      process.stdout.write(`digest: ${result.digest ?? "-"}\n`);
      process.stdout.write(`message: ${result.message}\n`);

      if (!result.ok) {
        throw new SpellError(`signature ${result.status}: ${result.message}`);
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
    .option("--require-signature", "Require verified signature (default)", true)
    .option("--allow-unsigned", "Allow unsigned bundles (overrides signature requirement)", false)
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
          allowUnsigned: boolean;
          verbose: boolean;
          profile?: string;
        }
      ) => {
        const requireSignature = options.allowUnsigned ? false : options.requireSignature;
        const result = await castSpell({
          id,
          version: options.version,
          paramPairs: options.param,
          inputFile: options.input,
          dryRun: options.dryRun,
          yes: options.yes,
          allowBilling: options.allowBilling,
          requireSignature,
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

  const license = program.command("license").description("Manage local entitlement tokens for billing");

  license
    .command("add")
    .description("Add or update a local entitlement token")
    .argument("<name>", "License label")
    .argument("<token>", "Entitlement token")
    .action(async (name: string, token: string) => {
      await upsertLicense(name, token);
      process.stdout.write(`added license=${name.trim()}\n`);
    });

  license
    .command("list")
    .description("List local licenses")
    .action(async () => {
      const licenses = await listLicenses();
      if (licenses.length === 0) {
        process.stdout.write("No licenses\n");
        return;
      }

      process.stdout.write("name\tissuer\tmode\tcurrency\tmax_amount\texpires_at\trevoked\tupdated_at\n");
      for (const entry of licenses) {
        process.stdout.write(
          `${entry.name}\t${entry.entitlement?.issuer ?? "-"}\t${entry.entitlement?.mode ?? "-"}\t${entry.entitlement?.currency ?? "-"}\t${entry.entitlement?.max_amount ?? "-"}\t${entry.entitlement?.expires_at ?? "-"}\t${entry.revoked}\t${entry.updated_at ?? "-"}\n`
        );
      }
    });

  license
    .command("inspect")
    .description("Inspect a local license token")
    .argument("<name>", "License label")
    .action(async (name: string) => {
      const entry = await inspectLicense(name);
      if (!entry) {
        throw new SpellError(`license not found: ${name}`);
      }

      process.stdout.write(`name: ${entry.name}\n`);
      process.stdout.write(`issuer: ${entry.entitlement?.issuer ?? "-"}\n`);
      process.stdout.write(`mode: ${entry.entitlement?.mode ?? "-"}\n`);
      process.stdout.write(`currency: ${entry.entitlement?.currency ?? "-"}\n`);
      process.stdout.write(`max_amount: ${entry.entitlement?.max_amount ?? "-"}\n`);
      process.stdout.write(`window: ${entry.entitlement?.not_before ?? "-"} .. ${entry.entitlement?.expires_at ?? "-"}\n`);
      process.stdout.write(`revoked: ${entry.revoked}\n`);
    });

  license
    .command("revoke")
    .description("Revoke a local license token")
    .argument("<name>", "License label")
    .option("--reason <text>", "Revocation reason")
    .action(async (name: string, options: { reason?: string }) => {
      const revoked = await revokeLicense(name, options.reason);
      process.stdout.write(`revoked license=${revoked.name}\n`);
    });

  license
    .command("restore")
    .description("Restore a revoked local license token")
    .argument("<name>", "License label")
    .action(async (name: string) => {
      const restored = await restoreLicense(name);
      process.stdout.write(`restored license=${restored.name}\n`);
    });

  license
    .command("remove")
    .description("Remove a local license token")
    .argument("<name>", "License label")
    .action(async (name: string) => {
      const removed = await removeLicense(name);
      if (!removed) {
        throw new SpellError(`license not found: ${name}`);
      }
      process.stdout.write(`removed license=${name.trim()}\n`);
    });

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

      process.stdout.write("publisher\tkey_id\tstatus\n");
      for (const entry of publishers) {
        for (const key of entry.keys) {
          const status = key.revoked === true ? "revoked" : "active";
          process.stdout.write(`${entry.publisher}\t${key.key_id}\t${status}\n`);
        }
      }
    });

  trust
    .command("inspect")
    .description("Inspect trusted keys for a publisher")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .action(async (publisher: string) => {
      const trustRecord = await loadPublisherTrust(publisher);
      if (!trustRecord) {
        throw new SpellError(`trusted publisher not found: ${publisher}`);
      }

      process.stdout.write("key_id\tstatus\talgorithm\tfingerprint\n");
      for (const key of trustRecord.keys) {
        const status = key.revoked === true ? "revoked" : "active";
        process.stdout.write(
          `${key.key_id}\t${status}\t${key.algorithm}\t${shortenPublicKeyFingerprint(key.public_key)}\n`
        );
      }
    });

  trust
    .command("revoke-key")
    .description("Revoke a trusted publisher key without deleting publisher trust")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .requiredOption("--key-id <id>", "Key id")
    .option("--reason <text>", "Revocation reason")
    .action(async (publisher: string, options: { keyId: string; reason?: string }) => {
      const revoked = await revokeTrustedPublisherKey(publisher, options.keyId, options.reason);
      process.stdout.write(`revoked publisher=${publisher} key_id=${revoked.key_id}\n`);
    });

  trust
    .command("restore-key")
    .description("Restore a revoked trusted publisher key")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .requiredOption("--key-id <id>", "Key id")
    .action(async (publisher: string, options: { keyId: string }) => {
      const restored = await restoreTrustedPublisherKey(publisher, options.keyId);
      process.stdout.write(`restored publisher=${publisher} key_id=${restored.key_id}\n`);
    });

  trust
    .command("remove-key")
    .description("Remove one trusted publisher key")
    .argument("<publisher>", "Publisher (id prefix before first slash)")
    .requiredOption("--key-id <id>", "Key id")
    .action(async (publisher: string, options: { keyId: string }) => {
      const removed = await removeTrustedPublisherKey(publisher, options.keyId);
      process.stdout.write(`removed publisher=${publisher} key_id=${removed.key_id}\n`);
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
      const raw = await readExecutionLogRaw(executionId);
      process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    });

  program
    .command("get-output")
    .description("Read one output value from an execution log")
    .argument("<execution-id>", "Execution id (with or without .json)")
    .argument("<path>", "Output reference (e.g. step.send.json.data.id)")
    .action(async (executionId: string, outputPath: string) => {
      const log = await readExecutionLogJson(executionId);
      const value = readOutputFromExecutionLog(log, outputPath);

      if (typeof value === "string") {
        process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
        return;
      }

      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

function shortenPublicKeyFingerprint(publicKeyBase64Url: string): string {
  const decoded = Buffer.from(publicKeyBase64Url, "base64url");
  const fingerprint = createHash("sha256").update(decoded).digest("hex");
  return `${fingerprint.slice(0, 12)}...${fingerprint.slice(-8)}`;
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
