/**
 * Collapse PTY cursor / line-erase sequences so spinner frames overwrite
 * instead of stacking. Incomplete CSI at a chunk boundary is held.
 */
export class PtyFolder {
  private lines: string[] = [];
  private current = "";
  private col = 0;
  private pending = "";

  push(chunk: string): void {
    if (!chunk) return;
    const s = this.pending + chunk;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;

      if (ch === "\x1b") {
        const rest = s.slice(i);
        const csi = rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (csi) {
          this.applyCsi(csi[0]);
          i += csi[0].length;
          continue;
        }
        const osc = rest.match(/^\x1b\][\s\S]*?(?:\x07|\x1b\\)/);
        if (osc) {
          i += osc[0].length;
          continue;
        }
        if (this.shouldHold(rest)) {
          this.pending = rest;
          break;
        }
        if (rest.length >= 3 && (rest[1] === "(" || rest[1] === ")")) {
          i += 3;
          continue;
        }
        i += rest.length >= 2 ? 2 : 1;
        continue;
      }

      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.lines.push(this.current);
        this.current = "";
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\b") {
        if (this.col > 0) this.col -= 1;
        i += 1;
        continue;
      }
      if (ch < " " || ch === "\x7f") {
        i += 1;
        continue;
      }

      const cp = s.codePointAt(i)!;
      const glyph = String.fromCodePoint(cp);
      this.writeGlyph(glyph);
      i += glyph.length;
    }
  }

  text(): string {
    if (this.lines.length === 0) return this.current;
    return `${this.lines.join("\n")}\n${this.current}`;
  }

  compact(maxChars: number, truncMark: string): void {
    const t = this.text();
    if (t.length <= maxChars) return;
    const kept = truncMark + t.slice(t.length - maxChars + truncMark.length);
    const parts = kept.split("\n");
    this.current = parts.pop() ?? "";
    this.lines = parts;
    this.col = this.current.length;
  }

  private writeGlyph(glyph: string): void {
    if (this.col >= this.current.length) {
      this.current += glyph;
    } else {
      const next = this.current.codePointAt(this.col);
      const width = next !== undefined && next > 0xffff ? 2 : 1;
      this.current =
        this.current.slice(0, this.col) + glyph + this.current.slice(this.col + width);
    }
    this.col += glyph.length;
  }

  private applyCsi(seq: string): void {
    const m = /^\x1b\[([0-9;?]*)([@-~])$/.exec(seq);
    if (!m) return;
    const raw = m[1]!;
    const cmd = m[2]!;
    if (raw.includes("?")) return;

    const nums = raw ? raw.split(";").map((p) => Number.parseInt(p, 10) || 0) : [];
    const n = nums[0] ?? 0;

    if (cmd === "G") {
      this.col = Math.max(0, (n || 1) - 1);
      return;
    }
    if (cmd === "H" || cmd === "f") {
      this.col = Math.max(0, ((nums[1] ?? 1) || 1) - 1);
      return;
    }
    if (cmd === "K") {
      if (n === 1) {
        this.current = " ".repeat(this.col) + this.current.slice(this.col);
      } else if (n === 2) {
        this.current = "";
      } else {
        this.current = this.current.slice(0, this.col);
      }
      return;
    }
    if (cmd === "A") {
      const count = Math.max(1, n || 1);
      if (this.current.length > 0 || this.col > 0) {
        this.lines.push(this.current);
        this.current = "";
        this.col = 0;
      }
      for (let k = 0; k < count && this.lines.length > 0; k++) {
        this.current = this.lines.pop()!;
        this.col = 0;
      }
      return;
    }
    if (cmd === "B") {
      const count = Math.max(1, n || 1);
      for (let k = 0; k < count; k++) {
        this.lines.push(this.current);
        this.current = "";
        this.col = 0;
      }
      return;
    }
    if (cmd === "C") {
      this.col += Math.max(1, n || 1);
      if (this.col > this.current.length) this.current = this.current.padEnd(this.col);
      return;
    }
    if (cmd === "D") {
      this.col = Math.max(0, this.col - Math.max(1, n || 1));
    }
  }

  private shouldHold(rest: string): boolean {
    if (rest.length >= 512) return false;
    if (rest.length < 2) return true;
    const kind = rest[1]!;
    if (kind === "[") return !/[@-~]/.test(rest.slice(2));
    if (kind === "]") return !/\x07|\x1b\\/.test(rest);
    if (kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      return !/\x1b\\/.test(rest);
    }
    if (kind === "(" || kind === ")") return rest.length < 3;
    return false;
  }
}

export function foldPtyText(text: string): string {
  const folder = new PtyFolder();
  folder.push(text);
  return folder.text();
}
