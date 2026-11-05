// Fork modification (2026-11-05): cover decoded timing, dense review windows, and cropped detail evidence.
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
import {
  parseCrop,
  parseFrameWindow,
  parseRational,
  planSamples,
  prepareReference,
  readClock,
} from "./local-reference.mjs";

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

test("dense review windows parse strictly as half-open decoded-frame intervals", () => {
  assert.equal(parseFrameWindow(undefined), undefined);
  assert.deepEqual(parseFrameWindow("80:96"), { start_frame: 80, end_frame_exclusive: 96 });
  for (const value of [
    "",
    "1",
    "1,2",
    "1:2:3",
    "1.5:3",
    "-1:3",
    " 1:3",
    "1:3 ",
    "3:3",
    "4:3",
    "0:18001",
    "0:9007199254740992",
  ])
    assert.throws(() => parseFrameWindow(value), /window|Window/);
});

test("dense review preserves every requested frame, cuts, and clip endpoints", () => {
  const window = parseFrameWindow("7:10");
  assert.deepEqual(planSamples(15, 6, [], window), [0, 3, 7, 8, 9, 14]);
  assert.deepEqual(planSamples(15, 8, [8, 8, 5], window), [0, 4, 5, 6, 7, 8, 9, 14]);
  assert.deepEqual(planSamples(1, 2, [], parseFrameWindow("0:1")), [0]);
  assert.deepEqual(planSamples(4, 4, [], parseFrameWindow("0:4")), [0, 1, 2, 3]);
  assert.throws(() => planSamples(15, 4, [], window), /need 5 samples/);
  assert.throws(() => planSamples(15, 7, [5], window), /need 8 samples/);
  assert.throws(() => planSamples(100, 64, [], parseFrameWindow("0:65")), /need 66 samples/);
  for (const value of [
    null,
    [],
    {},
    { start_frame: -1, end_frame_exclusive: 2 },
    { start_frame: 3, end_frame_exclusive: 3 },
    { start_frame: 1, end_frame_exclusive: 16 },
  ])
    assert.throws(() => planSamples(15, 12, [], value), /window|Window/);
});

