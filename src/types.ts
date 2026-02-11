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
}

export interface SpellStep {
  uses: StepUses;
  name: string;
  run: string;
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
  summary: {
    risk: SpellRisk;
    billing: SpellBilling;
    runtime: SpellRuntime;
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
  verbose: boolean;
  profile?: string;
}
