import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRational, planSamples, prepareReference, readClock } from "./local-reference.mjs";

const stream = { time_base: "1/30000", avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" };
const frame = (pts, duration = 1001) => ({ best_effort_timestamp: pts, duration });
const available = ["ffmpeg", "ffprobe"].every(
  (binary) => spawnSync(binary, ["-version"]).status === 0,
);
const integration = { skip: available ? false : "FFmpeg and ffprobe must be installed separately" };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hyperframes-local-reference-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function ffmpeg(args) {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeVideo(path, extraFilters = []) {
  // Original synthetic fixture: three known five-frame shots. No downloaded media.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=96x64:r=30000/1001",
    "-vf",
    [
      "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='lt(n,5)'",
      "drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='gte(n,10)'",
      ...extraFilters,
    ].join(","),
    "-frames:v",
    "15",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    path,
  ]);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("preserves exact rational rates instead of rounding NTSC", () => {
  assert.deepEqual(parseRational("30000/1001"), {
    text: "30000/1001",
    numerator: 30000,
    denominator: 1001,
    value: 30000 / 1001,
  });
  assert.equal(parseRational("30").value, 30);
  for (const bad of ["0/0", "30000/0", "NaN", "-1/2", "29.97", "1/2/3", "", "9007199254740992"])
    assert.throws(() => parseRational(bad), /Invalid/);
});

test("sampling always preserves first, last, and both sides of cuts", () => {
  assert.deepEqual(planSamples(15, 8, [10, 5, 5]), [0, 4, 5, 6, 9, 10, 11, 14]);
  assert.deepEqual(planSamples(1, 12), [0]);
  assert.deepEqual(planSamples(4, 12), [0, 1, 2, 3]);
  assert.throws(() => planSamples(15, 7, [5, 10]), /need 8 samples/);
});

test("sampling rejects out-of-range cuts and resource budgets", () => {
  for (const cuts of [[0], [-1], [15], [1.2], [NaN]])
    assert.throws(() => planSamples(15, 12, cuts), /Cut frame/);
  for (const count of [0, 1, 65, Infinity]) assert.throws(() => planSamples(15, count), /samples/);
  assert.throws(() => planSamples(18_001, 12), /Frame count/);
});

test("sampling invariants across frame counts and budgets", () => {
  for (let frames = 1; frames < 100; frames++) {
    for (let budget = 2; budget < 20; budget++) {
      const samples = planSamples(frames, budget);
      assert.equal(samples.length, Math.min(frames, budget));
      assert.equal(samples[0], 0);
      assert.equal(samples.at(-1), frames - 1);
      assert.equal(new Set(samples).size, samples.length);
      assert.ok(samples.every((value, index) => !index || value > samples[index - 1]));
    }
  }
});

test("clock records source PTS and relative time without duration rounding", () => {
  const clock = readClock(stream, [frame(9000), frame(10001), frame(11002)]);
  assert.equal(clock.average_frame_rate, "30000/1001");
  assert.equal(clock.source_start_pts, 9000);
  assert.equal(clock.frames[1].time_seconds, 1001 / 30000);
  assert.equal(clock.picture_duration_seconds, 3003 / 30000);
  assert.equal(clock.picture_duration_is_estimate, false);
  assert.equal(clock.variable_timing, false);
});

test("clock detects variable timing but tolerates container tick quantization", () => {
  assert.equal(readClock(stream, [frame(0), frame(1001), frame(4004)]).variable_timing, true);
  const webm = { time_base: "1/1000", avg_frame_rate: "30/1" };
  assert.equal(
    readClock(webm, [frame(0, 33), frame(33, 34), frame(67, 33)]).variable_timing,
    false,
  );
});

test("clock refuses missing, duplicate, decreasing, or unsafe timestamps", () => {
  for (const frames of [
    [],
    [frame(undefined)],
    [frame(0), frame(0)],
    [frame(2), frame(1)],
    [frame(2 ** 54)],
  ])
    assert.throws(() => readClock(stream, frames));
  assert.throws(() => readClock(stream, [frame(0), frame(3_000_000)]), /exceeds 60 seconds/);
});

test("unknown last-frame duration is explicitly an estimate", () => {
  const clock = readClock(stream, [{ best_effort_timestamp: 0 }]);
  assert.equal(clock.frames[0].duration_ticks, null);
  assert.equal(clock.picture_duration_is_estimate, true);
});

test("rejects network/URI inputs before any filesystem or tool invocation", () => {
  for (const source of [
    "https://example.test/video.mp4",
    "file:///tmp/a.mp4",
    "pipe:0",
    "//server/a.mp4",
    "\\\\server\\a.mp4",
  ])
    assert.throws(() => prepareReference({ source, out: "unused" }), /local filesystem path/);
  for (const out of ["https://example.test/upload", "//server/share", "\\\\server\\share"])
    assert.throws(() => prepareReference({ source: "unused.mp4", out }), /local filesystem path/);
});

test("refuses existing destinations including dangling symlinks", (t) => {
  const directory = fixture(t);
  const source = join(directory, "source.mp4");
  writeFileSync(source, "not yet a video");
  const existing = join(directory, "keep.json");
  writeFileSync(existing, "original");
  assert.throws(() => prepareReference({ source, out: existing }), /already exists/);
  assert.equal(readFileSync(existing, "utf8"), "original");
  if (process.platform !== "win32") {
    const link = join(directory, "dangling");
    symlinkSync(join(directory, "absent"), link);
    assert.throws(() => prepareReference({ source, out: link }), /already exists/);
  }
});

test("CLI help and argument errors require no media tools", () => {
  const script = join(import.meta.dirname, "local-reference.mjs");
  assert.match(
    execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }),
    /No source copy/,
  );
  for (const args of [[], ["source.mp4", "--cuts", "1,,2"], ["source.mp4", "--unknown"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(typeof JSON.parse(result.stderr).error, "string");
  }
});

test(
  "prepares exact fractional-fps evidence, shot plan, and private contact sheet",
  integration,
  (t) => {
    const directory = fixture(t);
    const source = join(directory, "reference with spaces.mp4");
    const out = join(directory, "evidence");
    makeVideo(source);
    const original = createHash("sha256").update(readFileSync(source)).digest("hex");
    const result = prepareReference({ source, out, mode: "recreate", samples: 8, cuts: [5, 10] });
    const manifest = json(join(out, "manifest.json"));
    assert.equal(result.source_sha256, original);
    assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), original);
    assert.equal(manifest.clock.average_frame_rate, "30000/1001");
    assert.equal(manifest.clock.frame_count, 15);
    assert.equal(manifest.clock.picture_duration_seconds, 15015 / 30000);
    assert.equal(manifest.samples[2].pts, 5005);
    assert.equal(manifest.media.audio_present, false);
    assert.deepEqual(
      json(join(out, "shot-plan.json")).shots.map((shot) => [
        shot.start_frame,
        shot.end_frame_exclusive,
      ]),
      [
        [0, 5],
        [5, 10],
        [10, 15],
      ],
    );
    assert.equal(json(join(out, "shot-plan.json")).review_status, "unreviewed");
    assert.equal(manifest.source.filename, "reference with spaces.mp4");
    assert.ok(!readFileSync(join(out, "manifest.json"), "utf8").includes(directory));
    assert.match(readFileSync(join(out, ".gitignore"), "utf8"), /\n\*\n/);
    assert.match(readFileSync(join(out, "AGENT_BRIEF.md"), "utf8"), /retargeting/);
    assert.doesNotMatch(readFileSync(join(out, "contact-sheet.html"), "utf8"), /<script|https?:/);
    assert.deepEqual(readdirSync(out).sort(), [
      ".gitignore",
      "AGENT_BRIEF.md",
      "contact-sheet.html",
      "frames",
      "manifest.json",
      "shot-plan.json",
    ]);
    for (const sample of manifest.samples) {
      const rgb = ffmpeg([
        "-i",
        join(out, sample.file),
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
      const [r, g, b] = rgb;
      if (sample.frame < 5)
        assert.ok(r > 240 && g < 10 && b < 10, `f${sample.frame} should be red`);
      else if (sample.frame < 10)
        assert.ok(b > 240 && r < 10 && g < 10, `f${sample.frame} should be blue`);
      else assert.ok(r > 240 && g > 240 && b < 10, `f${sample.frame} should be yellow`);
    }
  },
);

test("variable-fps evidence uses actual timestamps and emits a warning", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "vfr.mkv");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=96x64:r=5",
    "-vf",
    "setpts='if(lt(N,2),N,N+2)/(5*TB)'",
    "-frames:v",
    "4",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    source,
  ]);
  const out = join(directory, "evidence");
  prepareReference({ source, out, samples: 4 });
  const manifest = json(join(out, "manifest.json"));
  assert.equal(manifest.clock.variable_timing, true);
  assert.deepEqual(
    manifest.samples.map((sample) => sample.time_seconds),
    [0, 0.2, 0.8, 1],
  );
  assert.ok(manifest.warnings.some((warning) => warning.startsWith("Variable timing")));
});