test("dense window sampling invariants across positions and budgets", () => {
  for (let frameCount = 1; frameCount < 30; frameCount++) {
    for (let start = 0; start < frameCount; start++) {
      const end = Math.min(frameCount, start + 5);
      const samples = planSamples(frameCount, 10, [], {
        start_frame: start,
        end_frame_exclusive: end,
      });
      assert.equal(samples.length, Math.min(frameCount, 10));
      assert.equal(samples[0], 0);
      assert.equal(samples.at(-1), frameCount - 1);
      assert.equal(new Set(samples).size, samples.length);
      for (let frame = start; frame < end; frame++) assert.ok(samples.includes(frame));
    }
  }
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
  assert.equal(
    readClock(webm, [frame(0, 33), frame(33, 34), frame(67, 33)])
      .average_rate_disagrees_with_timestamps,
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
  assert.equal(
    clock.picture_duration_estimate_method,
    "average frame rate; only one decoded frame",
  );
});

test("missing tail uses decoded cadence when container average fps is misleading", () => {
  const frames = Array.from({ length: 96 }, (_, i) => ({
    best_effort_timestamp: i * 512,
    ...(i < 95 ? { duration: 512 } : {}),
  }));
  const clock = readClock(
    { time_base: "1/12288", avg_frame_rate: "2304/95", r_frame_rate: "24/1" },
    frames,
  );
  assert.equal(clock.picture_duration_seconds, 4);
  assert.equal(clock.picture_duration_ticks, null);
  assert.equal(clock.picture_duration_is_estimate, true);
  assert.equal(clock.picture_duration_estimate_method, "previous decoded presentation interval");
  assert.equal(clock.average_rate_disagrees_with_timestamps, true);
  assert.equal(clock.average_frame_rate, "2304/95", "source metadata stays unmodified");
  assert.equal(clock.frames.at(-1).pts, 48640);
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
  for (const args of [
    [],
    ["source.mp4", "--cuts", "1,,2"],
    ["source.mp4", "--window", "2:1"],
    ["source.mp4", "--window", "1:2:3"],
    ["source.mp4", "--crop", "0:0:101:100"],
    ["source.mp4", "--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(typeof JSON.parse(result.stderr).error, "string");
  }
});

test(
  "CLI dense review captures a one-frame event without creating false shot cuts",
  integration,
  (t) => {
    const directory = fixture(t);
    const source = join(directory, "flash.mp4");
    makeVideo(source, ["drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,8)'"]);
    const original = createHash("sha256").update(readFileSync(source)).digest("hex");
    assert.ok(!planSamples(15, 4).includes(8), "sparse overview misses this brief event");
    const out = join(directory, "dense");
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "local-reference.mjs"),
        source,
        "--out",
        out,
        "--window",
        "7:10",
        "--samples",
        "6",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = json(join(out, "manifest.json"));
    assert.equal(JSON.parse(result.stdout).frames, 6);
    assert.deepEqual(
      manifest.samples.map((sample) => sample.frame),
      [0, 3, 7, 8, 9, 14],
    );
    assert.deepEqual(manifest.cuts.frames, []);
    assert.deepEqual(manifest.review_window, {
      start_frame: 7,
      end_frame_exclusive: 10,
      coverage: "every decoded frame; not a shot boundary declaration",
    });
    const shots = json(join(out, "shot-plan.json")).shots;
    assert.equal(shots.length, 1);
    assert.deepEqual([shots[0].start_frame, shots[0].end_frame_exclusive], [0, 15]);
    assert.match(readFileSync(join(out, "contact-sheet.html"), "utf8"), /\[7, 10\)/);
    for (const frame of [7, 8, 9]) {
      const sample = manifest.samples.find((item) => item.frame === frame);
      assert.equal(sample.pts, frame * 1001);
      const [r, g, b] = ffmpeg([
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
      if (frame === 8)
        assert.ok(r > 240 && g > 240 && b > 240, "the one-frame white event is preserved");
      else assert.ok(r < 10 && g < 10 && b > 240, "both blue neighbors are preserved");
    }
    assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), original);
    for (const window of [parseFrameWindow("7:16"), parseFrameWindow("0:15")]) {
      const rejected = join(directory, "rejected");
      assert.throws(
        () => prepareReference({ source, out: rejected, samples: 6, window }),
        /Window|samples/,
      );
      assert.equal(existsSync(rejected), false);
    }
  },
);

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

test("dense windows preserve genuine cut-defined shots in extracted evidence", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "three-shots.mp4");
  makeVideo(source);
  const out = join(directory, "dense-with-cuts");
  prepareReference({
    source,
    out,
    samples: 10,
    cuts: [10, 5, 10],
    window: parseFrameWindow("7:10"),
  });
  const manifest = json(join(out, "manifest.json"));
  assert.deepEqual(manifest.cuts.frames, [5, 10]);
  assert.deepEqual(
    manifest.samples.map((sample) => sample.frame),
    [0, 4, 5, 6, 7, 8, 9, 10, 11, 14],
  );
  assert.deepEqual(
    json(join(out, "shot-plan.json")).shots.map((shot) => ({
      interval: [shot.start_frame, shot.end_frame_exclusive],
      evidence: shot.evidence_frames,
    })),
    [
      { interval: [0, 5], evidence: [0, 4] },
      { interval: [5, 10], evidence: [5, 6, 7, 8, 9] },
      { interval: [10, 15], evidence: [10, 11, 14] },
    ],
  );
  for (const sample of manifest.samples) assert.ok(existsSync(join(out, sample.file)));
});

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
  prepareReference({ source, out, samples: 4, window: parseFrameWindow("1:3") });
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

test("crop parsing uses strict percentage edges and validates direct calls", (t) => {
  assert.equal(parseCrop(undefined), undefined);
  assert.deepEqual(parseCrop("9.375:14.063:54.167:65.625"), {
    left_percent: 9.375,
    top_percent: 14.063,
    right_percent: 54.167,
    bottom_percent: 65.625,
  });
  for (const value of [
    "",
    "1:2:3",
    "0:0:100:100:1",
    "0:0:101:100",
    "50:0:50:100",
    "75:0:50:100",
    "0:80:100:60",
    "-1:0:100:100",
    "0:0:1e2:100",
    "0:0:NaN:100",
    "0:0:0.0001:100",
    " 0:0:100:100",
    "0:0:100:100 ",
    "0:0:100:100,scale=999",
  ]) {
    assert.throws(() => parseCrop(value), /crop/);
  }
  const directory = fixture(t);
  for (const crop of [
    null,
    [],
    {},
    { left_percent: 0, top_percent: 0, right_percent: "100", bottom_percent: 100 },
    { left_percent: 0, top_percent: 0, right_percent: Infinity, bottom_percent: 100 },
  ]) {
    assert.throws(
      () =>
        prepareReference({
          source: join(directory, "absent.mp4"),
          out: join(directory, "out"),
          crop,
        }),
      /crop/,
    );
  }
  assert.deepEqual(readdirSync(directory), []);
});

