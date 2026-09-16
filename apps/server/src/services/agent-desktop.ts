import type { Agent } from "../db/schema.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import { pngDimensions } from "./agent-screenshot.js";

export const DESKTOP_DISPLAY = ":99";
const coordinateSpace = "desktop pixels (DISPLAY=:99), origin at top-left; use the latest screenshot dimensions";
type Workspace = Pick<AgentWorkspaceService, "execInWorkspace" | "ensureStarted">;
type A11yHandle = { bus: string; path: string; signature: string };
type A11yNode = {
  handle: A11yHandle; depth: number; role: string; name: string; text: string;
  actions: string[]; enabled: boolean; focusable: boolean; focused: boolean;
  editable: boolean; showing: boolean; selected: boolean; checked: boolean;
};
type A11ySnapshot = {
  session: string; context: {
    name: string; applications: string[];
    activeWindow: { role: string; name: string } | null;
    focusedElement: { role: string; name: string } | null;
  }; items: A11yNode[];
  truncated: boolean; warnings: string[];
};
type SnapshotRefs = { session: string; expires: number; nodes: Map<string, A11yHandle> };
type DesktopState = { snapshot?: SnapshotRefs; pending?: Promise<unknown>; lastUsed: number };
const desktopStates = new WeakMap<Workspace, { agents: Map<string, DesktopState>; nextRef: number }>();
const REF_TTL_MS = 5 * 60_000;
const refreshSnapshot = "Run computer_observe observe=snapshot again.";

/** Keep observations and input ordered, including parallel calls in a tool batch. */
async function serialDesktop<T>(workspace: Workspace, agent: Agent, operation: (state: DesktopState, nextRef: () => string) => Promise<T>): Promise<T> {
  let owner = desktopStates.get(workspace);
  if (!owner) desktopStates.set(workspace, owner = { agents: new Map(), nextRef: 0 });
  for (const [key, state] of owner.agents) {
    if (!state.pending && state.lastUsed + REF_TTL_MS < Date.now()) owner.agents.delete(key);
  }
  const key = JSON.stringify([agent.tenantId, agent.id, agent.runtimeNodeId]);
  let state = owner.agents.get(key);
  if (!state) owner.agents.set(key, state = { lastUsed: Date.now() });
  const current = state;
  const counter = owner;
  const pending = (current.pending ?? Promise.resolve()).catch(() => undefined)
    .then(() => operation(current, () => `e${++counter.nextRef}`));
  current.pending = pending;
  try { return await pending; }
  finally {
    if (current.pending === pending) current.pending = undefined;
    current.lastUsed = Date.now();
  }
}

const xdotoolScript = `set -eu
command -v xdotool >/dev/null 2>&1 || { echo 'Desktop input unavailable: missing xdotool' >&2; exit 127; }
exec xdotool "$@"`;

