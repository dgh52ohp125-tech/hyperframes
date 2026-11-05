import { afterEach, beforeEach, expect, it, vi } from "vitest";
import audio from "./commands/audio.js";

const work = vi.hoisted(() => ({
  analyzeTargets: vi.fn(),
  previewTarget: vi.fn(),
  filmTargets: vi.fn(),
  readAudio: vi.fn(),
  describeProject: vi.fn(),
  ensureDOMParser: vi.fn(),
  resolveProject: vi.fn(),
  formatReport: vi.fn(),
  formatRead: vi.fn(),
  withMeta: vi.fn(),
}));
vi.mock("./utils/defineCommand.js", () => ({ defineCommand: (definition: unknown) => definition }));
vi.mock("./audio/analysis/analyze.js", () => ({ DEFAULT_CAPABILITIES: ["onsets"] }));
vi.mock("./audio/analysis/format.js", () => ({ formatReport: work.formatReport }));
vi.mock("./audio/analysis/run.js", () => ({
  analyzeTargets: work.analyzeTargets,
  previewTarget: work.previewTarget,
}));
vi.mock("./audio/analysis/targets.js", () => ({ filmTargets: work.filmTargets }));
vi.mock("./audio/read/format.js", () => ({ formatRead: work.formatRead }));
vi.mock("./audio/read/read.js", () => ({ readAudio: work.readAudio }));
vi.mock("./timeline/describeProject.js", () => ({ describeProject: work.describeProject }));
vi.mock("./utils/dom.js", () => ({ ensureDOMParser: work.ensureDOMParser }));
vi.mock("./utils/project.js", () => ({ resolveProject: work.resolveProject }));
vi.mock("./utils/reject-unknown-flags.js", () => ({ assertKnownFlags: vi.fn() }));
vi.mock("./utils/updateCheck.js", () => ({ withMeta: work.withMeta }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(flags: Record<string, unknown>) {
  if (!audio.run) throw new Error("Audio command has no run handler");
  return Reflect.apply(audio.run, undefined, [{ args: { _: ["real.wav"], ...flags } }]);
}

for (const flags of [
  {},
  { quality: "local" },
  { quality: "best" },
  { quality: false },
  { quality: "fast", provider: "onsets=signal" },
  { quality: "fast", read: true },
  // citty parses quality after `--` into positionals, not args.quality.
  { _: ["real.wav", "--quality", "fast"], only: "beats" },
]) {
  it(
    "refuses parsed unsafe audio before any asset/provider work: " + JSON.stringify(flags),
    async () => {
      vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "company-agents-only");
      await expect(run(flags)).rejects.toMatchObject({
        code: "policy_denied",
        result: { exitCode: 2 },
      });
      for (const [name, mock] of Object.entries(work)) expect(mock, name).not.toHaveBeenCalled();
    },
  );
}

it("rejects invalid audio policy before any asset/provider work", async () => {
  vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "typo");
  await expect(run({ quality: "fast" })).rejects.toMatchObject({
    code: "policy_invalid",
    result: { exitCode: 2 },
  });
  for (const [name, mock] of Object.entries(work)) expect(mock, name).not.toHaveBeenCalled();
});

it("leaves standard audio validation unchanged", async () => {
  vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "standard");
  await expect(run({ quality: "local", transcript: "words.json" })).rejects.toThrow(
    "--transcript only works with --read",
  );
});

it("keeps strict signal-only analysis available", async () => {
  vi.stubEnv("HYPERFRAMES_EXECUTION_POLICY", "company-agents-only");
  vi.spyOn(console, "log").mockImplementation(() => {});
  work.previewTarget.mockResolvedValue({ fixture: "target" });
  work.analyzeTargets.mockResolvedValue({ fixture: "signal-report" });
  await run({ quality: "fast" });
  expect(work.previewTarget).toHaveBeenCalledTimes(1);
  expect(work.analyzeTargets).toHaveBeenCalledWith(
    [{ fixture: "target" }],
    expect.objectContaining({ quality: "fast", provider: undefined }),
    false,
    expect.any(String),
  );
  expect(work.readAudio).not.toHaveBeenCalled();
});
