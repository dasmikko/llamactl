import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  FavoriteStore,
  IDownloadManager,
  IInstallManager,
  InstanceStore,
  ISupervisor,
  Model,
  RunningModel,
  StatsSnapshot,
} from "../src/types.ts";
import { LlamactlError } from "../src/errors.ts";
import {
  startControlPlane,
  type ControlPlaneHandle,
  type StatsSource,
} from "../src/daemon/controlplane.ts";
import { findFreePort, isPortFree } from "../src/net/ports.ts";
import { createServer, type Server } from "node:net";

const TOKEN = "a".repeat(64);

function model(id: string): Model {
  return { id, name: id, path: `/models/${id}.gguf`, sizeBytes: 1, quant: null, source: "config", mtimeMs: 0, arch: null, contextLength: null, nLayers: null, kvDim: null, nEmbd: null, nHeads: null, kind: "text", org: null , repo: null };
}
function running(id: string): RunningModel {
  return {
    modelId: id, name: id, path: `/models/${id}.gguf`, pid: 1234, port: 18000,
    status: "ready", startedAt: 0, restarts: 0, logPath: "/tmp/x.log",
    spec: { model: id },
  };
}

/** Minimal mock supervisor that records calls. */
function mockSupervisor(): ISupervisor & { started: string[]; stopped: string[] } {
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    list: () => [running("alpha")],
    get: () => undefined,
    start: async (spec) => {
      started.push(spec.model);
      if (spec.model === "ghost") throw new LlamactlError("model_not_found", "no such model: ghost");
      return running(spec.model);
    },
    stop: async (sel) => {
      stopped.push(sel);
      if (sel === "idle") throw new LlamactlError("not_running", "not running: idle");
      return running(sel);
    },
    ensureReady: async (spec) => running(spec.model),
    serverInfo: async () => ({ path: "llama-server", found: true, version: "test (mock)" }),
    serverFlags: async () => ({ version: "test (mock)", flags: [] }),
    shutdownAll: async () => {},
  };
}

/** Empty in-memory instance store for the control-plane tests. */
function mockInstances(): InstanceStore {
  const map = new Map<string, never>();
  return {
    list: () => [],
    get: () => undefined,
    create: async () => {
      throw new LlamactlError("internal", "not used in this test");
    },
    update: async () => {
      throw new LlamactlError("internal", "not used in this test");
    },
    remove: async () => {
      void map;
    },
  };
}

/** In-memory favorites store backed by a plain Set. */
function mockFavorites(): FavoriteStore {
  const ids = new Set<string>();
  return {
    list: () => [...ids].sort(),
    has: (id) => ids.has(id),
    toggle: async (id) => {
      const now = !ids.has(id);
      if (now) ids.add(id);
      else ids.delete(id);
      return now;
    },
  };
}

const EMPTY_SNAPSHOT: StatsSnapshot = {
  ts: 0,
  system: { cpuPct: 0, memUsed: 0, memTotal: 0, tempC: null },
  gpus: [],
  instances: [],
  gpuAvailable: false,
};
const mockSampler: StatsSource = { snapshot: () => EMPTY_SNAPSHOT };

