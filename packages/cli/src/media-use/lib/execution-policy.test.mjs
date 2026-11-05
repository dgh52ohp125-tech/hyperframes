import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import {
  COMPANY_AGENTS_ONLY,
  EXECUTION_POLICY_ENV,
  executionPolicy,
  assertCompanyCommandAllowed,
  assertLocalMediaOperationAllowed,
  assertLocalAudioAllowed,
  assertProviderAllowed,
  integratedExecutionDenial,
  localMediaEnvironment,
  policyFailure,
} from "./execution-policy.mjs";
import { getProvider, getProviders, runProviders } from "./registry.mjs";

const strict = () => ({ [EXECUTION_POLICY_ENV]: COMPANY_AGENTS_ONLY });
let previous;
beforeEach(() => {
  previous = process.env[EXECUTION_POLICY_ENV];
  delete process.env[EXECUTION_POLICY_ENV];
});
afterEach(() => {
  if (previous === undefined) delete process.env[EXECUTION_POLICY_ENV];
  else process.env[EXECUTION_POLICY_ENV] = previous;
});
const policyError = (run, code = "policy_denied") => assert.throws(run, { code });

test("default and explicit standard preserve unrestricted dispatch and do not mutate environment", () => {
  for (const env of [{}, { [EXECUTION_POLICY_ENV]: "" }, { [EXECUTION_POLICY_ENV]: "standard" }]) {
    const original = { ...env };
    assert.equal(executionPolicy(env), "standard");
    assertCompanyCommandAllowed(["future-command", "--provider", "anything"], env);
    assertProviderAllowed({ name: "new-provider", network: true, paid: true }, env);
    assert.equal(integratedExecutionDenial("model", env), null);
    assert.deepEqual(env, original);
  }
});

for (const value of ["COMPANY-AGENTS-ONLY", "company-agents-onl", "false", "0", " "]) {
  test("invalid policy fails closed: " + JSON.stringify(value), () => {
    policyError(
      () => assertCompanyCommandAllowed(["--help"], { [EXECUTION_POLICY_ENV]: value }),
      "policy_invalid",
    );
  });
}

const allowed = [
  ["lint"],
  ["check", "--prepare-media"],
  ["render", "--output", "movie.mp4"],
  ["snapshot", "--at", "0,1"],
  ["info"],
  ["compositions"],
  ["beats"],
  ["audio", "sound.wav", "--quality", "fast"],
  ["audio", "--quality=fast", "sound.wav"],
  ["audio", "--quality=fast", "--", "sound.wav"],
  ["timeline"],
  ["timeline", "--json"],
  ["timeline", "move", "clip", "--to", "1"],
  ["history"],
  ["history", "begin", "--who", "company-agent"],
  ["media-use", "from", "asset.png"],
  ["media-use", "adopt"],
  ["media-use", "candidates"],
  ["media-use", "stats"],
  ["media-use", "reuse", "--reuse", "abc"],
  ["--help"],
  ["--version"],
  ...["probe", "cuts", "events", "frames", "extract", "curve", "energy", "ink", "look", "sync"].map(
    (name) => ["measure", name, "reference.mp4"],
  ),
];
for (const args of allowed)
  test("allows reviewed route: " + args.join(" "), () => {
    assertCompanyCommandAllowed(args, strict());
  });

