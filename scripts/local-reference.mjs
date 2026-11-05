// Fork modification (2026-11-05): estimate missing tails from decoded cadence and flag misleading average-fps metadata.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Independent evidence preparation. Do not import CLI auth, AI providers, or reverse sessions.
const FORMATS = "mov,matroska,webm,avi,ogg,mpegts";
const MAX_SECONDS = 60;
const MAX_FRAMES = 18_000;
const MAX_BYTES = 2 * 1024 ** 3;
const INPUT_OPTIONS = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  FORMATS,
  "-threads",
  "2",
];
const HELP = `Prepare reference evidence for your own agent using installed FFmpeg and ffprobe.

  node scripts/local-reference.mjs <local-video> --out <new-private-directory>
    [--mode style|recreate] [--samples 12] [--cuts 30,72] [--width 640]

Accepts self-contained MP4/MOV, MKV/WebM, AVI, Ogg, or MPEG-TS clips up to 60 s / 2 GiB.
Samples are decoded frame indexes, not rounded timestamps. --cuts supplies verified
first frames of new shots, not times; samples include each cut and both neighbors.
The output directory must not exist. No source copy, upload, model, login, browser,
package installation, or hosted Reverse request is performed. Outputs can contain
private media: keep them private. Your chosen agent has its own data/billing policy.
`;

export function parseRational(value, label = "rate") {
  if (typeof value !== "string" || !/^\d+(?:\/\d+)?$/.test(value)) {
    throw new Error(`Invalid ${label}: expected a positive rational value.`);
  }
  const [numerator, denominator = 1] = value.split("/").map(Number);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new Error(`Invalid ${label}: numerator and denominator must be positive integers.`);
  }
  return { text: value, numerator, denominator, value: numerator / denominator };
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function planSamples(frameCount, count, cuts = []) {
  integer(frameCount, "Frame count", 1, MAX_FRAMES);
  integer(count, "--samples", 2, 64);
  for (const cut of cuts) integer(cut, "Cut frame", 1, frameCount - 1);
  const uniqueCuts = [...new Set(cuts)].sort((a, b) => a - b);
  const selected = new Set([0, frameCount - 1]);
  for (const cut of uniqueCuts) {
    for (const frame of [cut - 1, cut, cut + 1]) {
      if (frame < frameCount) selected.add(frame);
    }
  }
  if (selected.size > count) {
    throw new Error(
      `Cut boundaries need ${selected.size} samples; increase --samples (maximum 64).`,
    );
  }
  // Fill the largest unsampled gaps. Never discard a required boundary to meet the budget.
  while (selected.size < Math.min(frameCount, count)) {
    const sorted = [...selected].sort((a, b) => a - b);
    let start = 0;
    let gap = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > gap) {
        start = sorted[i - 1];
        gap = sorted[i] - start;
      }
    }
    selected.add(start + Math.floor(gap / 2));
  }
  return [...selected].sort((a, b) => a - b);
}

