import type { McpToolResult } from "@zakura/shared";
import { posix } from "node:path";

export function screenshotPath(path: unknown): string | undefined {
  if (path === undefined) return undefined;
  if (typeof path !== "string" || !path || path.includes("\0") || posix.isAbsolute(path) || path.replace(/\\/g, "/").split("/").includes("..")) {
    throw new Error("path must be a workspace-relative file path without traversal");
  }
  return path;
}

/** Images travel as image content, never as a sliced base64 string. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_SCREENSHOT_TEXT_CHARS = 120_000;
export const screenshotOutputSchema = {
  type: "string",
  enum: ["image", "metadata", "base64"],
  default: "image",
  description: "image returns a complete PNG image plus metadata; metadata omits image bytes; base64 returns complete text only (up to 120000 characters, otherwise use image or save path).",
};

export function screenshotOutput(value: unknown): "image" | "metadata" | "base64" {
  if (value === undefined) return "image";
  if (value === "image" || value === "metadata" || value === "base64") return value;
  throw new Error("output must be image, metadata or base64");
}

export function pngDimensions(base64: string): { width: number; height: number } {
  if (base64.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
    throw new Error("Screenshot exceeds the 8 MiB image limit. Capture the viewport instead of the full page.");
  }
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Screenshot is empty or contains invalid base64; check the capture backend and Runner output limits.");
  }
  const png = Buffer.from(base64, "base64");
  if (
    png.length < 45 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    !png.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
  ) {
    throw new Error("Screenshot is not a complete PNG; check the capture backend and Runner output limits.");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height) throw new Error("Screenshot has invalid dimensions");
  return { width, height };
}

/** Also handles the browser's legacy screenshotBase64Full field. */
export function screenshotResult(data: Record<string, unknown>, output: unknown = "image"): McpToolResult {
  const mode = screenshotOutput(output);
  const { base64Full, screenshotBase64Full, ...metadata } = data;
  const base64 = typeof base64Full === "string" ? base64Full : screenshotBase64Full;
  if (typeof base64 !== "string") {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
  const size = pngDimensions(base64);
  if (mode === "base64" && base64.length > MAX_SCREENSHOT_TEXT_CHARS) {
    throw new Error("Screenshot is too large for base64 text (120000 character limit). Use output=image for the complete image or output=metadata with path to save it. Image bytes were not truncated.");
  }
  const content: McpToolResult["content"] = [{
    type: "text",
    text: JSON.stringify({
      ...metadata,
      ...size,
      format: "png",
      base64Length: base64.length,
      base64Preview: `${base64.slice(0, 120)}… (${base64.length} characters; preview only)`,
      ...(mode === "base64" ? { base64Full: base64 } : {}),
    }, null, 2),
  }];
  if (mode === "image") content.push({ type: "image", data: base64, mimeType: "image/png" });
  return { content };
}