const pulled: { repo: string; file: string }[] = [];
const mockDownloads: IDownloadManager = {
  list: () => [
    {
      id: "r:f",
      repo: "r",
      file: "f",
      destPath: "/x",
      receivedBytes: 5,
      totalBytes: 10,
      status: "downloading",
      error: null,
      startedAt: 0,
    },
  ],
  get: () => undefined,
  start: (repo, file) => {
    pulled.push({ repo, file });
    return {
      id: `${repo}:${file}`,
      repo,
      file,
      destPath: `/d/${file}`,
      receivedBytes: 0,
      totalBytes: null,
      status: "downloading",
      error: null,
      startedAt: 0,
    };
  },
  cancel: (id) => {
    if (id !== "r:f") throw new LlamactlError("download_not_found", "no such download");
  },
  dismiss: (id) => {
    if (id !== "r:f") throw new LlamactlError("download_not_found", "no such download");
  },
  retry: (id) => {
    if (id !== "r:f") throw new LlamactlError("download_not_found", "no such download");
    return {
      id,
      repo: "r",
      file: "f",
      destPath: "/x",
      receivedBytes: 5,
      totalBytes: 10,
      status: "downloading",
      error: null,
      startedAt: 0,
    };
  },
};
type InstallCalls = {
  started: { repo: string }[];
  canceled: string[];
  removed: string[];
  activated: (string | null)[];
  renamed: { id: string; name: string }[];
  updated: string[];
};
function mockInstallManager(): IInstallManager & { calls: InstallCalls } {
  const calls: InstallCalls = { started: [], canceled: [], removed: [], activated: [], renamed: [], updated: [] };
  let activeId: string | null = null;
  return {
    calls,
    installs: () => [],
    builds: () =>
      calls.started.map((s, i) => ({
        id: `build-${i}`,
        name: s.repo,
        repo: s.repo,
        ref: "main",
        backend: "cuda",
        allowUnsupportedCompiler: false,
        cudaHostCompiler: null,
        status: "queued",
        logTail: [],
        logPath: "/tmp/x.log",
        error: null,
        installId: null,
        startedAt: i,
      })),
    getActive: () =>
      activeId === null
        ? null
        : {
            id: activeId,
            name: activeId,
            repo: "r",
            ref: "main",
            commit: null,
            backend: "cuda",
            binPath: "/x",
            version: null,
            allowUnsupportedCompiler: false,
            cudaHostCompiler: null,
            builtAt: 0,
            sizeBytes: null,
          },
    start: (req) => {
      calls.started.push({ repo: req.repo });
      const i = calls.started.length - 1;
      return {
        id: `build-${i}`,
        name: req.repo,
        repo: req.repo,
        ref: req.ref ?? "main",
        backend: req.backend ?? "cuda",
        allowUnsupportedCompiler: req.allowUnsupportedCompiler ?? false,
        cudaHostCompiler: req.cudaHostCompiler ?? null,
        status: "queued",
        logTail: [],
        logPath: "/tmp/x.log",
        error: null,
        installId: null,
        startedAt: i,
      };
    },
    cancel: (id) => {
      calls.canceled.push(id);
    },
    rename: async (id, name) => {
      calls.renamed.push({ id, name });
    },
    update: (id) => {
      calls.updated.push(id);
      return {
        id,
        name: id,
        repo: "r",
        ref: "main",
        backend: "cuda",
        allowUnsupportedCompiler: false,
        cudaHostCompiler: null,
        status: "queued",
        logTail: [],
        logPath: "/tmp/x.log",
        error: null,
        installId: null,
        startedAt: 0,
      };
    },
    setActive: async (id) => {
      calls.activated.push(id);
      activeId = id;
    },
    remove: async (id) => {
      calls.removed.push(id);
    },
  };
}
let mockInstalls: ReturnType<typeof mockInstallManager>;
const getHfToken = async (): Promise<string | null> => null;

let handle: ControlPlaneHandle;
let sup: ReturnType<typeof mockSupervisor>;
const base = () => handle.url;

beforeAll(async () => {
  sup = mockSupervisor();
  mockInstalls = mockInstallManager();
  handle = await startControlPlane({
    token: TOKEN,
    supervisor: sup,
    instances: mockInstances(),
    favorites: mockFavorites(),
    sampler: mockSampler,
    downloads: mockDownloads,
    installs: mockInstalls,
    getHfToken,
    models: () => [model("alpha"), model("beta")],
    refreshModels: () => {},
    startPort: await findFreePort(49200),
    pid: process.pid,
    startedAt: Date.now(),
    onShutdown: () => {},
  });
});
afterAll(() => handle.stop());

