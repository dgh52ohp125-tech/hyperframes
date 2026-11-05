import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const entryPoints = [
  "skills/media-use/audio/scripts/audio.mjs",
  "skills/media-use/audio/scripts/heygen-tts.mjs",
  "skills/media-use/audio/scripts/heygen-voice.mjs",
  "skills/media-use/scripts/transcribe.mjs",
  "skills/media-use/scripts/eval.mjs",
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hf-company-policy-"));
  const marker = join(dir, "unexpected-side-effects");
  const preload = join(dir, "guard.mjs");
  writeFileSync(
    preload,
    `
import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const forbidden = (kind) => () => {
  appendFileSync(process.env.POLICY_TEST_MARKER, kind + "\\n");
  throw new Error("Unexpected external work before policy guard: " + kind);
};
globalThis.fetch = forbidden("fetch");
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  cp[method] = forbidden(method);
syncBuiltinESMExports();
`,
  );
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    HYPERFRAMES_MEDIA_HOME: join(dir, ".media"),
    HYPERFRAMES_EXECUTION_POLICY: "company-agents-only",
    POLICY_TEST_MARKER: marker,
    HEYGEN_API_KEY: "test-only-not-a-credential",
    GEMINI_API_KEY: "test-only-not-a-credential",
  };
  return { dir, marker, preload, env };
}

function expectBlocked(script, args, policy = "company-agents-only") {
  const f = fixture();
  try {
    const run = spawnSync(
      process.execPath,
      ["--import", f.preload, join(root, script), ...args, "--json"],
      {
        cwd: f.dir,
        env: { ...f.env, HYPERFRAMES_EXECUTION_POLICY: policy },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null);
    assert.equal(run.status, 2, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, false);
    assert.equal(
      result.error.code,
      policy === "company-agents-only" ? "policy_denied" : "policy_invalid",
    );
    assert.equal(
      existsSync(f.marker),
      false,
      existsSync(f.marker) ? readFileSync(f.marker, "utf8") : "",
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

for (const script of entryPoints) {
  test("standalone policy blocks before model/auth work: " + script, () =>
    expectBlocked(script, []),
  );
  test("standalone invalid policy fails closed: " + script, () =>
    expectBlocked(script, [], "typo"),
  );
}

for (const args of [
  ["--doctor"],
  ["--type", "voice", "--intent", "test"],
  ["--from", "https://example.test/asset.png", "--type", "image"],
]) {
  test("direct resolver refuses unsafe route before external work: " + args.join(" "), () => {
    expectBlocked("packages/cli/src/media-use/resolve.mjs", args);
  });
}

test("local statistics remain available without auth, provider probes or network", () => {
  const f = fixture();
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        f.preload,
        join(root, "packages/cli/src/media-use/resolve.mjs"),
        "--stats",
        "--json",
      ],
      {
        cwd: f.dir,
        env: f.env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.signal, null);
    assert.doesNotThrow(() => JSON.parse(run.stdout));
    assert.equal(existsSync(f.marker), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("standalone Lyria denies before importing the optional Google client", (t) => {
  const f = fixture();
  try {
    const google = join(f.dir, "google");
    mkdirSync(google);
    writeFileSync(
      join(google, "__init__.py"),
      'import os\nopen(os.environ["POLICY_TEST_MARKER"], "w").write("google imported")\nraise RuntimeError("unexpected Google import")\n',
    );
    for (const policy of ["company-agents-only", "typo"]) {
      const run = spawnSync(
        process.env.PYTHON ?? "python3",
        [join(root, "skills/media-use/audio/scripts/lyria-recipe.py")],
        {
          cwd: f.dir,
          env: { ...f.env, PYTHONPATH: f.dir, HYPERFRAMES_EXECUTION_POLICY: policy },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      if (run.error?.code === "ENOENT" && !process.env.PYTHON) {
        t.skip("python3 is not installed; JavaScript policy tests still run");
        return;
      }
      assert.equal(run.error, undefined);
      assert.equal(run.status, 2, run.stderr);
      assert.equal(
        JSON.parse(run.stderr).error.code,
        policy === "typo" ? "policy_invalid" : "policy_denied",
      );
      assert.equal(existsSync(f.marker), false);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("standalone policy mirror matches its canonical source", () => {
  assert.equal(
    readFileSync(join(root, "skills/media-use/scripts/lib/execution-policy.mjs"), "utf8"),
    readFileSync(new URL("./execution-policy.mjs", import.meta.url), "utf8"),
  );
});

for (const policy of ["company-agents-only", "typo", "standard", ""]) {
  test("packaged wrapper handles warm work before CLI policy: " + JSON.stringify(policy), () => {
    const f = fixture();
    try {
      mkdirSync(join(f.dir, "bin"));
      mkdirSync(join(f.dir, "dist"));
      writeFileSync(join(f.dir, "package.json"), '{"type":"module"}');
      copyFileSync(
        join(root, "packages/cli/bin/hyperframes.mjs"),
        join(f.dir, "bin/hyperframes.mjs"),
      );
      copyFileSync(
        new URL("./execution-policy.mjs", import.meta.url),
        join(f.dir, "dist/policy.mjs"),
      );
      writeFileSync(
        join(f.dir, "dist/runtimeVersion.js"),
        "export const runtimeVersionError = () => undefined;",
      );
      writeFileSync(
        join(f.dir, "dist/warmCheckClient.js"),
        `
import { appendFileSync } from "node:fs";
const mark = (step) => appendFileSync(process.env.POLICY_TEST_MARKER, step + "\\n");
mark("import");
export const warmCheckEligible = () => true;
export const startNextWarmCheck = () => mark("start");
export const runWarmCheck = async () => { mark("run"); return false; };
`,
      );
      // Test the real package wrapper without a browser or full CLI dependency graph.
      writeFileSync(
        join(f.dir, "dist/cli.js"),
        `
import { assertCompanyCommandAllowed, policyFailure } from "./policy.mjs";
try { assertCompanyCommandAllowed(process.argv.slice(2)); }
catch (error) { console.log(JSON.stringify(policyFailure(error))); process.exit(2); }
`,
      );
      const run = spawnSync(
        process.execPath,
        ["--import", f.preload, join(f.dir, "bin/hyperframes.mjs"), "check", "--json"],
        {
          cwd: f.dir,
          env: { ...f.env, HYPERFRAMES_EXECUTION_POLICY: policy, HYPERFRAMES_HANG_REPORT: "" },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(run.error, undefined);
      assert.equal(run.status, policy === "typo" ? 2 : 0, run.stderr);
      if (policy === "typo") assert.equal(JSON.parse(run.stdout).error.code, "policy_invalid");
      if (policy === "standard" || policy === "")
        assert.equal(readFileSync(f.marker, "utf8"), "import\nrun\nstart\n");
      else
        assert.equal(
          existsSync(f.marker),
          false,
          "restricted or invalid policy must not even import the warm client",
        );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}
