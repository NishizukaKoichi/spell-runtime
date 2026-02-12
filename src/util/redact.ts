const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE = /(authorization|token|secret|password|api[-_]?key|private[-_]?key|cookie|set-cookie)/i;
const SENSITIVE_ENV_NAME_RE = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH|COOKIE|SESSION|CREDENTIAL)/i;
const TOKEN_LIKE_RE = /\b(?:ghp|github_pat|npm|sk_live|sk_test|xoxb|xoxp)_[A-Za-z0-9_-]+\b/g;
const BEARER_RE = /(Bearer\s+)[^\s"']+/gi;

export function redactSecrets<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const secrets = collectSensitiveEnvValues(env);
  const seen = new WeakSet<object>();
  return redactValue(value, secrets, seen) as T;
}

export function collectSensitiveEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const set = new Set<string>();

  for (const [name, rawValue] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME_RE.test(name)) {
      continue;
    }
    if (typeof rawValue !== "string" || rawValue.trim() === "") {
      continue;
    }
    set.add(rawValue);
  }

  return Array.from(set).sort((a, b) => b.length - a.length);
}

function redactValue(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets, seen));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }

    out[key] = redactValue(raw, secrets, seen);
  }

  return out;
}

function redactString(value: string, secrets: string[]): string {
  let out = value;

  for (const secret of secrets) {
    if (secret.length < 4) {
      continue;
    }
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }

  out = out.replace(BEARER_RE, `$1${REDACTED}`);
  out = out.replace(TOKEN_LIKE_RE, REDACTED);

  return out;
}