test("GET /health requires no auth", async () => {
  const res = await fetch(base() + "/health");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pid: number };
  expect(body.ok).toBe(true);
  expect(body.pid).toBe(process.pid);
});

test("protected routes reject a missing token", async () => {
  const res = await fetch(base() + "/ps");
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("unauthorized");
});

test("protected routes reject a wrong token (same length)", async () => {
  const res = await fetch(base() + "/ps", { headers: { authorization: `Bearer ${"b".repeat(64)}` } });
  expect(res.status).toBe(401);
});

test("GET /ps with the right token returns running models", async () => {
  const res = await fetch(base() + "/ps", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { running: RunningModel[] };
  expect(body.running[0]?.modelId).toBe("alpha");
});

test("GET /models returns discovered models", async () => {
  const res = await fetch(base() + "/models", { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = (await res.json()) as { models: Model[] };
  expect(body.models.map((m) => m.id).sort()).toEqual(["alpha", "beta"]);
});

test("POST /start forwards the selector to the supervisor", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "alpha" }),
  });
  expect(res.status).toBe(200);
  expect(sup.started).toContain("alpha");
});

test("POST /start with no model => 400 bad_request", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("supervisor's typed error surfaces with its status code", async () => {
  const res = await fetch(base() + "/start", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ghost" }),
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("model_not_found");
});

test("GET /downloads returns the manager's list", async () => {
  const res = await fetch(base() + "/downloads", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { downloads: { id: string; status: string }[] };
  expect(body.downloads[0]?.id).toBe("r:f");
  expect(body.downloads[0]?.status).toBe("downloading");
});

test("POST /pull (non-sharded) forwards to the download manager", async () => {
  const res = await fetch(base() + "/pull", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: "org/repo", file: "model-Q4_K_M.gguf" }),
  });
  expect(res.status).toBe(200);
  expect(pulled).toContainEqual({ repo: "org/repo", file: "model-Q4_K_M.gguf" });
});

test("POST /pull without repo/file => 400", async () => {
  const res = await fetch(base() + "/pull", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: "org/repo" }),
  });
  expect(res.status).toBe(400);
});