function command(binary, args) {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Do not allow an inherited FFREPORT to create a log outside the output directory.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT"),
      ),
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${binary} is not installed on PATH. Install it separately before continuing.`,
      );
    }
    const detail = String(error?.stderr || error?.message || "Unknown error")
      .trim()
      .slice(-1200);
    throw new Error(`${binary} failed: ${detail}`);
  }
}

function hashFile(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function readClock(stream, frames) {
  const timeBase = parseRational(stream.time_base, "time base");
  const rate = parseRational(stream.avg_frame_rate, "average frame rate");
  integer(frames.length, "Decoded frame count", 1, MAX_FRAMES);
  let previous;
  const first = frames[0].best_effort_timestamp;
  if (!Number.isSafeInteger(first))
    throw new Error("The video has no exact first-frame timestamp.");
  const clock = frames.map((frame, index) => {
    const pts = frame.best_effort_timestamp;
    if (!Number.isSafeInteger(pts) || (previous !== undefined && pts <= previous)) {
      throw new Error(
        "Video frame timestamps are missing, duplicate, or out of order; normalize first.",
      );
    }
    previous = pts;
    const duration = frame.duration ?? frame.pkt_duration;
    return {
      frame: index,
      pts,
      time_seconds: ((pts - first) * timeBase.numerator) / timeBase.denominator,
      duration_ticks: Number.isSafeInteger(duration) && duration > 0 ? duration : null,
    };
  });
  const deltas = clock.slice(1).map((frame, index) => frame.pts - clock[index].pts);
  // One time-base tick of variation is ordinary quantization, e.g. 30 fps in WebM.
  const variableTiming = deltas.length > 1 && Math.max(...deltas) - Math.min(...deltas) > 1;
  const last = clock.at(-1);
  const durationTicks =
    last.duration_ticks === null ? null : last.pts - first + last.duration_ticks;
  // Container average_frame_rate can itself be computed from an incomplete
  // duration. In particular, a missing final packet duration can turn 96
  // evenly spaced 24 fps frames into 2304/95 fps metadata. Prefer the last
  // observed presentation interval for an explicitly estimated final frame.
  const estimatedTailSeconds = deltas.length
    ? (deltas.at(-1) * timeBase.numerator) / timeBase.denominator
    : 1 / rate.value;
  const duration =
    durationTicks === null
      ? last.time_seconds + estimatedTailSeconds
      : (durationTicks * timeBase.numerator) / timeBase.denominator;
  const observedSpanRate = deltas.length
    ? ((frames.length - 1) * timeBase.denominator) / ((last.pts - first) * timeBase.numerator)
    : null;
  const averageRateMismatch =
    !variableTiming &&
    observedSpanRate !== null &&
    // Allow a tick of endpoint quantization as well as small metadata rounding.
    Math.abs(rate.value / observedSpanRate - 1) > 0.005 + timeBase.value / last.time_seconds;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS + timeBase.value) {
    throw new Error(
      `The decoded picture exceeds ${MAX_SECONDS} seconds; prepare a shorter clip first.`,
    );
  }
  return {
    time_base: timeBase.text,
    average_frame_rate: rate.text,
    nominal_frame_rate: stream.r_frame_rate ?? null,
    source_start_pts: first,
    frame_count: frames.length,
    picture_duration_ticks: durationTicks,
    picture_duration_seconds: duration,
    picture_duration_is_estimate: last.duration_ticks === null,
    picture_duration_estimate_method:
      durationTicks !== null
        ? null
        : deltas.length
          ? "previous decoded presentation interval"
          : "average frame rate; only one decoded frame",
    average_rate_disagrees_with_timestamps: averageRateMismatch,
    variable_timing: variableTiming,
    frames: clock,
  };
}

function probe(source) {
  const metadata = JSON.parse(
    command("ffprobe", [
      "-v",
      "error",
      ...INPUT_OPTIONS,
      "-show_entries",
      "stream=index,codec_type,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,time_base,duration,color_transfer:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,format_name",
      "-of",
      "json",
      "-i",
      source,
    ]),
  );
  const stream = metadata.streams?.find(
    (item) => item.codec_type === "video" && !item.disposition?.attached_pic,
  );
  if (!stream) throw new Error("No video stream was found (cover artwork is not a video).");
  integer(stream.index, "Video stream index", 0, 1024);
  integer(stream.width, "Video width", 1, 16384);
  integer(stream.height, "Video height", 1, 16384);
  if (stream.width * stream.height > 33_554_432) {
    throw new Error(
      "Video exceeds the 32-megapixel decode budget; prepare a smaller working copy.",
    );
  }
  const duration = Number(stream.duration ?? metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS + 0.1) {
    throw new Error(
      `A known video duration of at most ${MAX_SECONDS} seconds is required; trim first.`,
    );
  }
  const result = JSON.parse(
    command("ffprobe", [
      "-v",
      "error",
      ...INPUT_OPTIONS,
      "-select_streams",
      String(stream.index),
      "-read_intervals",
      `%+${MAX_SECONDS + 1}`,
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp,pkt_duration,duration",
      "-of",
      "json",
      "-i",
      source,
    ]),
  );
  return {
    stream,
    format: metadata.format?.format_name ?? null,
    audio: metadata.streams.some((item) => item.codec_type === "audio"),
    clock: readClock(stream, result.frames ?? []),
  };
}

function shotPlan(manifest, cuts) {
  const edges = [0, ...cuts, manifest.clock.frame_count];
  return {
    schema_version: 1,
    mode: manifest.mode,
    boundary_semantics: "zero-based decoded frame indexes; start inclusive, end exclusive",
    review_status: "unreviewed",
    source_rights: { basis: "", attribution: "", permitted_reuse: "" },
    shots: edges.slice(1).map((end, index) => ({
      id: `S${String(index + 1).padStart(2, "0")}`,
      start_frame: edges[index],
      end_frame_exclusive: end,
      observed_action: "",
      editable_layers: [],
      reused_assets: [],
      typography: [],
      palette: [],
      motion: [],
      transition_in: "",
      transition_out: "",
      audio: [],
      approximations: [],
      evidence_frames: manifest.samples
        .filter((sample) => sample.frame >= edges[index] && sample.frame < end)
        .map((sample) => sample.frame),
    })),
  };
}

function contactSheet(manifest) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Local reference evidence</title>
<style>body{font:16px system-ui;background:#151719;color:#f4f5f6;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}figure{margin:0}img{display:block;width:100%;max-height:460px;object-fit:contain;background:#000}figcaption{padding:8px 0;font-variant-numeric:tabular-nums}p{max-width:80ch;color:#c8ced3}</style>
</head><body><h1>Local reference evidence</h1>
<p>${manifest.clock.frame_count} decoded frames. Frame indexes and source PTS are authoritative. Preview times are labels, not seek instructions. This sampled overview can miss brief events. Review every cut and transition in detail before authoring.</p>
<main>${manifest.samples.map((sample) => `<figure><a href="${sample.file}"><img src="${sample.file}" alt="Decoded frame ${sample.frame}"></a><figcaption>f${sample.frame} · ${sample.time_seconds.toFixed(6)} s · PTS ${sample.pts}</figcaption></figure>`).join("\n")}</main>
</body></html>\n`;
}

