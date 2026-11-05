// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import {
  beginArtifactCapture,
  recordRenderSuccess,
  registerRenderOutput,
} from "@hyperframes/studio-server/history";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import history from "./history.js";
import { consumeCommandResult } from "../utils/commandResult.js";
import { historyDeps } from "../utils/historyOwner.js";

vi.mock("../telemetry/events.js", () => ({ trackHistoryAction: vi.fn() }));
afterEach(() => {
  consumeCommandResult();
  vi.restoreAllMocks();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hf-receipt-cli-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "source version one");
  const output = join(dir, "output.mp4");
  // Byte fixtures exercise integrity, not a claim that an engine rendered video.
  const record = async (captureInputs = true) => {
    await registerRenderOutput(dir, output);
    const capture = captureInputs ? await beginArtifactCapture(dir) : undefined;
    writeFileSync(output, "first video bytes");
    await recordRenderSuccess(dir, output, "completed", capture);
  };
  const verify = async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const server = vi
      .spyOn(historyDeps, "findServer")
      .mockRejectedValue(new Error("No server lookup allowed"));
    try {
      await runCommand(history, { rawArgs: ["verify-render", "--dir", dir, "--json"] });
      expect(server).not.toHaveBeenCalled();
      return { code: consumeCommandResult().exitCode, result: JSON.parse(log.mock.calls[0]![0]) };
    } finally {
      server.mockRestore();
      log.mockRestore();
    }
  };
  return { dir, output, record, verify };
}

it("reports a missing receipt without creating history or project metadata", async () => {
  const f = fixture();
  const before = readdirSync(f.dir);
  const { code, result } = await f.verify();
  expect(code).toBe(1);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "render_receipt_not-recorded" },
    verification: { status: "not-recorded" },
  });
  expect(readdirSync(f.dir)).toEqual(before);
});

it("verifies matching output and input bytes without rewriting the receipt", async () => {
  const f = fixture();
  await f.record();
  const state = join(f.dir, ".hyperframes", "video-state.json");
  const before = readFileSync(state, "utf8");
  const { code, result } = await f.verify();
  expect(code).toBe(0);
  expect(result).toMatchObject({
    ok: true,
    verification: { status: "verified", outputMatches: true, inputsMatch: true },
  });
  expect(readFileSync(state, "utf8")).toBe(before);
});

it("returns a failing structured result for replaced output bytes at the same path", async () => {
  const f = fixture();
  await f.record();
  writeFileSync(f.output, "other video bytes");
  const { code, result } = await f.verify();
  expect(code).toBe(1);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "render_receipt_changed" },
    verification: { status: "changed", outputMatches: false, inputsMatch: true },
  });
});

it("separates stale source from matching rendered bytes", async () => {
  const f = fixture();
  await f.record();
  writeFileSync(join(f.dir, "index.html"), "source version two");
  const { code, result } = await f.verify();
  expect(code).toBe(1);
  expect(result.verification).toMatchObject({
    status: "changed",
    outputMatches: true,
    inputsMatch: false,
  });
});

it("does not turn missing input-capture evidence into a pass", async () => {
  const f = fixture();
  await f.record(false);
  const { code, result } = await f.verify();
  expect(code).toBe(1);
  expect(result.verification).toMatchObject({ status: "unverifiable", inputsMatch: null });
});