test("POST /downloads/:id/cancel cancels a known id", async () => {
  const res = await fetch(base() + "/downloads/r%3Af/cancel", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
});

test("POST /downloads/:id/retry resumes a known id and returns the list", async () => {
  const res = await fetch(base() + "/downloads/r%3Af/retry", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { downloads: unknown[] };
  expect(Array.isArray(body.downloads)).toBe(true);
});

test("POST /downloads/:id/retry for an unknown id => 404", async () => {
  const res = await fetch(base() + "/downloads/nope/retry", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(404);
});

test("DELETE /downloads/:id dismisses a known id and returns the list", async () => {
  const res = await fetch(base() + "/downloads/r%3Af", {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { downloads: unknown[] };
  expect(Array.isArray(body.downloads)).toBe(true);
});

test("DELETE /downloads/:id for an unknown id => 404", async () => {
  const res = await fetch(base() + "/downloads/nope", {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(404);
});

test("DELETE /models/:id removes a known model (files best-effort)", async () => {
  const res = await fetch(base() + "/models/alpha", {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; removed: string[] };
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.removed)).toBe(true);
});

test("DELETE /models/:id for an unknown model => 404", async () => {
  const res = await fetch(base() + "/models/ghost", {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("model_not_found");
});

test("GET /favorites starts empty; POST toggle adds then removes", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  const empty = await fetch(base() + "/favorites", { headers: auth });
  expect(empty.status).toBe(200);
  expect(((await empty.json()) as { favorites: string[] }).favorites).toEqual([]);

  const on = await fetch(base() + "/favorites/alpha/toggle", { method: "POST", headers: auth });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { favorites: string[] }).favorites).toEqual(["alpha"]);

  const list = await fetch(base() + "/favorites", { headers: auth });
  expect(((await list.json()) as { favorites: string[] }).favorites).toEqual(["alpha"]);

  const off = await fetch(base() + "/favorites/alpha/toggle", { method: "POST", headers: auth });
  expect(((await off.json()) as { favorites: string[] }).favorites).toEqual([]);
});

test("GET /installs returns the install manager state", async () => {
  const res = await fetch(base() + "/installs", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { installs: unknown[]; builds: unknown[]; activeId: string | null };
  expect(Array.isArray(body.installs)).toBe(true);
  expect(Array.isArray(body.builds)).toBe(true);
  expect(body.activeId).toBe(null);
});

test("POST /installs starts a build and returns fresh state", async () => {
  const res = await fetch(base() + "/installs", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: "ggml-org/llama.cpp" }),
  });
  expect(res.status).toBe(200);
  expect(mockInstalls.calls.started).toContainEqual({ repo: "ggml-org/llama.cpp" });
  const body = (await res.json()) as { builds: { repo: string }[] };
  expect(body.builds.some((b) => b.repo === "ggml-org/llama.cpp")).toBe(true);
});

test("POST /installs without repo is accepted (defaults to upstream)", async () => {
  const res = await fetch(base() + "/installs", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  // The manager fills in the default repo; the control plane no longer rejects.
  expect(res.status).toBe(200);
});

test("POST /installs with a non-string repo => 400 bad_request", async () => {
  const res = await fetch(base() + "/installs", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repo: 123 }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("bad_request");
});

test("POST /installs/:id/cancel cancels by id", async () => {
  const res = await fetch(base() + "/installs/build-0/cancel", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  expect(mockInstalls.calls.canceled).toContain("build-0");
});

test("DELETE /installs/:id removes by id", async () => {
  const res = await fetch(base() + "/installs/build-0", {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  expect(mockInstalls.calls.removed).toContain("build-0");
});

test("POST /installs/:id/update triggers a rebuild by id", async () => {
  const res = await fetch(base() + "/installs/build-0/update", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  expect(mockInstalls.calls.updated).toContain("build-0");
});

test("PATCH /installs/:id renames by id", async () => {
  const res = await fetch(base() + "/installs/build-0", {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "my-fork" }),
  });
  expect(res.status).toBe(200);
  expect(mockInstalls.calls.renamed).toContainEqual({ id: "build-0", name: "my-fork" });
});

test("PATCH /installs/:id without a name => 400 bad_request", async () => {
  const res = await fetch(base() + "/installs/build-0", {
    method: "PATCH",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

test("PUT /installs/active activates an id, then clears with null", async () => {
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const on = await fetch(base() + "/installs/active", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ id: "build-0" }),
  });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { activeId: string | null }).activeId).toBe("build-0");

  const off = await fetch(base() + "/installs/active", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ id: null }),
  });
  expect(off.status).toBe(200);
  expect(((await off.json()) as { activeId: string | null }).activeId).toBe(null);
  expect(mockInstalls.calls.activated).toEqual(["build-0", null]);
});

test("unknown route => 404 not_found", async () => {
  const res = await fetch(base() + "/nope", { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(404);
});

test("control plane scans upward when its preferred port is taken", async () => {
  const taken = await findFreePort(49300);
  const blocker: Server = createServer();
  await new Promise<void>((resolve) => blocker.listen(taken, "127.0.0.1", () => resolve()));
  try {
    const h = await startControlPlane({
      token: TOKEN,
      supervisor: mockSupervisor(),
      instances: mockInstances(),
      favorites: mockFavorites(),
      sampler: mockSampler,
    downloads: mockDownloads,
    installs: mockInstalls,
    getHfToken,
      models: () => [],
      refreshModels: () => {},
      startPort: taken,
      pid: process.pid,
      startedAt: Date.now(),
      onShutdown: () => {},
    });
    expect(h.port).toBeGreaterThan(taken);
    expect(await isPortFree(taken)).toBe(false); // blocker still holds it
    h.stop();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
