// Fork modification (2026-11-05): policy boundaries must refuse work before side effects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { RemoveBackgroundError, removeBackground } from "./api/removeBackground.js";
import { TranscribeError, runTranscribe } from "./api/transcribe.js";
import { withMediaAuthEnvironment } from "./auth/media-environment.js";
import { ExecutionPolicyError } from "./media-use/lib/execution-policy.mjs";

// Mock the entry to every credential/model path, rather than invoking an installed provider.
// No actual OAuth, model lookup, model install, subprocess or network is needed.
const work = vi.hoisted(() => ({
  apiBaseUrl: vi.fn(() => "https://api.heygen.com"),
  tryResolveCredential: vi.fn(),
  resolveCredential: vi.fn(),
  afterRefreshFailure: vi.fn(),
  refreshTokens: vi.fn(),
  writeStore: vi.fn(),
  mkdtemp: vi.fn(),
  chmod: vi.fn(),
  rm: vi.fn(),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(),
  realpathSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  findWhisper: vi.fn(),
  isWhisperUnavailable: vi.fn(),
  initialModelForLanguage: vi.fn(),
  parakeetRunner: vi.fn(),
  parakeetSpeaks: vi.fn(),
  sherpaUnsupportedReason: vi.fn(),
  prepareSherpaWav: vi.fn(),
  transcribeWithSherpa: vi.fn(),
  transcribeWithParakeet: vi.fn(),
  transcribeWithWhisper: vi.fn(),
  transcribeWithHeygen: vi.fn(),
  loadTranscript: vi.fn(),
  patchCaptionHtml: vi.fn(),
  formatSrt: vi.fn(),
  formatVtt: vi.fn(),
  createRenderCancellationScope: vi.fn(),
  stoppedByCancelSignal: vi.fn(),
  isDevice: vi.fn(() => true),
  isQuality: vi.fn(() => true),
  render: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    promises: {
      ...original.promises,
      mkdtemp: work.mkdtemp,
      chmod: work.chmod,
      rm: work.rm,
    },
    existsSync: work.existsSync,
    statSync: work.statSync,
    realpathSync: work.realpathSync,
    writeFileSync: work.writeFileSync,
    rmSync: work.rmSync,
  };
});
vi.mock("./auth/client.js", () => ({ apiBaseUrl: work.apiBaseUrl }));
vi.mock("./auth/resolver.js", () => ({
  tryResolveCredential: work.tryResolveCredential,
  resolveCredential: work.resolveCredential,
  afterRefreshFailure: work.afterRefreshFailure,
}));
vi.mock("./auth/oauth.js", () => ({ refreshTokens: work.refreshTokens }));
vi.mock("./auth/store.js", () => ({ writeStore: work.writeStore }));
vi.mock("./heygen/transcribe.js", () => ({ transcribeWithHeygen: work.transcribeWithHeygen }));
vi.mock("./utils/errorMessage.js", () => ({
  normalizeErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));
vi.mock("./utils/renderCancellation.js", () => ({
  createRenderCancellationScope: work.createRenderCancellationScope,
  stoppedByCancelSignal: work.stoppedByCancelSignal,
}));
vi.mock("./whisper/manager.js", () => ({
  DEFAULT_MODEL: "small.en",
  findWhisper: work.findWhisper,
  isWhisperUnavailable: work.isWhisperUnavailable,
}));
vi.mock("./whisper/modelForLanguage.js", () => ({
  initialModelForLanguage: work.initialModelForLanguage,
}));
vi.mock("./whisper/normalize.js", () => ({
  loadTranscript: work.loadTranscript,
  patchCaptionHtml: work.patchCaptionHtml,
  formatSrt: work.formatSrt,
  formatVtt: work.formatVtt,
}));
vi.mock("./whisper/parakeet.js", () => ({
  PARAKEET_INSTALL_COMMAND: "unused-in-policy-tests",
  PARAKEET_LANGUAGES: "en",
  parakeetSpeaks: work.parakeetSpeaks,
  transcribeWithParakeet: work.transcribeWithParakeet,
}));
vi.mock("./whisper/parakeetRunner.js", () => ({ parakeetRunner: work.parakeetRunner }));
vi.mock("./whisper/sherpa.js", () => ({
  DecodeCancelled: class extends Error {},
  sherpaUnsupportedReason: work.sherpaUnsupportedReason,
  prepareSherpaWav: work.prepareSherpaWav,
  transcribeWithSherpa: work.transcribeWithSherpa,
}));
vi.mock("./whisper/transcriptFile.js", () => ({ TRANSCRIPT_FILE: "transcript.json" }));
vi.mock("./whisper/transcribe.js", () => ({ transcribe: work.transcribeWithWhisper }));
vi.mock("./background-removal/manager.js", () => ({
  DEVICES: ["auto", "cpu"],
  isDevice: work.isDevice,
}));
vi.mock("./background-removal/pipeline.js", () => ({
  QUALITIES: ["balanced"],
  isQuality: work.isQuality,
  render: work.render,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectNoWork(): void {
  for (const [name, mock] of Object.entries(work)) {
    expect(mock, `${name} must not run before the execution-policy guard`).not.toHaveBeenCalled();
  }
}

const blockedPolicies = [
  { policy: "company-agents-only", code: "policy_denied" },
  { policy: "company-agent-only", code: "policy_invalid" },
];

describe("media auth execution-policy boundary", () => {
  it("rejects an invalid policy before resolving credentials or invoking the callback", async () => {
    vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "company-agent-only");
    const run = vi.fn();

    const result = withMediaAuthEnvironment(run);

    await expect(result).rejects.toBeInstanceOf(ExecutionPolicyError);
    await expect(result).rejects.toMatchObject({ code: "policy_invalid" });
    expect(run).not.toHaveBeenCalled();
    expectNoWork();
  });

  it("runs a local callback with inherited strict policy and no HeyGen credentials", async () => {
    const inherited = {
      HYPERFRAMES_EXECUTION_POLICY: "company-agents-only",
      HEYGEN_API_KEY: "fixture-api-key",
      HYPERFRAMES_API_KEY: "fixture-alias-key",
      HEYGEN_ACCESS_TOKEN: "fixture-access-token",
      HEYGEN_CONFIG_DIR: "fixture-credential-directory",
      HYPERFRAMES_NO_TELEMETRY: "0",
      DO_NOT_TRACK: "0",
      HYPERFRAMES_NO_UPDATE_CHECK: "0",
      HYPERFRAMES_NO_AUTO_INSTALL: "0",
      PATH: "fixture-local-tool-path",
    };
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    const result = { local: true };
    const run = vi.fn(async (env: NodeJS.ProcessEnv) => {
      expect(env).not.toBe(process.env);
      expect(env).toMatchObject({
        HYPERFRAMES_EXECUTION_POLICY: "company-agents-only",
        HYPERFRAMES_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        HYPERFRAMES_NO_UPDATE_CHECK: "1",
        HYPERFRAMES_NO_AUTO_INSTALL: "1",
        PATH: inherited.PATH,
      });
      for (const key of [
        "HEYGEN_API_KEY",
        "HYPERFRAMES_API_KEY",
        "HEYGEN_ACCESS_TOKEN",
        "HEYGEN_CONFIG_DIR",
      ]) {
        expect(env).not.toHaveProperty(key);
      }
      env.PATH = "changed-only-in-callback";
      return result;
    });

    await expect(withMediaAuthEnvironment(run)).resolves.toBe(result);

    expect(run).toHaveBeenCalledTimes(1);
    expect(process.env).toMatchObject(inherited);
    expectNoWork();
  });

  it("propagates local callback failures without falling back to authentication", async () => {
    vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "company-agents-only");
    const failure = new Error("local operation failed");
    const run = vi.fn(async () => {
      throw failure;
    });

    await expect(withMediaAuthEnvironment(run)).rejects.toBe(failure);

    expect(run).toHaveBeenCalledTimes(1);
    expectNoWork();
  });

  it("retains credential refresh and temporary credential writes in standard mode", async () => {
    vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "standard");
    vi.stubEnv("HEYGEN_API_BASE", "https://api.heygen.com");
    const refreshed = {
      type: "oauth",
      access_token: "fixture-refreshed-token",
      refresh_token: "fixture-refresh-token",
      refreshable: false,
    };
    work.tryResolveCredential.mockResolvedValueOnce({ ...refreshed, refreshable: true });
    work.refreshTokens.mockResolvedValueOnce(undefined);
    work.resolveCredential.mockResolvedValueOnce(refreshed);
    work.mkdtemp.mockResolvedValueOnce("fixture-temporary-auth-directory");
    const run = vi.fn((env: NodeJS.ProcessEnv) => env.HEYGEN_ACCESS_TOKEN);

    await expect(withMediaAuthEnvironment(run)).resolves.toBe(refreshed.access_token);

    expect(work.tryResolveCredential).toHaveBeenCalledTimes(1);
    expect(work.refreshTokens).toHaveBeenCalledWith(refreshed.refresh_token);
    expect(work.resolveCredential).toHaveBeenCalledTimes(1);
    expect(work.writeStore).toHaveBeenCalledWith(
      {
        oauth: {
          access_token: refreshed.access_token,
          expires_at: undefined,
          token_type: "Bearer",
        },
      },
      join("fixture-temporary-auth-directory", "credentials"),
    );
    expect(work.rm).toHaveBeenCalledWith("fixture-temporary-auth-directory", {
      recursive: true,
      force: true,
    });
  });
});

describe.each(blockedPolicies)("direct API boundary under $policy", ({ policy, code }) => {
  beforeEach(() => vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", policy));

  it.each([undefined, "auto", "heygen", "whisper", "parakeet"])(
    "blocks transcription engine %s before file access, model discovery or execution",
    async (engine) => {
      const onProgress = vi.fn();
      const onStatus = vi.fn();
      const onEngine = vi.fn();
      const result = runTranscribe({
        input: "fixture-narration.wav",
        engine,
        language: "es",
        installRuntime: true,
        onProgress,
        onStatus,
        onEngine,
      });

      await expect(result).rejects.toBeInstanceOf(TranscribeError);
      await expect(result).rejects.toMatchObject({ code });
      expect(onProgress).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();
      expect(onEngine).not.toHaveBeenCalled();
      expectNoWork();
    },
  );

  it("checks the policy before cancellation or input validation", async () => {
    const result = runTranscribe({ input: "", signal: AbortSignal.abort() });

    await expect(result).rejects.toBeInstanceOf(TranscribeError);
    await expect(result).rejects.toMatchObject({ code });
    expectNoWork();
  });

  it("blocks transcript conversion before reading or writing files", async () => {
    const result = runTranscribe({ input: "fixture-transcript.json", captions: { format: "srt" } });

    await expect(result).rejects.toBeInstanceOf(TranscribeError);
    await expect(result).rejects.toMatchObject({ code });
    expectNoWork();
  });

  it("blocks background removal before option checks or the model pipeline", async () => {
    const onProgress = vi.fn();
    const result = removeBackground({
      input: "fixture-input.mp4",
      output: "fixture-output.webm",
      device: "cpu",
      quality: "balanced",
      onProgress,
    });

    await expect(result).rejects.toBeInstanceOf(RemoveBackgroundError);
    await expect(result).rejects.toMatchObject({ code });
    expect(onProgress).not.toHaveBeenCalled();
    expectNoWork();
  });
});

describe.each([undefined, "standard"])("direct API opt-in behavior with policy %s", (policy) => {
  beforeEach(() => vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", policy));

  it("keeps normal transcription input validation", async () => {
    work.existsSync.mockReturnValueOnce(false);
    const result = runTranscribe({ input: "fixture-missing.wav" });

    await expect(result).rejects.toBeInstanceOf(TranscribeError);
    await expect(result).rejects.toMatchObject({ code: "input_not_found" });
    expect(work.existsSync).toHaveBeenCalledTimes(1);
    expect(work.transcribeWithHeygen).not.toHaveBeenCalled();
    expect(work.transcribeWithWhisper).not.toHaveBeenCalled();
  });

  it("reaches the mocked background-removal pipeline", async () => {
    const failure = new Error("fixture pipeline failure");
    work.render.mockRejectedValueOnce(failure);
    const result = removeBackground({ input: "fixture-input.mp4", output: "fixture-output.webm" });

    await expect(result).rejects.toBeInstanceOf(RemoveBackgroundError);
    await expect(result).rejects.toMatchObject({ code: "failed", cause: failure });
    expect(work.render).toHaveBeenCalledTimes(1);
  });
});
