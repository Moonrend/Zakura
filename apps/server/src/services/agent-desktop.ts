import type { Agent } from "../db/schema.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import { pngDimensions } from "./agent-screenshot.js";

export const DESKTOP_DISPLAY = ":99";
const coordinateSpace = "desktop pixels (DISPLAY=:99), origin at top-left; use the latest screenshot dimensions";
type Workspace = Pick<AgentWorkspaceService, "execInWorkspace" | "ensureStarted">;

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

export async function desktopAction(workspace: Workspace, agent: Agent, name: string, args: Record<string, unknown>) {
  await workspace.ensureStarted(agent, { require: "display" });
  const geometry = await desktopGeometry(workspace, agent);
  const point = (x: unknown, y: unknown) => [
    String(integer(x, "x", 0, geometry.width - 1)),
    String(integer(y, "y", 0, geometry.height - 1)),
  ];
  let command: string[] | undefined;
  switch (name) {
    case "computer_click": {
      const buttons = { left: "1", middle: "2", right: "3" };
      const button = args.button ?? "left";
      if (typeof button !== "string" || !Object.hasOwn(buttons, button)) throw new Error("button must be left, middle or right");
      command = xdotool(["mousemove", ...point(args.x, args.y), "click", "--clearmodifiers", "--repeat", args.double === true ? "2" : "1", "--delay", "100", buttons[button as keyof typeof buttons]]);
      break;
    }
    case "computer_type":
      if (typeof args.text !== "string" || args.text.length > 4000 || args.text.includes("\0")) throw new Error("text must be a string of at most 4000 characters without NUL bytes");
      command = xdotool(["type", "--clearmodifiers", "--delay", "1", "--", args.text]);
      break;
    case "computer_key":
      if (typeof args.key !== "string" || !/^[a-zA-Z0-9_+]+$/.test(args.key) || args.key.length > 100) throw new Error("key must be an xdotool key or combination, e.g. Return or ctrl+c");
      command = xdotool(["key", "--clearmodifiers", args.key]);
      break;
    case "computer_scroll": {
      const coordinates = point(args.x, args.y);
      const dy = integer(args.dy, "dy", -20, 20);
      if (dy) command = xdotool(["mousemove", ...coordinates, "click", "--repeat", String(Math.abs(dy)), "--delay", "40", dy > 0 ? "5" : "4"]);
      break;
    }
    case "computer_move":
      command = xdotool(["mousemove", ...point(args.x, args.y)]);
      break;
    case "computer_drag": {
      const start = point(args.x, args.y).map(Number);
      const end = point(args.to_x, args.to_y).map(Number);
      const duration = integer(args.duration_ms ?? 500, "duration_ms", 100, 2000);
      const moves = Array.from({ length: 10 }, (_, i) => {
        const x = Math.round(start[0]! + (end[0]! - start[0]!) * (i + 1) / 10);
        const y = Math.round(start[1]! + (end[1]! - start[1]!) * (i + 1) / 10);
        return `xdotool mousemove ${x} ${y}\nsleep ${duration / 10_000}`;
      });
      // Always release the button, including on failure partway through a drag.
      command = ["bash", "-c", `set -eu\ntrap 'xdotool mouseup 1' EXIT\nxdotool mousemove ${start.join(" ")} mousedown 1\n${moves.join("\n")}`];
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
    ...geometry,
    ...observation,
  };
}
