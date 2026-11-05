// Fork modification (2026-11-05): Exercise receipts with local byte fixtures, not engine renders.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRenderOutput } from "../helpers/renderOutputs.js";
import {
  beginArtifactCapture,
  recordRenderSuccess,
  verifyLatestRender,
  type VideoState,
} from "./videoState.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hf-render-receipt-"));
  roots.push(dir);
  const source = join(dir, "index.html");
  const output = join(dir, "movie.mp4");
  writeFileSync(source, "original source");
  await registerRenderOutput(dir, output);
  const capture = await beginArtifactCapture(dir);
  writeFileSync(output, "fixture bytes, not a rendered video");
  return { dir, source, output, capture };
}
function rewriteRecord(dir: string, change: (state: VideoState) => void) {
  const path = join(dir, ".hyperframes/video-state.json");
  const state: VideoState = JSON.parse(readFileSync(path, "utf8"));
  change(state);
  writeFileSync(path, JSON.stringify(state));
}

describe("local render byte receipts", () => {
  it("verifies unchanged bytes and local inputs without modifying state", async () => {
    const f = await fixture();
    const record = await recordRenderSuccess(f.dir, f.output, "completed_with_warnings", f.capture);
    expect(record.contentHash).toBe(
      createHash("sha256").update(readFileSync(f.output)).digest("hex"),
    );
    expect(record.byteCount).toBe(readFileSync(f.output).length);
    expect(record.attribution).toBe("unversioned");
    expect(record.status).toBe("completed_with_warnings");
    const path = join(f.dir, ".hyperframes/video-state.json");
    const before = readFileSync(path, "utf8");
    expect(await verifyLatestRender(f.dir)).toEqual({
      status: "verified",
      outputMatches: true,
      inputsMatch: true,
      renderId: record.id,
      output: f.output,
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("detects replacement bytes at the registered output path independently of inputs", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    writeFileSync(f.output, "fixture bytes, NOT a rendered video");
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "changed",
      outputMatches: false,
      inputsMatch: true,
    });
  });
  it("reports missing output and no recorded render", async () => {
    const f = await fixture();
    expect(await verifyLatestRender(f.dir)).toEqual({
      status: "not-recorded",
      outputMatches: null,
      inputsMatch: null,
    });
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    rmSync(f.output);
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "missing",
      outputMatches: false,
      inputsMatch: true,
    });
  });
  it("cannot verify legacy records or records with no capture", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output);
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "unverifiable",
      outputMatches: true,
      inputsMatch: null,
    });
    rewriteRecord(f.dir, (state) => {
      if (!state.renders?.latest) throw new Error("Missing fixture record");
      delete state.renders.latest.contentHash;
      delete state.renders.latest.byteCount;
      delete state.renders.latest.outputKind;
    });
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "unverifiable",
      outputMatches: null,
      inputsMatch: null,
    });
  });
  it("retains directory/image-sequence outputs without claiming a byte receipt", async () => {
    const f = await fixture();
    rmSync(f.output);
    mkdirSync(f.output);
    writeFileSync(join(f.output, "001.png"), "fixture frame");
    const record = await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    expect(record.outputKind).toBe("directory");
    expect(record.contentHash).toBeUndefined();
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "unsupported",
      outputMatches: null,
      inputsMatch: true,
    });
  });
  it("detects input changes between recording and verification", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    writeFileSync(f.source, "new source");
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "changed",
      outputMatches: true,
      inputsMatch: false,
    });
  });
  it("never verifies a render captured while inputs changed, even after source is restored", async () => {
    const f = await fixture();
    writeFileSync(f.source, "changed during render");
    const record = await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    expect(record.attribution).toBe("inputs-changed");
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "changed",
      inputsMatch: false,
    });
    writeFileSync(f.source, "original source");
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "unverifiable",
      outputMatches: true,
      inputsMatch: true,
    });
  });
  it("detects inputs changed during verification", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    const { stat: originalStat } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let outputStats = 0;
    vi.spyOn(fsPromises, "stat").mockImplementation((...args) => {
      if (args[0] !== f.output || ++outputStats !== 2) return originalStat(...args);
      writeFileSync(f.source, "changed during verification");
      return originalStat(...args);
    });
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "changed",
      outputMatches: true,
      inputsMatch: false,
    });
  });
  it("detects replacement of the opened output during hashing", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    const { stat: originalStat } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let outputStats = 0;
    vi.spyOn(fsPromises, "stat").mockImplementation((...args) => {
      if (args[0] !== f.output || ++outputStats !== 2) return originalStat(...args);
      const replacement = join(f.dir, "replacement");
      writeFileSync(replacement, readFileSync(f.output));
      renameSync(replacement, f.output);
      return originalStat(...args);
    });
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "changed",
      outputMatches: false,
      inputsMatch: true,
    });
  });
  it("rejects a byte receipt when output replacement occurs while recording", async () => {
    const f = await fixture();
    const { stat: originalStat } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let outputStats = 0;
    vi.spyOn(fsPromises, "stat").mockImplementation((...args) => {
      if (args[0] !== f.output || ++outputStats !== 2) return originalStat(...args);
      const replacement = join(f.dir, "replacement");
      writeFileSync(replacement, readFileSync(f.output));
      renameSync(replacement, f.output);
      return originalStat(...args);
    });
    await expect(recordRenderSuccess(f.dir, f.output, "completed", f.capture)).rejects.toThrow(
      "changed while recording",
    );
    expect(await verifyLatestRender(f.dir)).toMatchObject({ status: "not-recorded" });
  });
  it("fails closed on unreadable inputs instead of verifying a partial scan", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    const originalLstat = fsPromises.lstat;
    vi.spyOn(fsPromises, "lstat").mockImplementation((...args) => {
      if (args[0] === f.source)
        return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      return originalLstat(...args);
    });
    await expect(verifyLatestRender(f.dir)).rejects.toThrow("permission denied");
  });
  it("fails closed on an invalid output registry", async () => {
    const f = await fixture();
    await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
    writeFileSync(
      join(f.dir, ".hyperframes/render-outputs.json"),
      '{"version":1,"paths":["../outside"]}',
    );
    await expect(verifyLatestRender(f.dir)).rejects.toThrow("Invalid render output registry");
  });
  it("does not open directory descriptors when recording or verifying a sequence", async () => {
    const f = await fixture();
    rmSync(f.output);
    mkdirSync(f.output);
    const originalOpen = fsPromises.open;
    vi.spyOn(fsPromises, "open").mockImplementation((...args) => {
      if (args[0] === f.output) throw new Error("Directory descriptors unavailable");
      return originalOpen(...args);
    });
    expect((await recordRenderSuccess(f.dir, f.output, "completed", f.capture)).outputKind).toBe(
      "directory",
    );
    expect(await verifyLatestRender(f.dir)).toMatchObject({
      status: "unsupported",
      outputMatches: null,
    });
  });
  it.each(["replacement", "removal"])(
    "detects output %s during the final input scan",
    async (operation) => {
      const f = await fixture();
      await recordRenderSuccess(f.dir, f.output, "completed", f.capture);
      const originalLstat = fsPromises.lstat;
      let inputScans = 0;
      vi.spyOn(fsPromises, "lstat").mockImplementation((...args) => {
        if (args[0] === f.source && ++inputScans === 2) {
          if (operation === "removal") rmSync(f.output);
          else {
            const replacement = join(f.dir, "replacement");
            writeFileSync(replacement, readFileSync(f.output));
            renameSync(replacement, f.output);
          }
        }
        return originalLstat(...args);
      });
      expect(await verifyLatestRender(f.dir)).toMatchObject({
        status: operation === "removal" ? "missing" : "changed",
        outputMatches: false,
        inputsMatch: true,
      });
    },
  );
});
