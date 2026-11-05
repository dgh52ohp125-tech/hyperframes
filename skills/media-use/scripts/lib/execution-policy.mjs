/** Opt-in orchestration policy, not a sandbox for project JavaScript or external tools. */
export const EXECUTION_POLICY_ENV = "HYPERFRAMES_EXECUTION_POLICY";
export const COMPANY_AGENTS_ONLY = "company-agents-only";

export class ExecutionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionPolicyError";
    this.code = code;
    this.hint =
      "Use supplied assets and the documented local commands, or change the policy explicitly in the launching environment.";
  }
}

export function executionPolicy(env = process.env) {
  const value = env[EXECUTION_POLICY_ENV];
  if (value === undefined || value === "" || value === "standard") return "standard";
  if (value === COMPANY_AGENTS_ONLY) return value;
  throw new ExecutionPolicyError(
    "policy_invalid",
    `${EXECUTION_POLICY_ENV} must be standard or ${COMPANY_AGENTS_ONLY}.`,
  );
}

export function isCompanyAgentsOnly(env = process.env) {
  return executionPolicy(env) === COMPANY_AGENTS_ONLY;
}

export function preparePolicyEnvironment(env = process.env) {
  if (!isCompanyAgentsOnly(env)) return;
  // Process-local only. Do not write preferences or let project .env downgrade the policy.
  env.HYPERFRAMES_NO_TELEMETRY = "1";
  env.DO_NOT_TRACK = "1";
  env.HYPERFRAMES_NO_UPDATE_CHECK = "1";
  env.HYPERFRAMES_NO_AUTO_INSTALL = "1";
}

export function policyFailure(error) {
  if (!(error instanceof ExecutionPolicyError)) throw error;
  return { ok: false, error: { code: error.code, message: error.message, hint: error.hint } };
}

function denied(operation) {
  throw new ExecutionPolicyError(
    "policy_denied",
    `${operation} is not enabled by the ${COMPANY_AGENTS_ONLY} execution policy.`,
  );
}

export function integratedExecutionDenial(operation, env = process.env) {
  try {
    if (isCompanyAgentsOnly(env)) denied(operation);
    return null;
  } catch (error) {
    if (!(error instanceof ExecutionPolicyError)) throw error;
    return error;
  }
}

export function assertIntegratedExecutionAllowed(operation, env = process.env) {
  const error = integratedExecutionDenial(operation, env);
  if (error) throw error;
}

const LOCAL_COMMANDS = new Set([
  "lint",
  "check",
  "render",
  "snapshot",
  "info",
  "compositions",
  "beats",
]);
const LOCAL_SUBCOMMANDS = {
  measure: new Set([
    "probe",
    "cuts",
    "events",
    "frames",
    "extract",
    "curve",
    "energy",
    "ink",
    "look",
    "sync",
  ]),
  timeline: new Set([
    "move",
    "trim",
    "split",
    "delete",
    "set",
    "duplicate",
    "ids",
    "apply",
    "undo",
  ]),
  history: new Set(["show", "undo", "restore", "peek", "pin", "begin", "end"]),
  "media-use": new Set(["adopt", "candidates", "reuse", "from", "stats"]),
};

function hasFlag(args, flag) {
  return args.some(
    (arg) =>
      arg === `--${flag}` ||
      arg.startsWith(`--${flag}=`) ||
      arg === `--no-${flag}` ||
      arg.startsWith(`--no-${flag}=`),
  );
}

function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === `--${flag}`) values.push(args[i + 1]);
    else if (args[i].startsWith(`--${flag}=`)) values.push(args[i].slice(flag.length + 3));
  }
  return values;
}

/** Check parsed flags too: option values and positional tokens must not impersonate flags. */
export function assertLocalAudioAllowed(flags, env = process.env) {
  if (!isCompanyAgentsOnly(env)) return;
  if (flags.quality !== "fast" || flags.provider !== undefined || flags.read)
    denied("audio without --quality fast, or with --provider/--read");
}

/** Deny unreviewed command routes before auth, provider discovery or command loading. */
export function assertCompanyCommandAllowed(rawArgs, env = process.env) {
  if (!isCompanyAgentsOnly(env)) return;
  preparePolicyEnvironment(env);
  const args = rawArgs[0] === "help" ? rawArgs.slice(1) : rawArgs;
  const [command, child] = args;
  if (!command || ["--help", "-h", "--version", "-V"].includes(command)) return;
  if (command === "audio") {
    const quality = flagValues(args, "quality");
    if (
      quality.length !== 1 ||
      quality[0] !== "fast" ||
      hasFlag(args, "provider") ||
      hasFlag(args, "read")
    )
      denied("audio without an unambiguous --quality fast, or with --provider/--read");
    return;
  }
  if (Object.hasOwn(LOCAL_SUBCOMMANDS, command)) {
    const group = LOCAL_SUBCOMMANDS[command];
    // timeline/history also have a documented read-only root form.
    if (
      (command === "timeline" || command === "history") &&
      (!child || args.slice(1).every((arg) => ["--json", "--help", "-h"].includes(arg)))
    )
      return;
    if (!group.has(child)) denied(`${command} ${child ?? ""}`.trim());
    if (command === "measure" && child === "events" && hasFlag(args, "map"))
      denied("measure events --map");
    return;
  }
  if (!LOCAL_COMMANDS.has(command)) denied(command);
  if (command === "snapshot" && hasFlag(args, "describe")) denied("snapshot --describe");
  // The upstream Docker image installs a different CLI without this fork's policy.
  if (command === "render" && hasFlag(args, "docker")) denied("render --docker");
}

/** The direct media resolver may only inspect/reuse/import supplied local assets. */
export function assertLocalMediaOperationAllowed(args, env = process.env) {
  if (!isCompanyAgentsOnly(env)) return;
  preparePolicyEnvironment(env);
  if (args.doctor || args.provider || args.analyze || args.for || args.params)
    denied("media provider discovery, overrides or analysis");
  if (args.help) return;
  if (
    args.from &&
    ((/^[a-z][a-z0-9+.-]*:/i.test(args.from) && !/^[a-z]:[\\/]/i.test(args.from)) ||
      args.from.startsWith("//") ||
      args.from.startsWith("\\\\"))
  )
    denied("remote media ingestion");
  if (!(args.adopt || args.candidates || args["dry-run"] || args.reuse || args.from || args.stats))
    denied("automatic media resolution; provide a local asset with media-use from");
}

const LOCAL_PROVIDERS = new Set([
  "bundled.sfx",
  "design_spec",
  "color_grade.local",
  "cube_lut.local",
]);

/** Unknown/new providers are denied until reviewed; an explicit override never wins. */
export function assertProviderAllowed(provider, env = process.env) {
  if (
    isCompanyAgentsOnly(env) &&
    (!LOCAL_PROVIDERS.has(provider.name) || provider.network || provider.paid)
  )
    denied(`provider ${provider.name}`);
}

/** Skip credential resolution/refresh for policy-permitted local media operations. */
export function localMediaEnvironment(env = process.env) {
  const copy = { ...env };
  preparePolicyEnvironment(copy);
  for (const key of [
    "HEYGEN_API_KEY",
    "HYPERFRAMES_API_KEY",
    "HEYGEN_ACCESS_TOKEN",
    "HEYGEN_CONFIG_DIR",
  ])
    delete copy[key];
  return copy;
}