const blocked = [
  ["tts"],
  ["transcribe"],
  ["remove-background"],
  ["reverse", "start"],
  ["cloud"],
  ["billing"],
  ["auth", "login"],
  ["catalog"],
  ["add"],
  ["preview"],
  ["models", "list"],
  ["doctor"],
  ["diff"],
  ["future-command"],
  ["constructor"],
  ["measure", "face"],
  ["measure", "new-command"],
  ["measure", "--json", "face"],
  ["measure", "events", "--map"],
  ["measure", "events", "--map=false"],
  ["snapshot", "--describe"],
  ["snapshot", "--describe=false"],
  ["snapshot", "--no-describe"],
  ["render", "--docker"],
  ["render", "--docker=false"],
  ["render", "--no-docker"],
  ["audio"],
  ["audio", "--quality", "local"],
  ["audio", "--quality=best"],
  ["audio", "--quality=fast", "--quality", "best"],
  ["audio", "--quality=fast", "--quality=fast"],
  ["audio", "--quality=fast", "--provider=onsets=signal"],
  ["audio", "--quality=fast", "--read"],
  ["audio", "--quality=fast", "--no-read"],
  ["audio", "real.wav", "--only", "beats", "--", "--quality", "fast"],
  ["audio", "--", "--quality=fast"],
  ["timeline", "new-command"],
  ["timeline", "--json", "new-command"],
  ["history", "--json", "new-command"],
  ["media-use", "resolve"],
  ["media-use", "generate"],
  ["media-use", "doctor"],
];
for (const args of blocked)
  test("denies unreviewed route: " + args.join(" "), () => {
    policyError(() => assertCompanyCommandAllowed(args, strict()));
  });

test("parsed audio options must independently select signal-only work", () => {
  assertLocalAudioAllowed({ quality: "fast", read: false }, strict());
  for (const flags of [
    {},
    { quality: "local" },
    { quality: ["fast"] },
    { quality: "fast", provider: "" },
    { quality: "fast", read: true },
  ])
    policyError(() => assertLocalAudioAllowed(flags, strict()));
  assertLocalAudioAllowed({ quality: "best", read: true, provider: "remote" }, {});
  policyError(
    () => assertLocalAudioAllowed({ quality: "fast" }, { [EXECUTION_POLICY_ENV]: "typo" }),
    "policy_invalid",
  );
});

