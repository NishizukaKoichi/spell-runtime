import pino from "pino";
import { evaluateChecks } from "../checks/evaluate";
import { readSchemaFromManifest, resolveInstalledBundle } from "../bundle/store";
import { writeExecutionLog, makeExecutionId } from "../logging/executionLog";
import { CastOptions, ExecutionLog } from "../types";
import { SpellError } from "../util/errors";
import { detectDockerPlatformForHost, detectHostPlatform, platformMatches } from "../util/platform";
import { buildInput, validateInputAgainstSchema } from "./input";
import { runHost } from "./hostRunner";
import { runDocker } from "./dockerRunner";
import { renderExecutionSummary } from "./summary";

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
      }
    },
    steps: [],
    outputs: {},
    checks: [],
    success: false
  };

  try {
    const loaded = await resolveInstalledBundle(options.id, options.version);
    const { manifest, bundlePath } = loaded;

    executionId = makeExecutionId(manifest.id, manifest.version);
    log.execution_id = executionId;
    log.id = manifest.id;
    log.version = manifest.version;
    log.summary = {
      risk: manifest.risk,
      billing: manifest.billing,
      runtime: manifest.runtime
    };

    const input = await buildInput(options.inputFile, options.paramPairs);
    log.input = input;

    const schema = await readSchemaFromManifest(manifest, bundlePath);
    validateInputAgainstSchema(schema, input);

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

      const dockerResult = await runDocker(manifest, bundlePath, input);
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

    const runResult = await runHost(manifest, bundlePath, input);
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
    log.error = (error as Error).message;
    log.finished_at = new Date().toISOString();
    await writeExecutionLog(log);
    throw error;
  }
}