async function execDesktop(workspace: Workspace, agent: Agent, command: string[]) {
  const result = await workspace.execInWorkspace(agent, ["timeout", "--signal=TERM", "--kill-after=2s", "25s", ...command], {
    env: { DISPLAY: DESKTOP_DISPLAY },
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Desktop command failed (DISPLAY=${DESKTOP_DISPLAY}, exit ${result.exitCode}). Check that the computer display is ready.\n${result.stderr || result.stdout}`.slice(0, 2500));
  }
  return result;
}

function xdotool(args: string[]): string[] {
  // Positional arguments preserve newlines, quotes, dollars and backticks literally.
  return ["bash", "-c", xdotoolScript, "zakura-desktop", ...args];
}

export async function desktopGeometry(workspace: Workspace, agent: Agent) {
  const result = await execDesktop(workspace, agent, xdotool(["getdisplaygeometry"]));
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) {
    throw new Error(`Cannot read desktop dimensions on DISPLAY=${DESKTOP_DISPLAY}; check Xvfb and xdotool.`);
  }
  return { width: Number(match[1]), height: Number(match[2]), display: DESKTOP_DISPLAY, coordinateSpace };
}

export async function captureDesktop(workspace: Workspace, agent: Agent, prepared = false) {
  if (!prepared) await workspace.ensureStarted(agent, { require: "display" });
  const result = await execDesktop(workspace, agent, ["bash", "-c", `set -eu
shot_dir=$(mktemp -d /tmp/zakura-shot.XXXXXX)
trap 'rm -rf "$shot_dir"' EXIT
shot="$shot_dir/screen.png"
captured=0
available=0
if command -v scrot >/dev/null 2>&1; then
  available=1
  if scrot -o "$shot" >/dev/null && [ -s "$shot" ]; then captured=1; fi
fi
if [ "$captured" = 0 ] && command -v import >/dev/null 2>&1; then
  available=1
  rm -f "$shot"
  if import -window root "$shot" >/dev/null && [ -s "$shot" ]; then captured=1; fi
fi
if [ "$captured" = 0 ] && command -v xwd >/dev/null 2>&1 && command -v convert >/dev/null 2>&1; then
  available=1
  rm -f "$shot"
  if xwd -root -silent -out "$shot_dir/screen.xwd" && convert "$shot_dir/screen.xwd" "$shot" >/dev/null && [ -s "$shot" ]; then captured=1; fi
fi
if [ "$available" = 0 ]; then
  echo 'Screenshot unavailable: install scrot, ImageMagick import, or xwd + convert in the computer workspace.' >&2
  exit 127
fi
if [ "$captured" = 0 ]; then
  echo 'Screenshot failed on DISPLAY=:99. Check Xvfb/display readiness and screenshot backend errors above.' >&2
  exit 1
fi
base64 "$shot"`]);
  const base64Full = result.stdout.replace(/\s+/g, "");
  return { base64Full, ...pngDimensions(base64Full), display: DESKTOP_DISPLAY, coordinateSpace };
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

async function accessibility<T>(workspace: Workspace, agent: Agent, command: "snapshot" | "resolve", args: Record<string, unknown>): Promise<T> {
  const result = await execDesktop(workspace, agent, ["bash", "-c", `set -eu
helper=""
if command -v zakura-desktop-a11y >/dev/null 2>&1; then
  helper=$(command -v zakura-desktop-a11y)
elif [ -x /usr/local/bin/zakura-desktop-a11y ]; then
  helper=/usr/local/bin/zakura-desktop-a11y
elif [ -f /usr/local/bin/zakura-desktop-a11y ]; then
  helper="python3 /usr/local/bin/zakura-desktop-a11y"
fi
if [ -z "$helper" ]; then
  echo 'Desktop accessibility unavailable: missing zakura-desktop-a11y. Pull/recreate the full workspace image (sunwuyuan/zakura-workspace-dev:debian or ZAKURA_WORKSPACE_IMAGE), not the lite image; use computer_observe observe=screenshot for coordinates.' >&2
  exit 127
fi
exec $helper "$@"`, "zakura-a11y", command, JSON.stringify(args)]);
  try { return JSON.parse(result.stdout) as T; }
  catch { throw new Error(`Invalid response from the desktop AT-SPI helper. ${refreshSnapshot}`); }
}

export async function observeDesktop(workspace: Workspace, agent: Agent, args: Record<string, unknown>) {
  const observe = args.observe ?? "snapshot";
  if (observe !== "snapshot" && observe !== "screenshot") throw new Error("observe must be snapshot or screenshot");
  const maxNodes = integer(args.max_nodes ?? 300, "max_nodes", 1, 500);
  return serialDesktop(workspace, agent, async (state, nextRef): Promise<Record<string, unknown>> => {
    if (observe === "screenshot") return captureDesktop(workspace, agent);
    // Even a failed new snapshot retires the old refs; never silently reuse them.
    state.snapshot = undefined;
    await workspace.ensureStarted(agent, { require: "display" });
    const geometry = await desktopGeometry(workspace, agent);
    const raw = await accessibility<A11ySnapshot>(workspace, agent, "snapshot", { maxNodes });
    if (!raw || typeof raw.session !== "string" || !Array.isArray(raw.items) || !Array.isArray(raw.warnings) ||
        !raw.context || typeof raw.context.name !== "string" || !Array.isArray(raw.context.applications) ||
        raw.items.some((node) => !node || typeof node.name !== "string" || typeof node.role !== "string" || typeof node.text !== "string" ||
          !Number.isInteger(node.depth) || node.depth < 0 || !Array.isArray(node.actions) || node.actions.some((action) => typeof action !== "string") ||
          !node.handle || typeof node.handle.bus !== "string" || typeof node.handle.path !== "string" || typeof node.handle.signature !== "string")) {
      throw new Error(`Invalid desktop accessibility snapshot. ${refreshSnapshot}`);
    }
    const nodes = new Map<string, A11yHandle>();
    const items: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    const summarize = (node: { role: string; name: string } | null) => node ? { role: String(node.role).slice(0, 80), name: String(node.name).slice(0, 200) } : null;
    const result = {
      ...geometry, backend: "at-spi", context: {
        name: raw.context.name.slice(0, 200),
        applications: raw.context.applications.slice(0, 12).map((name) => String(name).slice(0, 120)),
        applicationsTruncated: raw.context.applications.length > 12,
        activeWindow: summarize(raw.context.activeWindow), focusedElement: summarize(raw.context.focusedElement),
      },
      count: 0, truncated: raw.truncated || raw.items.length > maxNodes, warnings: raw.warnings.slice(0, 8).map((warning) => String(warning).slice(0, 300)),
      refsExpireInMs: REF_TTL_MS,
      snapshot: "", items,
    };
    // Leave room below cloud-agent's 12k text limit for image metadata. Truncate
    // whole nodes, not JSON or ref lines, so every returned ref remains usable.
    for (const node of raw.items.slice(0, maxNodes)) {
      const ref = nextRef();
      const flags = [!node.enabled && "disabled", node.focusable && "focusable", node.focused && "focused", node.editable && "editable", node.selected && "selected", node.checked && "checked"]
        .filter(Boolean).join(", ");
      const line = `${"  ".repeat(Math.min(node.depth, 12))}${ref} [${node.role}] ${JSON.stringify(node.name)}${flags ? ` (${flags})` : ""}${node.actions.length ? ` actions=${node.actions.map((action) => JSON.stringify(action)).join(",")}` : ""}${node.text ? ` text=${JSON.stringify(node.text)}` : ""}`;
      const item = { ref, role: node.role, name: node.name, focusable: node.focusable, actions: node.actions };
      items.push(item);
      const snapshot = [...lines, line].join("\n");
      if (JSON.stringify({ ...result, snapshot }, null, 2).length > 10_000) {
        items.pop();
        result.truncated = true;
        result.warnings.push("Snapshot output limit reached; omitted nodes have no refs. Use a screenshot for omitted controls.");
        break;
      }
      lines.push(line);
      nodes.set(ref, node.handle);
    }
    result.snapshot = lines.join("\n");
    result.count = items.length;
    state.snapshot = { session: raw.session, expires: Date.now() + REF_TTL_MS, nodes };
    if (args.screenshot === true) {
      try { return { ...result, ...await captureDesktop(workspace, agent, true) }; }
      catch (err) {
        result.warnings.push(`Snapshot succeeded, but screenshot failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 800));
      }
    }
    return result;
  });
}

