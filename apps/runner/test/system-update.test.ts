import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Docker from "dockerode";
import {
  parseSelfProcHints,
  containerLooksLikeRunner,
  findSelfContainerId,
  sidecarNameForRunner,
  resolveSharedNetworkMode,
  assertSafeToRecreate,
  replacementLooksHealthy,
  buildReplacementCreateOpts,
  buildRecreatorContainerSpec,
  RECREATOR_CONTAINER_NAME,
  hostDockerSockPath,
} from "../src/system-update.js";

const RUNNER_ID = "5489ddda6eb4aa23f67652cbc0bef458a7b818975275ceaa9dcfa0961581a76b";
const TS_ID = "1f91d279b0d56c25f336cfeab552c08c44b9fcab8f10c6640d2acc89fbd9a28e";
const OVERLAY = "75e619d9b598a11af3a9f5970fd800dac5efc9f608bed2870f580c92a0355858";
const TOKEN = "rnr_test_token_value";

/** Captured from a privileged Runner with `network_mode: container:<zakura-ts>`. */
const INCIDENT_CGROUP = "0::/\n";
const INCIDENT_MOUNTINFO = `
468 251 0:73 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/QIX5,upperdir=/var/lib/docker/overlay2/${OVERLAY}/diff,workdir=/var/lib/docker/overlay2/${OVERLAY}/work,nouserxattr
480 468 252:0 /var/lib/docker/containers/${TS_ID}/resolv.conf//deleted /etc/resolv.conf rw,relatime - ext4 /dev/mapper/ubuntu--vg-ubuntu--lv rw
482 468 252:0 /var/lib/docker/containers/${TS_ID}/hostname//deleted /etc/hostname rw,relatime - ext4 /dev/mapper/ubuntu--vg-ubuntu--lv rw
484 468 252:0 /var/lib/docker/containers/${TS_ID}/hosts//deleted /etc/hosts rw,relatime - ext4 /dev/mapper/ubuntu--vg-ubuntu--lv rw
`.trim();

type FakeInfo = Docker.ContainerInspectInfo;

function listRow(opts: {
  id: string;
  name: string;
  image: string;
  command: string;
  labels?: Record<string, string>;
}): Docker.ContainerInfo {
  return {
    Id: opts.id,
    Names: [`/${opts.name}`],
    Image: opts.image,
    ImageID: `sha256:${opts.id}`,
    Command: opts.command,
    Created: 0,
    Ports: [],
    Labels: opts.labels ?? {},
    State: "running",
    Status: "Up",
    HostConfig: { NetworkMode: "default" },
    NetworkSettings: { Networks: {} },
    Mounts: [],
  } as Docker.ContainerInfo;
}

function inspectInfo(opts: {
  id: string;
  name: string;
  image: string;
  cmd: string[];
  env: string[];
  overlay?: string;
  networkMode?: string;
  binds?: string[];
  devices?: Array<{ PathOnHost: string; PathInContainer: string }>;
  entrypoint?: string[];
}): FakeInfo {
  return {
    Id: opts.id,
    Name: `/${opts.name}`,
    Config: {
      Image: opts.image,
      Cmd: opts.cmd,
      Env: opts.env,
      Hostname: opts.name,
      Entrypoint: opts.entrypoint,
      Labels: {},
      ExposedPorts: { "7443/tcp": {} },
    },
    HostConfig: {
      NetworkMode: opts.networkMode ?? "bridge",
      Binds: opts.binds ?? ["/var/run/docker.sock:/var/run/docker.sock"],
      Devices: opts.devices ?? [],
      Privileged: true,
      PortBindings: { "7443/tcp": [{ HostIp: "", HostPort: "7443" }] },
      RestartPolicy: { Name: "always" },
    },
    NetworkSettings: { Networks: {} },
    GraphDriver: {
      Name: "overlay2",
      Data: opts.overlay
        ? {
            UpperDir: `/var/lib/docker/overlay2/${opts.overlay}/diff`,
            MergedDir: `/var/lib/docker/overlay2/${opts.overlay}/merged`,
            WorkDir: `/var/lib/docker/overlay2/${opts.overlay}/work`,
          }
        : {},
    },
  } as FakeInfo;
}