test("audio command checks parsed flags before reading assets or selecting providers", () => {
  const source = readFileSync(new URL("../../commands/audio.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("async run({ args })"));
  const guard = run.indexOf("assertLocalAudioAllowed(flags)");
  assert.ok(guard > 0 && guard < run.indexOf("read(files, flags)"));
  assert.ok(guard < run.indexOf("fileTargets(files, flags)"));
  assert.ok(guard < run.indexOf("clipTargets(flags, query)"));
  assert.ok(guard < run.indexOf("analyzeTargets("));
});

test("policy disables telemetry and automatic updates only in the current process environment", () => {
  const env = strict();
  assertCompanyCommandAllowed(["lint"], env);
  assert.equal(env.HYPERFRAMES_NO_TELEMETRY, "1");
  assert.equal(env.HYPERFRAMES_NO_UPDATE_CHECK, "1");
  assert.equal(env.HYPERFRAMES_NO_AUTO_INSTALL, "1");
});

test("local media callback inherits policy without HeyGen environment credentials", () => {
  const env = {
    ...strict(),
    HEYGEN_API_KEY: "test-key",
    HEYGEN_ACCESS_TOKEN: "test-token",
    HYPERFRAMES_API_KEY: "test-key",
    HEYGEN_CONFIG_DIR: "/test-only",
    PATH: "/test-bin",
  };
  const copy = localMediaEnvironment(env);
  assert.equal(copy[EXECUTION_POLICY_ENV], COMPANY_AGENTS_ONLY);
  assert.equal(copy.PATH, env.PATH);
  for (const key of [
    "HEYGEN_API_KEY",
    "HEYGEN_ACCESS_TOKEN",
    "HYPERFRAMES_API_KEY",
    "HEYGEN_CONFIG_DIR",
  ])
    assert.equal(copy[key], undefined);
  assert.equal(env.HEYGEN_API_KEY, "test-key");
});

for (const args of [
  { adopt: true },
  { candidates: true },
  { stats: true },
  { reuse: "sha" },
  { "dry-run": true },
  { from: "/tmp/supplied.png" },
  { from: "C:\\assets\\supplied.png" },
]) {
  test("allows supplied local media operation " + JSON.stringify(args), () => {
    assertLocalMediaOperationAllowed(args, strict());
  });
}
for (const args of [
  {},
  { doctor: true },
  { candidates: true, doctor: true },
  { from: "a.png", provider: "heygen" },
  { from: "https://example.com/a.png" },
  { from: "//host/file" },
  { from: "\\\\host\\share\\file.png" },
  { analyze: true },
  { params: "{}" },
]) {
  test("denies unsafe direct media operation " + JSON.stringify(args), () => {
    policyError(() => assertLocalMediaOperationAllowed(args, strict()));
  });
}

test("unknown providers, local models, and paid/network markers are denied before any call", async () => {
  process.env[EXECUTION_POLICY_ENV] = COMPANY_AGENTS_ONLY;
  let calls = 0;
  for (const name of [
    "mflux.local",
    "kokoro.local",
    "ltx.local",
    "codex.image_gen",
    "heygen.tts",
    "unknown",
  ]) {
    await assert.rejects(
      () =>
        runProviders(
          [
            {
              name,
              generate: async () => {
                calls++;
              },
            },
          ],
          "generate",
          "test",
          { provider: name, localOnly: true },
        ),
      { code: "policy_denied" },
    );
  }
  assert.equal(calls, 0);
  policyError(() => assertProviderAllowed({ name: "bundled.sfx", network: true }, strict()));
  policyError(() => assertProviderAllowed({ name: "design_spec", paid: true }, strict()));
});

test("safe local fallback skips denied providers without invoking them", async () => {
  process.env[EXECUTION_POLICY_ENV] = COMPANY_AGENTS_ONLY;
  const calls = [];
  const result = await runProviders(
    [
      {
        name: "heygen.audio.sounds",
        network: true,
        search: async () => {
          calls.push("remote");
        },
      },
      {
        name: "bundled.sfx",
        search: async () => {
          calls.push("local");
          return "supplied-result";
        },
      },
    ],
    "search",
    "test",
    {},
  );
  assert.equal(result, "supplied-result");
  assert.deepEqual(calls, ["local"]);
});

test("invalid policy rejects an empty provider ladder rather than becoming a silent miss", async () => {
  process.env[EXECUTION_POLICY_ENV] = "typo";
  await assert.rejects(() => runProviders([], "search", "test", {}), { code: "policy_invalid" });
});

test("registry getters cannot bypass policy by invoking exposed functions directly", async () => {
  process.env[EXECUTION_POLICY_ENV] = COMPANY_AGENTS_ONLY;
  await assert.rejects(async () => getProvider("image").search("test", {}), {
    code: "policy_denied",
  });
  for (const provider of getProviders("voice"))
    await assert.rejects(async () => provider.generate("test", {}), { code: "policy_denied" });
});

test("changing exposed provider metadata does not change its guarded identity", async () => {
  process.env[EXECUTION_POLICY_ENV] = COMPANY_AGENTS_ONLY;
  const provider = getProviders("voice")[0];
  const original = { name: provider.name, network: provider.network, paid: provider.paid };
  try {
    provider.name = "bundled.sfx";
    provider.network = false;
    provider.paid = false;
    await assert.rejects(async () => provider.generate("test", {}), { code: "policy_denied" });
  } finally {
    Object.assign(provider, original);
  }
});

test("CLI preflight precedes project environment loading and telemetry startup", () => {
  const source = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");
  const guard = source.indexOf("assertCompanyCommandAllowed(argv)");
  assert.ok(guard > 0 && guard < source.indexOf('await import("./utils/dotEnv.js")'));
  assert.ok(guard < source.indexOf('import("./telemetry/index.js")'));
  assert.ok(guard < source.indexOf('import("./utils/backgroundChecks.js")'));
});

test("failure envelope is structured and does not echo an invalid environment value", () => {
  const error = integratedExecutionDenial("model", {
    [EXECUTION_POLICY_ENV]: "sensitive-test-value",
  });
  const payload = policyFailure(error);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "policy_invalid");
  assert.equal(JSON.stringify(payload).includes("sensitive-test-value"), false);
});
