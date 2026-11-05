// Fork modification (2026-11-05): cover live cgroup available-memory estimates.
// fallow-ignore-file code-duplication
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIB = 1024 * 1024;

async function mockLinuxMemory(
  files: Record<string, string>,
  freeMb = 16384,
): Promise<typeof import("./systemMemory.js")> {
  vi.doMock("node:os", async () => ({
    ...(await vi.importActual<typeof import("node:os")>("node:os")),
    platform: () => "linux",
    freemem: () => freeMb * MIB,
  }));
  vi.doMock("node:fs", async () => ({
    ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
    readFileSync: (path: string) => {
      if (path in files) return files[path];
      throw Object.assign(new Error("missing file"), { code: "ENOENT" });
    },
  }));
  return import("./systemMemory.js");
}

describe("container available memory", () => {
  const cases: { name: string; files: Record<string, string>; expected: number }[] = [
    {
      name: "uses cgroup v1 usage when v2 is absent",
      files: {
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(4096 * MIB),
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(3584 * MIB),
      },
      expected: 512,
    },
    {
      name: "accepts zero usage",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": "0\n",
      },
      expected: 4096,
    },
    {
      name: "clamps usage above the ceiling to zero",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": String(4097 * MIB),
      },
      expected: 0,
    },
    {
      name: "rounds sub-MiB usage up conservatively",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": String(4095 * MIB + 1),
      },
      expected: 0,
    },
    {
      name: "caps the estimate at the ceiling when usage is absent",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
      },
      expected: 4096,
    },
    {
      name: "ignores negative usage without exceeding the ceiling",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": "-1",
      },
      expected: 4096,
    },
    {
      name: "ignores malformed usage without exceeding the ceiling",
      files: {
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": "123garbage",
      },
      expected: 4096,
    },
    {
      name: "does not mix an unlimited v2 hierarchy with v1",
      files: {
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(1024 * MIB),
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(512 * MIB),
      },
      expected: 32768,
    },
    {
      name: "ignores the cgroup v1 unlimited sentinel",
      files: {
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(512 * MIB),
      },
      expected: 32768,
    },
    {
      name: "uses the smaller host estimate",
      files: {
        "/sys/fs/cgroup/memory.max": String(65536 * MIB),
        "/sys/fs/cgroup/memory.current": String(1024 * MIB),
      },
      expected: 32768,
    },
    {
      name: "prefers v2 usage when both hierarchies exist",
      files: {
        "/sys/fs/cgroup/memory.max": String(8192 * MIB),
        "/sys/fs/cgroup/memory.current": String(7168 * MIB),
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(4096 * MIB),
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(3584 * MIB),
      },
      expected: 1024,
    },
  ];

  it.each(cases)("$name", async ({ files, expected }) => {
    const { getAvailableMemoryMb } = await mockLinuxMemory({
      "/proc/meminfo": "MemAvailable: 33554432 kB\n",
      ...files,
    });
    expect(getAvailableMemoryMb()).toBe(expected);
  });

  it("rereads live usage and limits rather than caching headroom", async () => {
    const files = {
      "/proc/meminfo": "MemAvailable: 33554432 kB\n",
      "/sys/fs/cgroup/memory.max": String(8192 * MIB),
      "/sys/fs/cgroup/memory.current": String(7680 * MIB),
    };
    const { getAvailableMemoryMb } = await mockLinuxMemory(files);
    expect(getAvailableMemoryMb()).toBe(512);
    files["/sys/fs/cgroup/memory.current"] = String(7936 * MIB);
    expect(getAvailableMemoryMb()).toBe(256);
    files["/sys/fs/cgroup/memory.max"] = String(16384 * MIB);
    expect(getAvailableMemoryMb()).toBe(8448);
  });

  it("still applies container headroom when /proc/meminfo is unreadable", async () => {
    const { getAvailableMemoryMb } = await mockLinuxMemory({
      "/sys/fs/cgroup/memory.max": String(4096 * MIB),
      "/sys/fs/cgroup/memory.current": String(3584 * MIB),
    });
    expect(getAvailableMemoryMb()).toBe(512);
  });

  it("retains the smaller OS fallback when MemAvailable is missing", async () => {
    const { getAvailableMemoryMb } = await mockLinuxMemory(
      {
        "/proc/meminfo": "MemFree: 262144 kB\n",
        "/sys/fs/cgroup/memory.max": String(4096 * MIB),
        "/sys/fs/cgroup/memory.current": String(3584 * MIB),
      },
      256,
    );
    expect(getAvailableMemoryMb()).toBe(256);
  });
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAvailableMemoryMb", () => {
  it("reports container headroom instead of host memory on cgroup v2", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "linux",
      freemem: () => 16 * 1024 * 1024 * 1024,
    }));
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      readFileSync: (path: string) => {
        const files: Record<string, string> = {
          "/proc/meminfo": "MemAvailable: 33554432 kB\n",
          "/sys/fs/cgroup/memory.max": String(8192 * 1024 * 1024),
          "/sys/fs/cgroup/memory.current": String(7680 * 1024 * 1024),
        };
        if (path in files) return files[path];
        throw Object.assign(new Error("missing file"), { code: "ENOENT" });
      },
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    expect(getAvailableMemoryMb()).toBe(512);
  });

  it("parses vm_stat on macOS to compute available memory", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "darwin",
      freemem: () => 100 * 1024 * 1024,
    }));
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      execSync: (_cmd: string) =>
        [
          "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
          "Pages free:                             5000.",
          "Pages active:                         200000.",
          "Pages inactive:                       100000.",
          "Pages speculative:                      2000.",
          "Pages throttled:                           0.",
          "Pages wired down:                     150000.",
          "Pages purgeable:                        3000.",
        ].join("\n"),
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    const result = getAvailableMemoryMb();

    // (5000 + 100000 + 3000 + 2000) * 16384 = 110000 * 16384 = 1,802,240,000 bytes
    // 1,802,240,000 / (1024 * 1024) = ~1718 MB
    expect(result).toBe(Math.trunc((110000 * 16384) / (1024 * 1024)));
  });

  it("falls back to freemem on macOS when vm_stat fails", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "darwin",
      freemem: () => 4 * 1024 * 1024 * 1024,
    }));
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      execSync: () => {
        throw new Error("vm_stat not found");
      },
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    expect(getAvailableMemoryMb()).toBe(4096);
  });

  it("reads MemAvailable from /proc/meminfo on Linux", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "linux",
      freemem: () => 100 * 1024 * 1024,
    }));
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      readFileSync: (path: string, _enc: string) => {
        if (path === "/proc/meminfo") {
          return [
            "MemTotal:       16384000 kB",
            "MemFree:          512000 kB",
            "MemAvailable:    8192000 kB",
            "Buffers:          256000 kB",
          ].join("\n");
        }
        throw new Error(`unexpected path: ${path}`);
      },
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    // 8192000 kB / 1024 = 8000 MB
    expect(getAvailableMemoryMb()).toBe(8000);
  });

  it("falls back to freemem on Linux when /proc/meminfo is unreadable", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "linux",
      freemem: () => 2 * 1024 * 1024 * 1024,
    }));
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      readFileSync: (path: string) => {
        if (path === "/proc/meminfo") throw new Error("ENOENT");
        throw new Error(`unexpected path: ${path}`);
      },
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    expect(getAvailableMemoryMb()).toBe(2048);
  });

  it("falls back to freemem on unsupported platforms", async () => {
    vi.doMock("node:os", async () => ({
      ...(await vi.importActual<typeof import("node:os")>("node:os")),
      platform: () => "win32",
      freemem: () => 6 * 1024 * 1024 * 1024,
    }));

    const { getAvailableMemoryMb } = await import("./systemMemory.js");
    expect(getAvailableMemoryMb()).toBe(6144);
  });
});