function decodedPixels(path) {
  return ffmpeg(["-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
}

function pngSize(path) {
  const png = readFileSync(path);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("crop preserves odd pixel bounds on subsampled input without upscaling", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "gradient.mkv");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=96x64:r=5,geq=lum='mod(X*17+Y*37,220)':cb=128:cr=128",
    "-frames:v",
    "2",
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const out = join(directory, "detail");
  prepareReference({ source, out, samples: 2, crop: parseCrop("9.375:14.063:54.167:65.625") });
  const manifest = json(join(out, "manifest.json"));
  const detail = join(out, manifest.samples[0].file);
  assert.deepEqual(pngSize(detail), { width: 43, height: 33 });
  const original = decodedPixels(source);
  const expected = Buffer.concat(
    Array.from({ length: 33 }, (_, row) =>
      original.subarray(((row + 9) * 96 + 9) * 3, ((row + 9) * 96 + 52) * 3),
    ),
  );
  const actual = decodedPixels(detail);
  assert.equal(actual.length, expected.length);
  assert.ok(
    actual.every((value, index) => Math.abs(value - expected[index]) <= 2),
    "exact pixel positions survive with at most two levels of color-conversion rounding",
  );
  assert.equal(manifest.preview_crop.left_percent, 9.375);
  assert.match(manifest.preview_crop.pixel_bounds, /floor/);
  assert.deepEqual(json(join(out, "shot-plan.json")).preview_crop, manifest.preview_crop);
  assert.match(readFileSync(join(out, "contact-sheet.html"), "utf8"), /Detail crop: left 9.375%/);
  assert.match(readFileSync(join(out, "AGENT_BRIEF.md"), "utf8"), /not complete frames/);
  assert.ok(manifest.warnings.some((warning) => warning.startsWith("Cropped detail")));
});

test("crop is applied in displayed orientation after rotation", integration, (t) => {
  const directory = fixture(t);
  const original = join(directory, "landscape.mp4");
  const source = join(directory, "rotated.mp4");
  makeVideo(original, ["drawbox=x=0:y=0:w=48:h=64:color=lime:t=fill"]);
  ffmpeg(["-display_rotation", "90", "-i", original, "-c", "copy", source]);
  const overview = join(directory, "overview");
  const out = join(directory, "detail");
  prepareReference({ source, out: overview, samples: 2 });
  prepareReference({ source, out, samples: 2, crop: parseCrop("0:0:100:50") });
  const fullFile = join(overview, "frames/f000000.png");
  const cropFile = join(out, "frames/f000000.png");
  assert.deepEqual(pngSize(fullFile), { width: 64, height: 96 });
  assert.deepEqual(pngSize(cropFile), { width: 64, height: 48 });
  assert.deepEqual(decodedPixels(cropFile), decodedPixels(fullFile).subarray(0, 64 * 48 * 3));
  const rgb = decodedPixels(cropFile);
  assert.ok(
    rgb[0] > 240 && rgb[1] < 10 && rgb[2] < 10,
    "displayed top half is the red right side of the encoded frame",
  );
});

test(
  "crop respects sample aspect ratio and leaves the source clock and shots unchanged",
  integration,
  (t) => {
    const directory = fixture(t);
    const source = join(directory, "wide.mp4");
    makeVideo(source, ["setsar=2/1"]);
    const out = join(directory, "detail");
    const overview = join(directory, "overview");
    const options = {
      source,
      samples: 10,
      cuts: [5, 10],
      window: parseFrameWindow("7:10"),
      width: 128,
    };
    prepareReference({ ...options, out: overview });
    prepareReference({ ...options, out, crop: parseCrop("25:0:75:100") });
    const manifest = json(join(out, "manifest.json"));
    const full = json(join(overview, "manifest.json"));
    assert.deepEqual(pngSize(join(out, manifest.samples[0].file)), { width: 96, height: 64 });
    assert.deepEqual(manifest.clock, full.clock);
    assert.deepEqual(manifest.samples, full.samples);
    assert.deepEqual(manifest.cuts, full.cuts);
    assert.deepEqual(manifest.review_window, full.review_window);
    assert.deepEqual(
      json(join(out, "shot-plan.json")).shots,
      json(join(overview, "shot-plan.json")).shots,
    );
    assert.deepEqual(manifest.source, full.source);
  },
);

test("full-frame crop matches uncropped pixel evidence", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "full.mp4");
  makeVideo(source);
  const out = join(directory, "detail");
  const overview = join(directory, "overview");
  prepareReference({ source, out: overview, samples: 2 });
  prepareReference({ source, out, samples: 2, crop: parseCrop("0:0:100:100") });
  for (const name of readdirSync(join(out, "frames"))) {
    assert.deepEqual(
      readFileSync(join(out, "frames", name)),
      readFileSync(join(overview, "frames", name)),
    );
  }
  assert.equal(json(join(overview, "manifest.json")).preview_crop, null);
});

test("crop bounds that round to zero leave no output or temporary pack", integration, (t) => {
  const directory = fixture(t);
  const source = join(directory, "tiny.mp4");
  makeVideo(source);
  const original = readFileSync(source);
  for (const crop of ["0:0:0.001:100", "0:0:100:0.001"]) {
    const out = join(directory, "detail");
    assert.throws(
      () => prepareReference({ source, out, samples: 2, crop: parseCrop(crop) }),
      /ffmpeg failed/,
    );
    assert.equal(existsSync(out), false);
    assert.deepEqual(readdirSync(directory), ["tiny.mp4"]);
  }
  assert.deepEqual(readFileSync(source), original);
});
