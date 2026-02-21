import pino from "pino";
import { evaluateChecks } from "../checks/evaluate";
import { readSchemaFromManifest, resolveInstalledBundle } from "../bundle/store";
import { writeExecutionLog, makeExecutionId } from "../logging/executionLog";
import { CastOptions, ExecutionLog } from "../types";
import { SpellError } from "../util/errors";
import { detectDockerPlatformForHost, detectHostPlatform, platformMatches } from "../util/platform";
import { buildInput, validateInputAgainstSchema } from "./input";
import { runHost } from "./hostRunner";
import { DockerExecutionError, runDocker } from "./dockerRunner";
import { renderExecutionSummary } from "./summary";
import { enforceSignatureOrThrow, verifyBundleSignature } from "../signature/verify";
import { publisherFromId } from "../signature/trustStore";
import { findMatchingLicenseForBilling } from "../license/store";
import { readRuntimeExecutionTimeoutMs, readRuntimeInputMaxBytes } from "./runtimeLimits";
import { evaluateRuntimePolicy, loadRuntimePolicy } from "../policy";
import { StepExecutionError } from "./executeSteps";

export interface CastResult {
  executionId: string;
  logPath: string;
  outputs: Record<string, unknown>;
}

export async function castSpell(options: CastOptions): Promise<CastResult> {
  const logger = pino({ level: options.verbose ? "debug" : "info" });
  const startedAt = new Date().toISOString();

  let executionId = makeExecutionId(options.id, options.version ?? "latest");

  const log: ExecutionLog = {
    execution_id: executionId,
    started_at: startedAt,
    finished_at: startedAt,
    id: options.id,
    version: options.version ?? "latest",
    input: {},
    summary: {
      risk: "low",
      billing: {
        enabled: false,
        mode: "none",
        currency: "USD",
        max_amount: 0
      },
      runtime: {
        execution: "host",
        platforms: []
      },
      license: {
        licensed: false
      }
    },
    steps: [],
    outputs: {},
    checks: [],
    success: false
  };

  try {
    const runtimeInputMaxBytes = readRuntimeInputMaxBytes();
    const runtimeExecutionTimeoutMs = readRuntimeExecutionTimeoutMs();

    const loaded = await resolveInstalledBundle(options.id, options.version);
    const { manifest, bundlePath } = loaded;

    executionId = makeExecutionId(manifest.id, manifest.version);
    log.execution_id = executionId;
    log.id = manifest.id;
    log.version = manifest.version;
    log.summary = {
      risk: manifest.risk,
      billing: manifest.billing,
      runtime: manifest.runtime,
      license: {
        licensed: false
      }
    };

    const runtimePolicy = await loadRuntimePolicy();

    log.signature = {
      required: options.requireSignature,
      status: "skipped"
    };

    const input = await buildInput(options.inputFile, options.paramPairs);
    const inputSizeBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (inputSizeBytes > runtimeInputMaxBytes) {
      throw new SpellError(
        `merged input is ${inputSizeBytes} bytes, exceeds SPELL_RUNTIME_INPUT_MAX_BYTES=${runtimeInputMaxBytes}`
      );
    }
    log.input = input;

    const schema = await readSchemaFromManifest(manifest, bundlePath);
    validateInputAgainstSchema(schema, input);

    const sigResult = await verifyBundleSignature(manifest, bundlePath).catch((error) => ({
      ok: false,
      status: "invalid" as const,
      publisher: publisherFromId(manifest.id),
      key_id: undefined,
      digest: undefined,
      message: (error as Error).message
    }));

    log.signature = {
      required: options.requireSignature,
      status: sigResult.status,
      publisher: sigResult.publisher,
      key_id: sigResult.key_id,
      digest: sigResult.digest
    };

    const policyDecision = evaluateRuntimePolicy(runtimePolicy, {
      spell_id: manifest.id,
      publisher: publisherFromId(manifest.id),
      risk: manifest.risk,
      execution: manifest.runtime.execution,
      effects: manifest.effects,
      signature_status: sigResult.status
    });
    if (!policyDecision.allow) {
      throw new SpellError(`policy denied: ${policyDecision.reason}`);
    }

    if (options.requireSignature) {
      enforceSignatureOrThrow(sigResult);
    }

    const hostPlatform = detectHostPlatform();
    const dockerPlatform = detectDockerPlatformForHost();
    const platformTarget = manifest.runtime.execution === "docker" ? dockerPlatform : hostPlatform;
    const platformOk = platformMatches(manifest.runtime.platforms, platformTarget);
    if (!platformOk) {
      throw new SpellError(
        `platform mismatch: host=${hostPlatform}, runtime=${manifest.runtime.execution}, target=${platformTarget}, spell supports=${manifest.runtime.platforms.join(",")}`
      );
    }

    if ((manifest.risk === "high" || manifest.risk === "critical") && !options.yes) {
      throw new SpellError(`risk ${manifest.risk} requires --yes`);
    }

    if (manifest.billing.enabled && !options.allowBilling) {
      throw new SpellError("billing enabled requires --allow-billing");
    }

    if (manifest.billing.enabled) {
      const matchedLicense = await findMatchingLicenseForBilling(manifest.billing);
      if (!matchedLicense) {
        throw new SpellError("billing enabled requires matching entitlement token");
      }
      log.summary.license = {
        licensed: true,
        name: matchedLicense.name
      };
    }

    for (const permission of manifest.permissions) {
      const tokenKey = `CONNECTOR_${permission.connector.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
      if (!process.env[tokenKey]) {
        throw new SpellError(`missing connector token ${tokenKey}`);
      }
    }

    process.stdout.write(`${renderExecutionSummary(manifest)}\n`);

    if (options.dryRun) {
      log.success = true;
      log.finished_at = new Date().toISOString();
      const logPath = await writeExecutionLog(log);
      return {
        executionId: executionId,
        logPath,
        outputs: {}
      };
    }

    if (manifest.runtime.execution === "docker") {
      logger.debug({ id: manifest.id, version: manifest.version }, "starting docker execution");

      const dockerResult = await runDocker(manifest, bundlePath, input, runtimeExecutionTimeoutMs);
      log.steps = dockerResult.stepResults;
      log.outputs = dockerResult.outputs;
      log.checks = dockerResult.checks;

      log.success = true;
      log.finished_at = new Date().toISOString();
      const logPath = await writeExecutionLog(log);

      return {
        executionId,
        logPath,
        outputs: dockerResult.outputs
      };
    }

    logger.debug({ id: manifest.id, version: manifest.version }, "starting host execution");

    const runResult = await runHost(manifest, bundlePath, input, runtimeExecutionTimeoutMs);
    log.steps = runResult.stepResults;
    log.outputs = runResult.outputs;

    const checkResults = await evaluateChecks(manifest.checks, bundlePath, runResult.outputs, true);
    log.checks = checkResults;

    const failedChecks = checkResults.filter((entry) => !entry.success);
    if (failedChecks.length > 0) {
      throw new SpellError(`check failed: ${failedChecks[0].message}`);
    }

    log.success = true;
    log.finished_at = new Date().toISOString();
    const logPath = await writeExecutionLog(log);

    return {
      executionId,
      logPath,
      outputs: runResult.outputs
    };
  } catch (error) {
    if (error instanceof StepExecutionError) {
      log.steps = error.stepResults;
      log.outputs = error.outputs;
      if (error.checks.length > 0) {
        log.checks = error.checks;
      }
    }

    if (error instanceof DockerExecutionError) {
      log.steps = error.stepResults;
      log.outputs = error.outputs;
      log.checks = error.checks;
    }

    log.error = (error as Error).message;
    log.finished_at = new Date().toISOString();
    await writeExecutionLog(log);
    throw error;
  }
}
