import assert from "node:assert/strict";
import test from "node:test";
import { DockerRuntime, type DockerPullEvent } from "../src/runtime/docker.js";
import { AcpImagePullProgressTracker } from "../src/services/acp/install-progress.js";

type PullDone = (error: Error | null) => void;
type PullProgress = (event: DockerPullEvent) => void;

function fakeRuntime() {
  const pulls: string[] = [];
  const done = new Map<string, PullDone>();
  const progress = new Map<string, PullProgress>();
  const runtime = new DockerRuntime({ socketPath: "/does/not/matter.sock" });
  const docker = {
    getImage: (_image: string) => ({ inspect: async () => Promise.reject(new Error("missing")) }),
    pull: (image: string, callback: (error: Error | null, stream: { image: string }) => void) => {
      pulls.push(image);
      callback(null, { image });
    },
    modem: {
      followProgress: (
        stream: { image: string },
        complete: PullDone,
        onProgress: PullProgress,
      ) => {
        done.set(stream.image, complete);
        progress.set(stream.image, onProgress);
      },
    },
  };
  Object.defineProperty(runtime, "docker", { value: docker });
  return { runtime, pulls, done, progress };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("concurrent ensureImage calls share exactly one Docker pull", async () => {
  const { runtime, pulls, done, progress } = fakeRuntime();
  const observed: string[] = [];

  const first = runtime.ensureImage("registry.test/acp:1", (line) => observed.push(`a:${line}`));
  const second = runtime.ensureImage("registry.test/acp:1", (line) => observed.push(`b:${line}`));
  const third = runtime.ensureImage("registry.test/acp:1");
  await flush();

  assert.deepEqual(pulls, ["registry.test/acp:1"]);
  progress.get("registry.test/acp:1")?.({
    id: "layer-1",
    status: "Downloading",
    progressDetail: { current: 5, total: 10 },
  });
  done.get("registry.test/acp:1")?.(null);
  await Promise.all([first, second, third]);

  assert.equal(pulls.length, 1);
  assert.ok(observed.some((line) => line.includes("a:layer-1 Downloading")));
  assert.ok(observed.some((line) => line.includes("b:layer-1 Downloading")));
});

test("different image pulls are serialized", async () => {
  const { runtime, pulls, done } = fakeRuntime();
  const first = runtime.ensureImage("registry.test/one:1");
  const second = runtime.ensureImage("registry.test/two:1");
  await flush();

  assert.deepEqual(pulls, ["registry.test/one:1"]);
  done.get("registry.test/one:1")?.(null);
  await flush();
  assert.deepEqual(pulls, ["registry.test/one:1", "registry.test/two:1"]);
  done.get("registry.test/two:1")?.(null);
  await Promise.all([first, second]);
});

test("Docker layer events produce aggregate byte progress with decimal precision", () => {
  const tracker = new AcpImagePullProgressTracker();
  tracker.update("layer-a Downloading", {
    id: "layer-a",
    status: "Downloading",
    progressDetail: { current: 25, total: 100 },
  });
  const progress = tracker.update("layer-b Downloading", {
    id: "layer-b",
    status: "Downloading",
    progressDetail: { current: 25, total: 50 },
  });

  assert.equal(progress.state, "pulling");
  assert.equal(progress.downloadedBytes, 50);
  assert.equal(progress.totalBytes, 150);
  assert.equal(progress.percent, 33.3);
  assert.equal(tracker.complete().percent, 100);
});