function fakeDocker(
  containers: Array<{ row: Docker.ContainerInfo; inspect: FakeInfo }>,
): Docker {
  const byId = new Map(containers.map((c) => [c.row.Id, c]));
  return {
    listContainers: async () => containers.map((c) => c.row),
    getContainer: (id: string) => {
      const hit =
        byId.get(id) ??
        [...byId.values()].find((c) => c.row.Id.startsWith(id) || id.startsWith(c.row.Id));
      return {
        inspect: async () => {
          if (!hit) throw new Error(`no such container ${id}`);
          return hit.inspect;
        },
      };
    },
  } as unknown as Docker;
}

function tsPlusRunner(opts?: { runnerOverlay?: string; tsOverlay?: string }) {
  const runner = {
    row: listRow({
      id: RUNNER_ID,
      name: "zakura-runner-rngaixl02ubkaq32",
      image: "sunwuyuan/zakura-runner-dev:latest",
      command: "pnpm --filter @zakura/runner start",
    }),
    inspect: inspectInfo({
      id: RUNNER_ID,
      name: "zakura-runner-rngaixl02ubkaq32",
      image: "sunwuyuan/zakura-runner-dev:latest",
      cmd: ["pnpm", "--filter", "@zakura/runner", "start"],
      env: [`ZAKURA_RUNNER_TOKEN=${TOKEN}`, "ZAKURA_RUNNER_PORT=7443"],
      overlay: opts?.runnerOverlay ?? OVERLAY,
    }),
  };
  const ts = {
    row: listRow({
      id: TS_ID,
      name: "zakura-ts-rngaixl02ubkaq32",
      image: "tailscale/tailscale:latest",
      command: "/usr/local/bin/containerboot",
    }),
    inspect: inspectInfo({
      id: TS_ID,
      name: "zakura-ts-rngaixl02ubkaq32",
      image: "tailscale/tailscale:latest",
      cmd: ["/usr/local/bin/containerboot"],
      env: ["TS_AUTHKEY=hskey-auth-redacted", "TS_USERSPACE=false"],
      overlay: opts?.tsOverlay ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  };
  return fakeDocker([ts, runner]);
}

describe("parseSelfProcHints", () => {
  it("takes overlay upperdir and ignores the sidecar resolv.conf/hostname/hosts ids", () => {
    const hints = parseSelfProcHints(INCIDENT_CGROUP, INCIDENT_MOUNTINFO);
    assert.equal(hints.cgroupId, null);
    assert.equal(hints.overlayUpperId, OVERLAY);
    assert.deepEqual(hints.mountinfoContainerIds, []);
  });

  it("keeps a containers/<id> that is not a netns file", () => {
    const own = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mountinfo = `${INCIDENT_MOUNTINFO}\n500 468 252:0 /var/lib/docker/containers/${own}/hostname.bak /opt/x rw`;
    const hints = parseSelfProcHints(INCIDENT_CGROUP, mountinfo);
    assert.deepEqual(hints.mountinfoContainerIds, [own]);
  });
});

describe("containerLooksLikeRunner", () => {
  it("rejects the Tailscale sidecar by name, image, and containerboot", () => {
    assert.equal(
      containerLooksLikeRunner({
        name: "zakura-ts-rngaixl02ubkaq32",
        image: "tailscale/tailscale:latest",
        cmd: ["/usr/local/bin/containerboot"],
      }),
      false,
    );
  });

  it("rejects a sidecar that only has TS_AUTHKEY", () => {
    assert.equal(
      containerLooksLikeRunner({
        name: "custom-ts",
        cmd: ["/usr/local/bin/containerboot"],
        env: ["TS_AUTHKEY=hskey-auth-redacted"],
      }),
      false,
    );
  });

  it("requires a matching runner token when one is supplied", () => {
    assert.equal(
      containerLooksLikeRunner(
        {
          name: "zakura-runner-x",
          image: "sunwuyuan/zakura-runner-dev:latest",
          cmd: ["pnpm", "start"],
          env: ["ZAKURA_RUNNER_TOKEN=other"],
        },
        TOKEN,
      ),
      false,
    );
    assert.equal(
      containerLooksLikeRunner(
        {
          name: "zakura-runner-x",
          image: "sunwuyuan/zakura-runner-dev:latest",
          cmd: ["pnpm", "start"],
          env: [`ZAKURA_RUNNER_TOKEN=${TOKEN}`],
        },
        TOKEN,
      ),
      true,
    );
  });
});

describe("findSelfContainerId", () => {
  const incidentHints = parseSelfProcHints(INCIDENT_CGROUP, INCIDENT_MOUNTINFO);

  it("picks the runner via overlay upperdir, not the sidecar id in mountinfo", async () => {
    assert.equal(incidentHints.overlayUpperId, OVERLAY);
    const id = await findSelfContainerId(tsPlusRunner(), {
      hints: incidentHints,
      hostname: "zakura-rngaixl02ubkaq32",
      // overlay must win even when we cannot consult the runner token
    });
    assert.equal(id, RUNNER_ID);
  });

  it("does not follow HOSTNAME when it is the sidecar's short container id", async () => {
    const id = await findSelfContainerId(tsPlusRunner(), {
      hints: { cgroupId: null, overlayUpperId: null, mountinfoContainerIds: [TS_ID] },
      hostname: TS_ID.slice(0, 12),
      token: TOKEN,
    });
    assert.equal(id, RUNNER_ID);
  });

  it("does not follow a mountinfo containers/<id> that belongs to the sidecar", async () => {
    const id = await findSelfContainerId(tsPlusRunner(), {
      hints: { cgroupId: null, overlayUpperId: null, mountinfoContainerIds: [TS_ID] },
      hostname: "zakura-rngaixl02ubkaq32",
      token: TOKEN,
    });
    assert.equal(id, RUNNER_ID);
  });

  it("matches zakura-runner-<slug> when overlay/cgroup are missing", async () => {
    const id = await findSelfContainerId(tsPlusRunner(), {
      hints: { cgroupId: null, overlayUpperId: null, mountinfoContainerIds: [] },
      hostname: "zakura-rngaixl02ubkaq32",
      token: TOKEN,
      slug: "rngaixl02ubkaq32",
    });
    assert.equal(id, RUNNER_ID);
  });
});

describe("replacement create opts", () => {
  const runner = inspectInfo({
    id: RUNNER_ID,
    name: "zakura-runner-rngaixl02ubkaq32",
    image: "sunwuyuan/zakura-runner-dev:old",
    cmd: ["pnpm", "--filter", "@zakura/runner", "start"],
    entrypoint: ["docker-entrypoint.sh"],
    env: [`ZAKURA_RUNNER_TOKEN=${TOKEN}`],
    networkMode: `container:${TS_ID}`,
    binds: [
      "/var/run/docker.sock:/var/run/docker.sock",
      "/var/zakura/rngaixl02ubkaq32/data:/var/lib/zakura",
    ],
  });

  it("maps zakura-runner-<slug> to zakura-ts-<slug>", () => {
    assert.equal(sidecarNameForRunner("zakura-runner-rngaixl02ubkaq32"), "zakura-ts-rngaixl02ubkaq32");
  });

  it("rewrites container:<id> to container:<sidecar name>", () => {
    assert.equal(
      resolveSharedNetworkMode(`container:${TS_ID}`, () => undefined, "zakura-ts-rngaixl02ubkaq32"),
      "zakura-ts-rngaixl02ubkaq32".replace(/^/, "container:"),
    );
    assert.equal(
      resolveSharedNetworkMode(`container:${TS_ID}`, (id) =>
        id.startsWith(TS_ID.slice(0, 12)) ? "zakura-ts-rngaixl02ubkaq32" : undefined,
      ),
      "container:zakura-ts-rngaixl02ubkaq32",
    );
  });

  it("does not copy Cmd/Entrypoint from the live container", () => {
    const { createOpts } = buildReplacementCreateOpts(
      runner,
      "sunwuyuan/zakura-runner-dev:new",
      "container:zakura-ts-rngaixl02ubkaq32",
    );
    assert.equal(createOpts.Image, "sunwuyuan/zakura-runner-dev:new");
    assert.equal(createOpts.Cmd, undefined);
    assert.equal(createOpts.Entrypoint, undefined);
    assert.equal(createOpts.HostConfig?.NetworkMode, "container:zakura-ts-rngaixl02ubkaq32");
    assert.deepEqual(createOpts.HostConfig?.PortBindings, {});
    assert.equal(createOpts.name, "zakura-runner-rngaixl02ubkaq32");
  });

  it("refuses to build a replacement named zakura-ts-*", () => {
    const ts = inspectInfo({
      id: TS_ID,
      name: "zakura-ts-rngaixl02ubkaq32",
      image: "tailscale/tailscale:latest",
      cmd: ["/usr/local/bin/containerboot"],
      env: ["TS_AUTHKEY=hskey-auth-redacted"],
      devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" }],
    });
    assert.throws(() => assertSafeToRecreate(ts, TOKEN), /sidecar/);
    assert.throws(
      () => buildReplacementCreateOpts(ts, "sunwuyuan/zakura-runner-dev:new", "bridge"),
      /sidecar/,
    );
  });

  it("refuses a container that mounts /dev/net/tun", () => {
    const weird = inspectInfo({
      id: RUNNER_ID,
      name: "zakura-runner-rngaixl02ubkaq32",
      image: "sunwuyuan/zakura-runner-dev:old",
      cmd: ["pnpm", "start"],
      env: [`ZAKURA_RUNNER_TOKEN=${TOKEN}`],
      devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun" }],
    });
    assert.throws(() => assertSafeToRecreate(weird, TOKEN), /tun/);
  });

  it("rejects a replacement that is crash-looping containerboot", () => {
    assert.equal(
      replacementLooksHealthy(
        {
          Name: "/zakura-runner-x",
          State: { Running: true },
          Config: { Cmd: ["/usr/local/bin/containerboot"], Image: "sunwuyuan/zakura-runner-dev:new" },
        },
        "zakura-runner-x",
      ),
      "replacement is running Tailscale containerboot",
    );
    assert.equal(
      replacementLooksHealthy(
        {
          Name: "/zakura-runner-x",
          State: { Running: true },
          Config: { Cmd: ["pnpm", "start"], Image: "sunwuyuan/zakura-runner-dev:new" },
        },
        "zakura-runner-x",
      ),
      null,
    );
  });

  it("runs the recreator as a sibling container with docker.sock, not inside the runner", () => {
    const spec = buildRecreatorContainerSpec(
      "sunwuyuan/zakura-runner-dev:new",
      "console.log(1)",
      "/var/run/docker.sock",
    );
    assert.equal(spec.name, RECREATOR_CONTAINER_NAME);
    assert.notEqual(spec.name, "zakura-runner-rngaixl02ubkaq32");
    assert.equal(spec.HostConfig?.NetworkMode, "none");
    assert.deepEqual(spec.HostConfig?.Binds, ["/var/run/docker.sock:/var/run/docker.sock"]);
    assert.equal(hostDockerSockPath(runner), "/var/run/docker.sock");
  });
});

