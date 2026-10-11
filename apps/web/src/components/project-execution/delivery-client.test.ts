import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  abortDeliveryImport,
  browserDeliveryLimit,
  createDelivery,
  deliveryChunkBytes,
  downloadDelivery,
  prepareDeliveryFile,
  promoteDelivery,
  revokeDelivery,
  sha256Hex,
  startImportedRun,
  uploadDeliveryFile,
  type Delivery,
} from "../../lib/project-delivery";
import type { MergePreview } from "../../lib/project-execution";

function binaryFile(size: number) {
  const bytes = Uint8Array.from(
    { length: size },
    (_, i) => (i * 97 + 255) % 256,
  );
  return {
    file: new File([bytes], "交付🐾.tar", { type: "application/x-tar" }),
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function transfer(totalBytes: number, sha256: string, received = 0): Delivery {
  return {
    id: "transfer",
    projectId: "pid",
    kind: "import",
    name: "bundle",
    version: "",
    revision: 1,
    status: "uploading",
    totalBytes,
    received,
    sha256,
    untrustedReview: true,
    createdBy: "user",
    comment: "bundle.tar",
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
  };
}

test("binary file identity hashes exact bytes and rejects oversized input before reading", async () => {
  const binary = binaryFile(2048);
  const identity = await prepareDeliveryFile(binary.file);
  assert.equal(identity.sha256, binary.sha256);
  assert.equal(identity.totalBytes, 2048);
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc").buffer),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  await assert.rejects(
    prepareDeliveryFile(new File([new Uint8Array(2047)], "short.tar")),
    /2 KiB/,
  );
  let read = false;
  const huge = {
    size: browserDeliveryLimit + 1,
    arrayBuffer: () => {
      read = true;
      throw new Error("must not read");
    },
  } as unknown as File;
  await assert.rejects(prepareDeliveryFile(huge), /64 MiB/);
  assert.equal(read, false);
});

test("resume sends unchanged binary slices from the runner's durable offset", async (t) => {
  const binary = binaryFile(deliveryChunkBytes * 2 + 317);
  let receipt = transfer(binary.file.size, binary.sha256, 65536);
  const offsets: number[] = [];
  const sizes: number[] = [];
  const progress: number[] = [];
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      assert.equal(
        init?.signal,
        controller.signal,
        "inspection and chunks must both honor pause",
      );
      const path = String(input);
      if (path.endsWith("/inspect")) return Response.json(receipt);
      assert.equal(init?.method, "PUT");
      assert.equal(
        new Headers(init?.headers).get("Content-Type"),
        "application/octet-stream",
      );
      const offset = Number(
        new URL(path, "https://example.test").searchParams.get("offset"),
      );
      const body = new Uint8Array(init!.body as ArrayBuffer);
      assert.deepEqual(body, binary.bytes.slice(offset, offset + body.length));
      offsets.push(offset);
      sizes.push(body.length);
      receipt = { ...receipt, received: offset + body.length };
      return Response.json(receipt);
    },
  );
  const result = await uploadDeliveryFile(
    "pid",
    receipt,
    binary.file,
    binary.sha256,
    (value) => progress.push(value.received ?? 0),
    controller.signal,
  );
  assert.deepEqual(offsets, [65536, 65536 + deliveryChunkBytes]);
  assert.deepEqual(sizes, [
    deliveryChunkBytes,
    binary.file.size - 65536 - deliveryChunkBytes,
  ]);
  assert.deepEqual(progress, [
    65536,
    65536 + deliveryChunkBytes,
    binary.file.size,
  ]);
  assert.equal(result.received, binary.file.size);
});

test("a lost chunk reply resumes after committed bytes without replaying that chunk", async (t) => {
  const binary = binaryFile(deliveryChunkBytes + 4000);
  let receipt = transfer(binary.file.size, binary.sha256);
  const offsets: number[] = [];
  let loseReply = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/inspect")) return Response.json(receipt);
      const offset = Number(
        new URL(path, "https://example.test").searchParams.get("offset"),
      );
      offsets.push(offset);
      receipt = {
        ...receipt,
        received: offset + (init!.body as ArrayBuffer).byteLength,
      };
      if (loseReply) {
        loseReply = false;
        throw new Error("reply lost after commit");
      }
      return Response.json(receipt);
    },
  );
  const admitted = transfer(binary.file.size, binary.sha256);
  await assert.rejects(
    uploadDeliveryFile(
      "pid",
      admitted,
      binary.file,
      binary.sha256,
      () => {},
      new AbortController().signal,
    ),
    /reply lost/,
  );
  assert.equal(receipt.received, deliveryChunkBytes);
  const result = await uploadDeliveryFile(
    "pid",
    admitted,
    binary.file,
    binary.sha256,
    () => {},
    new AbortController().signal,
  );
  assert.equal(result.received, binary.file.size);
  assert.deepEqual(offsets, [0, deliveryChunkBytes]);
});

