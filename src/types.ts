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

export interface SpellStep {
  uses: StepUses;
  name: string;
  run: string;
  rollback?: string;
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
