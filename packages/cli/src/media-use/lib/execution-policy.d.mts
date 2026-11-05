export type PolicyEnvironment = Record<string, string | undefined>;
export const EXECUTION_POLICY_ENV: "HYPERFRAMES_EXECUTION_POLICY";
export const COMPANY_AGENTS_ONLY: "company-agents-only";
export class ExecutionPolicyError extends Error {
  readonly code: "policy_denied" | "policy_invalid";
  readonly hint: string;
  constructor(code: "policy_denied" | "policy_invalid", message: string);
}
export function executionPolicy(env?: PolicyEnvironment): "standard" | "company-agents-only";
export function isCompanyAgentsOnly(env?: PolicyEnvironment): boolean;
export function preparePolicyEnvironment(env?: PolicyEnvironment): void;
export function policyFailure(error: unknown): {
  ok: false;
  error: { code: "policy_denied" | "policy_invalid"; message: string; hint: string };
};
export function integratedExecutionDenial(
  operation: string,
  env?: PolicyEnvironment,
): ExecutionPolicyError | null;
export function assertIntegratedExecutionAllowed(operation: string, env?: PolicyEnvironment): void;
export function assertCompanyCommandAllowed(
  rawArgs: readonly string[],
  env?: PolicyEnvironment,
): void;
export function assertLocalMediaOperationAllowed(
  args: Record<string, unknown>,
  env?: PolicyEnvironment,
): void;
export function assertLocalAudioAllowed(
  flags: { quality?: unknown; provider?: unknown; read?: unknown },
  env?: PolicyEnvironment,
): void;
export function assertProviderAllowed(
  provider: { name: string; network?: boolean; paid?: boolean },
  env?: PolicyEnvironment,
): void;
export function localMediaEnvironment(env?: PolicyEnvironment): PolicyEnvironment;