function agentBrief(mode) {
  return `# Own-agent reference brief

Goal: ${mode === "recreate" ? "recreate the authorized reference with editable layers" : "make a new story using the reference's visual grammar"}.

## Inspect before authoring

1. Read manifest.json and inspect the PNG pixels, not just this brief or filenames.
2. Verify rights with the user and fill shot-plan.json. Empty fields are unknown, not approval.
3. Inspect cut boundaries and brief transitions at full temporal resolution. Samples can miss events.
4. Use decoded frame indexes and the recorded time base. Do not infer times by rounding fps.
5. Fill each shot's observed action, layers, asset provenance, typography, palette, motion/easing,
   transitions, audio, and intentional approximations. Mark observations separately from design choices.

## Author with the user's existing agent

Use ordinary editable HTML/CSS/SVG/canvas and deterministic seekable animation. One agent owns
the global timeline; specialists can build assets and review shots against the shared clock.
Do not use the whole original frame as a flattened video and call that editable reconstruction.
Record reused crops or footage honestly. A flattened live-action or painted scene does not
provide its hidden geometry, separable characters, or a new performance.

This preparation script calls only local FFmpeg/ffprobe. It does not invoke any AI provider,
authenticate, upload media, install packages, or change paid-feature access. Your existing
agent may use its provider's network and billing. Do not invoke hosted Reference/Reverse,
media generation, or automatic provider fallback without separate user authorization.
Existing HyperFrames --local-only flags are not a global agents-only or network sandbox.

## Quality gates

- Run the installed HyperFrames lint and browser check; report a blocked browser gate honestly.
- Render locally using project-local assets and fonts; avoid render-time network dependencies.
- For recreate: inspect timing, crop, text, audio, and pixel differences, separating reused regions.
- For style: score pacing, hierarchy, typography, transitions, readability, and editability;
  a different story should not be judged by whole-frame pixel similarity.
- Demonstrate retargeting: change one title and one visual value without rebuilding flattened media.
- Re-render for determinism. Deliver source, provenance, render, and the remaining mismatches.

Keep this evidence pack private. It contains reference pixels and may contain identifying metadata.
The .gitignore is a guard against accidental staging, not an access-control mechanism.
`;
}

function localPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty local filesystem path.`);
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error(
      `${label} must be a local filesystem path, not a URL, protocol, or network share.`,
    );
  }
  return resolve(value);
}

function requireNewOutput(path) {
  // Unlike existsSync, lstat also detects a dangling symlink.
  try {
    lstatSync(path);
    throw new Error("Output already exists; choose a new private directory.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function prepareReference({
  source,
  out,
  mode = "style",
  samples = 12,
  cuts = [],
  width = 640,
}) {
  // Permit native Windows absolute paths, but never UNC shares or URI protocols.
  const input = localPath(source, "Source");
  const destination = localPath(out, "--out");
  if (!["style", "recreate"].includes(mode)) throw new Error("--mode must be style or recreate.");
  integer(samples, "--samples", 2, 64);
  integer(width, "--width", 64, 1280);
  const inputStat = statSync(input);
  if (!inputStat.isFile() || inputStat.size > MAX_BYTES) {
    throw new Error("The source must be a regular file no larger than 2 GiB.");
  }
  requireNewOutput(destination);
  if (!statSync(dirname(destination)).isDirectory()) throw new Error("Output parent must exist.");
  const digest = hashFile(input);
  const info = probe(input);
  const cutFrames = [...new Set(cuts)].sort((a, b) => a - b);
  const selected = planSamples(info.clock.frame_count, samples, cutFrames);
  const work = mkdtempSync(join(dirname(destination), ".local-reference-"));
  try {
    mkdirSync(join(work, "frames"));
    writeFileSync(
      join(work, ".gitignore"),
      "# Private reference pixels and reports. Do not commit.\n*\n",
    );
    const expression = selected.map((frame) => `eq(n\\,${frame})`).join("+");
    command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-filter_threads",
      "1",
      "-n",
      ...INPUT_OPTIONS,
      "-i",
      input,
      "-map",
      `0:${info.stream.index}`,
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `select='${expression}',scale=w='max(1,round(iw*sar*min(1,min(${width}/(iw*sar),${width}/ih))))':h='max(1,round(ih*min(1,min(${width}/(iw*sar),${width}/ih))))',setsar=1`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      String(selected.length),
      "-threads",
      "1",
      "-start_number",
      "0",
      join(work, "frames", "sample-%03d.png"),
    ]);
    const written = readdirSync(join(work, "frames")).sort();
    if (written.length !== selected.length)
      throw new Error("Frame extraction was incomplete; no evidence pack was published.");
    const picked = selected.map((frame, index) => {
      const file = `frames/f${String(frame).padStart(6, "0")}.png`;
      renameSync(join(work, "frames", written[index]), join(work, file));
      return { ...info.clock.frames[frame], file };
    });
    if (hashFile(input) !== digest)
      throw new Error("The source changed during analysis; retry from a stable file.");
    const hdr = ["smpte2084", "arib-std-b67"].includes(info.stream.color_transfer);
    const manifest = {
      schema_version: 1,
      tool: "hyperframes-local-reference",
      mode,
      source: { filename: basename(input), sha256: digest, bytes: inputStat.size },
      media: {
        format: info.format,
        video_stream_index: info.stream.index,
        encoded_width: info.stream.width,
        encoded_height: info.stream.height,
        sample_aspect_ratio: info.stream.sample_aspect_ratio ?? null,
        rotation_degrees:
          info.stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0,
        audio_present: info.audio,
        hdr,
      },
      clock: info.clock,
      cuts: {
        origin: "user-supplied frame indexes; not automatically verified",
        frames: cutFrames,
      },
      samples: picked,
      warnings: [
        "A sampled overview is not complete motion analysis and can miss one-frame events.",
        "Shot-plan fields are intentionally unreviewed until your agent inspects the pixels.",
        ...(info.clock.average_rate_disagrees_with_timestamps
          ? [
              "Average frame-rate metadata disagrees with decoded timestamps. Use the recorded PTS instead of assuming frame / average_fps is the clock.",
            ]
          : []),
        ...(info.clock.variable_timing
          ? [
              "Variable timing detected: use recorded PTS, or normalize an authorized working copy before matching a constant-fps composition.",
            ]
          : []),
        ...(hdr
          ? [
              "HDR source: previews are not a color-managed fidelity reference. Prepare an SDR working copy or use an HDR review workflow.",
            ]
          : []),
      ],
    };
    writeFileSync(join(work, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(
      join(work, "shot-plan.json"),
      JSON.stringify(shotPlan(manifest, cutFrames), null, 2) + "\n",
    );
    writeFileSync(join(work, "contact-sheet.html"), contactSheet(manifest));
    writeFileSync(join(work, "AGENT_BRIEF.md"), agentBrief(mode));
    // Check again before publication. The caller must not concurrently create this directory.
    requireNewOutput(destination);
    renameSync(work, destination);
    return {
      output: destination,
      frames: picked.length,
      source_sha256: digest,
      warnings: manifest.warnings,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        out: { type: "string" },
        mode: { type: "string", default: "style" },
        samples: { type: "string", default: "12" },
        cuts: { type: "string" },
        width: { type: "string", default: "640" },
      },
    });
    if (values.help) {
      console.log(HELP);
      return;
    }
    if (positionals.length !== 1)
      throw new Error("Supply exactly one source video. Use --help for usage.");
    const cuts =
      values.cuts === undefined
        ? []
        : values.cuts.split(",").map((value) => {
            if (!/^\d+$/.test(value))
              throw new Error("--cuts must be comma-separated frame indexes.");
            return Number(value);
          });
    const result = prepareReference({
      source: positionals[0],
      out: values.out,
      mode: values.mode,
      samples: Number(values.samples),
      cuts,
      width: Number(values.width),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