export async function desktopAction(workspace: Workspace, agent: Agent, name: string, args: Record<string, unknown>) {
  return serialDesktop(workspace, agent, async (state) => {
    try { return await performDesktopAction(workspace, agent, name, args, state); }
    catch (err) {
      // A timeout/disconnect may have happened after input. Never replay input.
      state.snapshot = undefined;
      throw err;
    }
  });
}

async function performDesktopAction(workspace: Workspace, agent: Agent, name: string, args: Record<string, unknown>, state: DesktopState) {
  await workspace.ensureStarted(agent, { require: "display" });
  const geometry = await desktopGeometry(workspace, agent);
  const point = (x: unknown, y: unknown) => [
    String(integer(x, "x", 0, geometry.width - 1)),
    String(integer(y, "y", 0, geometry.height - 1)),
  ];
  let method = "xdotool";
  const resolve = async (refs: unknown[], mode: "point" | "click" | "focus" | "type" = "point") => {
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.expires <= Date.now()) throw new Error(`Desktop refs are stale or missing. ${refreshSnapshot}`);
    const targets = refs.map((ref) => {
      if (typeof ref !== "string" || !/^e[1-9]\d*$/.test(ref) || !snapshot.nodes.has(ref)) {
        throw new Error(`Unknown desktop ref. ${refreshSnapshot}`);
      }
      return snapshot.nodes.get(ref)!;
    });
    let result: { handled?: boolean; typed?: boolean; method: string; points?: Array<{ x: number; y: number }> };
    try {
      result = await accessibility(workspace, agent, "resolve", { session: snapshot.session, targets, mode, width: geometry.width, height: geometry.height, ...(mode === "type" ? { text: args.text } : {}) });
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)} ${refreshSnapshot} The action may have partially completed; observe before repeating it.`);
    }
    if (!result || (result.handled !== true && (!Array.isArray(result.points) || result.points.length !== refs.length)) || (mode === "point" && result.handled)) {
      throw new Error(`Invalid desktop ref resolution. ${refreshSnapshot}`);
    }
    method = result.method;
    return result;
  };
  const targetPoint = async () => {
    if (args.ref === undefined) return point(args.x, args.y);
    const resolved = await resolve([args.ref]);
    return point(resolved.points![0]!.x, resolved.points![0]!.y);
  };
  let command: string[] | undefined;
  switch (name) {
    case "computer_click": {
      const buttons = { left: "1", middle: "2", right: "3" };
      const button = args.button ?? "left";
      if (typeof button !== "string" || !Object.hasOwn(buttons, button)) throw new Error("button must be left, middle or right");
      let coordinates: string[];
      if (args.ref !== undefined) {
        const resolved = await resolve([args.ref], button === "left" && args.double !== true ? "click" : "point");
        if (resolved.handled) break;
        coordinates = point(resolved.points![0]!.x, resolved.points![0]!.y);
      } else coordinates = point(args.x, args.y);
      command = xdotool(["mousemove", ...coordinates, "click", "--clearmodifiers", "--repeat", args.double === true ? "2" : "1", "--delay", "100", buttons[button as keyof typeof buttons]]);
      break;
    }
    case "computer_type": {
      if (typeof args.text !== "string" || args.text.length > 4000 || args.text.includes("\0")) throw new Error("text must be a string of at most 4000 characters without NUL bytes");
      let focus: string[] = [];
      if (args.ref !== undefined) {
        const resolved = await resolve([args.ref], "type");
        if (!resolved.handled) throw new Error(`Desktop ref could not be focused; no text was sent. ${refreshSnapshot}`);
        if (resolved.typed === true) break;
      } else if (args.x !== undefined || args.y !== undefined) focus = ["mousemove", ...point(args.x, args.y), "click", "--clearmodifiers", "1"];
      command = xdotool([...focus, "type", "--clearmodifiers", "--delay", "1", "--", args.text]);
      break;
    }
    case "computer_key":
      if (typeof args.key !== "string" || !/^[a-zA-Z0-9_+]+$/.test(args.key) || args.key.length > 100) throw new Error("key must be an xdotool key or combination, e.g. Return or ctrl+c");
      if (args.ref !== undefined && !(await resolve([args.ref], "focus")).handled) throw new Error(`Desktop ref could not be focused; no key was sent. ${refreshSnapshot}`);
      command = xdotool(["key", "--clearmodifiers", args.key]);
      break;
    case "computer_scroll": {
      const dy = integer(args.dy, "dy", -20, 20);
      const coordinates = await targetPoint();
      if (dy) command = xdotool(["mousemove", ...coordinates, "click", "--repeat", String(Math.abs(dy)), "--delay", "40", dy > 0 ? "5" : "4"]);
      break;
    }
    case "computer_move":
      command = xdotool(["mousemove", ...await targetPoint()]);
      break;
    case "computer_drag": {
      const duration = integer(args.duration_ms ?? 500, "duration_ms", 100, 2000);
      let start = args.ref === undefined ? point(args.x, args.y) : undefined;
      let end = args.to_ref === undefined ? point(args.to_x, args.to_y) : undefined;
      const refs = [args.ref, args.to_ref].filter((ref) => ref !== undefined);
      if (refs.length) {
        const resolved = await resolve(refs);
        const points = resolved.points!.map(({ x, y }) => point(x, y));
        if (!start) start = points.shift()!;
        if (!end) end = points.shift()!;
      }
      const from = start!.map(Number);
      const to = end!.map(Number);
      const moves = Array.from({ length: 10 }, (_, i) => {
        const x = Math.round(from[0]! + (to[0]! - from[0]!) * (i + 1) / 10);
        const y = Math.round(from[1]! + (to[1]! - from[1]!) * (i + 1) / 10);
        return `xdotool mousemove ${x} ${y}\nsleep ${duration / 10_000}`;
      });
      // Always release the button, including on failure partway through a drag.
      command = ["bash", "-c", `set -eu\ntrap 'xdotool mouseup 1' EXIT\nxdotool mousemove ${from.join(" ")} mousedown 1\n${moves.join("\n")}`];
      break;
    }
    case "computer_wait": {
      const timeout = integer(args.timeout ?? 500, "timeout", 1, 10_000);
      await new Promise((resolve) => setTimeout(resolve, timeout));
      break;
    }
    default: throw new Error(`Unknown desktop action: ${name}`);
  }
  if (command) await execDesktop(workspace, agent, command);
  let observation;
  if (args.screenshot === true) {
    try {
      observation = await captureDesktop(workspace, agent, true);
    } catch (err) {
      throw new Error(`${name} completed, but its screenshot failed. Observe the desktop before repeating the action. ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ok: true,
    method: command && method !== "xdotool" ? `${method}+xdotool` : method,
    ...geometry,
    ...observation,
  };
}