test("preview respects non-square pixels and caps both dimensions", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "wide.mp4");
  makeVideo(source, ["setsar=2/1"]);
  const out = join(directory, "evidence");
  prepareReference({ source, out, samples: 2, width: 128 });
  const manifest = json(join(out, "manifest.json"));
  assert.equal(manifest.media.sample_aspect_ratio, "2:1");
  const size = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        join(out, manifest.samples[0].file),
      ],
      { encoding: "utf8" },
    ),
  ).streams[0];
  assert.deepEqual(size, { width: 128, height: 43 });
});

test("rotated source is displayed upright and rotation is recorded", integration, (t) => {
  const directory = fixture(t);
  const original = join(directory, "original.mp4");
  const source = join(directory, "rotated.mp4");
  makeVideo(original);
  ffmpeg(["-display_rotation", "90", "-i", original, "-c", "copy", source]);
  const out = join(directory, "evidence");
  prepareReference({ source, out, samples: 2 });
  const manifest = json(join(out, "manifest.json"));
  assert.equal(Math.abs(manifest.media.rotation_degrees), 90);
  const size = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        join(out, manifest.samples[0].file),
      ],
      { encoding: "utf8" },
    ),
  ).streams[0];
  assert.deepEqual(size, { width: 64, height: 96 });
});

test("disguised playlists are rejected, and failures publish no partial pack", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "playlist.mp4");
  const out = join(directory, "evidence");
  writeFileSync(
    source,
    "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://example.invalid/private.ts\n#EXT-X-ENDLIST\n",
  );
  assert.throws(() => prepareReference({ source, out }), /ffprobe failed/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(directory), ["playlist.mp4"]);
});

test("failed sampling does not create output or mutate the source", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "source.mp4");
  const out = join(directory, "evidence");
  makeVideo(source);
  assert.throws(() => prepareReference({ source, out, cuts: [99] }), /Cut frame/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(directory), ["source.mp4"]);
});