test("pause stops further chunks and already-aborted uploads make no HTTP request", async (t) => {
  const binary = binaryFile(deliveryChunkBytes * 2 + 500);
  let receipt = transfer(binary.file.size, binary.sha256);
  let chunks = 0,
    requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      requests++;
      if (String(input).endsWith("/inspect")) return Response.json(receipt);
      chunks++;
      receipt = {
        ...receipt,
        received:
          (receipt.received ?? 0) + (init!.body as ArrayBuffer).byteLength,
      };
      return Response.json(receipt);
    },
  );
  const controller = new AbortController();
  await assert.rejects(
    uploadDeliveryFile(
      "pid",
      receipt,
      binary.file,
      binary.sha256,
      (value) => {
        if ((value.received ?? 0) > 0) controller.abort();
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(chunks, 1);
  const before = requests;
  const paused = new AbortController();
  paused.abort();
  await assert.rejects(
    uploadDeliveryFile(
      "pid",
      receipt,
      binary.file,
      binary.sha256,
      () => {},
      paused.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(requests, before);
});

test("wrong identities and non-progressing receipts stop before another write", async (t) => {
  const binary = binaryFile(2048);
  const admitted = transfer(binary.file.size, binary.sha256);
  let wrongDigest = true;
  let chunks = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).endsWith("/inspect"))
      return Response.json({
        ...admitted,
        sha256: wrongDigest ? "00".repeat(32) : admitted.sha256,
      });
    chunks++;
    return Response.json(admitted);
  });
  await assert.rejects(
    uploadDeliveryFile(
      "pid",
      admitted,
      binary.file,
      binary.sha256,
      () => {},
      new AbortController().signal,
    ),
    /SHA-256/,
  );
  assert.equal(chunks, 0);
  wrongDigest = false;
  await assert.rejects(
    uploadDeliveryFile(
      "pid",
      admitted,
      binary.file,
      binary.sha256,
      () => {},
      new AbortController().signal,
    ),
    /偏移/,
  );
  assert.equal(
    chunks,
    1,
    "a zero-progress receipt must not create an infinite loop",
  );
});

test("delivery download rejects corrupt bytes before making a browser download", async (t) => {
  const binary = binaryFile(2048);
  const delivery = {
    ...transfer(binary.file.size, binary.sha256),
    id: "delivery",
    kind: "delivery",
    status: "ready",
    archive: { bytes: binary.file.size, sha256: binary.sha256 },
  } as Delivery;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(new Uint8Array(binary.file.size)),
  );
  let created = false;
  t.mock.method(URL, "createObjectURL", () => {
    created = true;
    return "blob:test";
  });
  await assert.rejects(downloadDelivery("pid", delivery), /SHA-256/);
  assert.equal(created, false);
  const huge = {
    ...delivery,
    archive: { ...delivery.archive!, bytes: browserDeliveryLimit + 1 },
  };
  await assert.rejects(downloadDelivery("pid", huge), /Range/);
});

test("authenticated download releases exact verified archive bytes", async (t) => {
  const binary = binaryFile(2048);
  const delivery = {
    ...transfer(binary.file.size, binary.sha256),
    id: "delivery",
    kind: "delivery",
    status: "ready",
    archive: { bytes: binary.file.size, sha256: binary.sha256 },
  } as Delivery;
  const properties = ["window", "document", "localStorage"] as const;
  const previous = new Map(
    properties.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let clicked = 0;
  const anchor = { href: "", download: "", click: () => clicked++ };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === "zakura_session" ? "test-session" : null,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, "a");
        return anchor;
      },
    },
  });
  t.after(() => {
    for (const key of properties) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      assert.equal(
        String(input),
        "/api/project-executions/pid/deliveries/delivery/archive",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-session",
      );
      return new Response(binary.bytes);
    },
  );
  let saved: Blob | undefined;
  const createURL = URL.createObjectURL.bind(URL);
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    saved = blob;
    return createURL(blob);
  });
  await downloadDelivery("pid", delivery);
  assert.equal(clicked, 1);
  assert.equal(anchor.download, "zakura-delivery-delivery.tar");
  assert.ok(anchor.href.startsWith("blob:"));
  assert.deepEqual(new Uint8Array(await saved!.arrayBuffer()), binary.bytes);
});

test("delivery actions bind approved preview, channel and project revisions", async (t) => {
  const calls: { path: string; body: unknown; method?: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
        method: init?.method,
      });
      return Response.json({ id: "id" });
    },
  );
  await createDelivery(
    "pid",
    { id: "preview", runId: "run", revision: 7 } as MergePreview,
    "发布",
    "1.2",
    "已核对",
  );
  assert.deepEqual(calls.at(-1)!.body, {
    runId: "run",
    previewId: "preview",
    expectedPreviewRevision: 7,
    name: "发布",
    version: "1.2",
    comment: "已核对",
  });
  const delivery = {
    ...transfer(2048, "ab".repeat(32)),
    id: "delivery",
    kind: "delivery",
    revision: 12,
  } as Delivery;
  await promoteDelivery(
    "pid",
    delivery,
    "beta",
    {
      channel: "beta",
      deliveryId: "old",
      revision: 6,
      authorId: "user",
      comment: "old",
      updatedAt: "",
    },
    "发布到beta",
  );
  assert.deepEqual(calls.at(-1)!.body, {
    deliveryId: "delivery",
    expectedRevision: 6,
    comment: "发布到beta",
  });
  await revokeDelivery("pid", delivery, "撤回原因");
  assert.deepEqual(calls.at(-1)!.body, {
    expectedRevision: 12,
    comment: "撤回原因",
  });
  await startImportedRun("pid", transfer(2048, "ab".repeat(32)), 13);
  assert.deepEqual(calls.at(-1)!.body, { expectedRevision: 13 });
  await abortDeliveryImport("pid", transfer(2048, "ab".repeat(32)));
  assert.equal(
    calls.at(-1)!.path,
    "/api/project-executions/pid/imports/transfer",
  );
  assert.equal(calls.at(-1)!.method, "DELETE");
});
