export type SpellRisk = "low" | "medium" | "high" | "critical";
export type RuntimeExecution = "host" | "docker";
export type StepUses = "shell" | "http";
export type CheckType = "exit_code" | "file_exists" | "http_status" | "jsonpath_equals";

export interface SpellPermission {
  connector: string;
  scopes: string[];
}

export interface SpellEffect {
  type: string;
  target: string;
  mutates: boolean;
}

export interface SpellBilling {
  enabled: boolean;
  mode: "none" | "upfront" | "on_success" | "subscription";
  currency: string;
  max_amount: number;
}

export interface SpellRuntime {
  execution: RuntimeExecution;
  platforms: string[];
  docker_image?: string;
  max_parallel_steps?: number;
}

export interface SpellStepCondition {
  input_path?: string;
  output_path?: string;
  equals?: unknown;
  not_equals?: unknown;
}

export interface SpellStepRetry {
  max_attempts: number;
  backoff_ms?: number;
}

export interface SpellStep {
  uses: StepUses;
  name: string;
  run: string;
  rollback?: string;
  retry?: SpellStepRetry;
  depends_on?: string[];
  when?: SpellStepCondition;
}

export interface SpellCheck {
  type: CheckType;
  params: Record<string, unknown>;
}

export interface SpellBundleManifest {
  id: string;
  version: string;
  name: string;
  summary: string;
  inputs_schema: string;
  risk: SpellRisk;
  permissions: SpellPermission[];
  effects: SpellEffect[];
  billing: SpellBilling;
  runtime: SpellRuntime;
  steps: SpellStep[];
  checks: SpellCheck[];
}

export interface LoadedBundle {
  manifest: SpellBundleManifest;
  bundlePath: string;
  schemaPath: string;
  idKey: string;
}

export interface StepResult {
  stepName: string;
  uses: StepUses;
  started_at: string;
  finished_at: string;
  success: boolean;
  exitCode?: number | null;
  stdout_head?: string;
  stderr_head?: string;
  message?: string;
}

export interface CheckResult {
  type: CheckType;
  success: boolean;
  message: string;
}

export type RollbackState = "not_needed" | "fully_compensated" | "partially_compensated" | "not_compensated";

export interface RollbackSummary {
  total_executed_steps: number;
  rollback_planned_steps: number;
  rollback_attempted_steps: number;
  rollback_succeeded_steps: number;
  rollback_failed_steps: number;
  rollback_skipped_without_handler_steps: number;
  failed_step_names: string[];
  state: RollbackState;
  require_full_compensation?: boolean;
  manual_recovery_required?: boolean;
}

export interface CastContext {
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  bundlePath: string;
  manifest: SpellBundleManifest;
  stepResults: StepResult[];
}

export interface ExecutionLog {
  execution_id: string;
  started_at: string;
  finished_at: string;
  id: string;
  version: string;
  input: Record<string, unknown>;
  signature?: {
    required: boolean;
    status: "skipped" | "verified" | "unsigned" | "untrusted" | "invalid";
    publisher?: string;
    key_id?: string;
    digest?: string;
  };
  summary: {
    risk: SpellRisk;
    billing: SpellBilling;
    runtime: SpellRuntime;
    license: {
      licensed: boolean;
      name?: string;
    };
  };
  steps: StepResult[];
  outputs: Record<string, unknown>;
  checks: CheckResult[];
  rollback?: RollbackSummary;
  success: boolean;
  error?: string;
}

export interface CastOptions {
  id: string;
  version?: string;
  inputFile?: string;
  paramPairs: string[];
  dryRun: boolean;
  yes: boolean;
  allowBilling: boolean;
  requireSignature: boolean;
  verbose: boolean;
  profile?: string;
}
