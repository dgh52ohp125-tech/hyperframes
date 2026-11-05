#!/usr/bin/env node
// Fork modification (2026-11-05): restricted/invalid policies never use the warm worker.

import module from "node:module";
import { runtimeVersionError } from "../dist/runtimeVersion.js";

const error = runtimeVersionError(process.versions.node);
if (error) {
  console.error(error);
  process.exitCode = 1;
} else {
  // Reuses V8 bytecode across runs (os.tmpdir()/node-compile-cache); Node 22.0 has no such API.
  module.enableCompileCache?.();
  if (process.env.HYPERFRAMES_HANG_REPORT) (await import("../dist/hangReport.js")).watchForHang();
  // The worker can prelaunch a browser before cli.js validates policy. Do not import it
  // or register its exit hook until the unrestricted policy is explicit or defaulted.
  const policy = process.env.HYPERFRAMES_EXECUTION_POLICY;
  const allowWarmCheck = policy === undefined || policy === "" || policy === "standard";
  const warm =
    allowWarmCheck && process.argv[2] === "check"
      ? await import("../dist/warmCheckClient.js")
      : undefined;
  if (warm?.warmCheckEligible()) process.once("exit", () => warm.startNextWarmCheck());
  if (!(warm?.warmCheckEligible() && (await warm.runWarmCheck()))) await import("../dist/cli.js");
}
