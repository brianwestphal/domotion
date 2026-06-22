/**
 * asciinema v2 `.cast` parser (DM-1225).
 *
 * The format (https://docs.asciinema.org/manual/asciicast/v2/) is newline-
 * delimited JSON: the FIRST line is a header object, every subsequent line is a
 * 3-element event array `[time, code, data]`. We keep output events
 * (`code === "o"`) and resize events (`code === "r"`, data `"<cols>x<rows>"`);
 * input (`"i"`) and marker (`"m"`) events are ignored for replay. Resize events
 * let a recording that changes terminal size mid-session replay faithfully
 * (DM-1246): the full-frame builder applies each resize to the emulator at its
 * timestamp and the canvas is sized to the largest grid seen.
 *
 * `time` is seconds-since-start (a float). We keep it as-is; the frame builder
 * derives per-frame durations from the gaps between settle points.
 */

export interface CastHeader {
  version: number;
  /** Terminal width in columns. */
  width: number;
  /** Terminal height in rows. */
  height: number;
  /** Optional human title. */
  title?: string;
}

export interface CastOutputEvent {
  /** Seconds since recording start. */
  time: number;
  /** Raw terminal output bytes (already decoded to a JS string by the recorder). */
  data: string;
}

/** A mid-session terminal resize (`"r"` event, DM-1246). */
export interface CastResizeEvent {
  /** Seconds since recording start. */
  time: number;
  /** New terminal width in columns. */
  cols: number;
  /** New terminal height in rows. */
  rows: number;
}

export interface ParsedCast {
  header: CastHeader;
  events: CastOutputEvent[];
  /** Mid-session resize events, in recording order (DM-1246). Empty for the
   *  common fixed-size recording. */
  resizes: CastResizeEvent[];
  /** Total recording duration in seconds (the last event's time, or 0). */
  duration: number;
}

/**
 * Parse an asciinema v2 cast document. Throws on a missing/garbled header or a
 * version that isn't 2; tolerates blank lines and skips non-output events.
 */
export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n");
  let headerLine = "";
  let firstEventIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    headerLine = lines[i];
    firstEventIdx = i + 1;
    break;
  }
  if (headerLine === "") throw new Error("cast: empty input — no header line");

  let header: CastHeader;
  try {
    const raw = JSON.parse(headerLine) as Partial<CastHeader>;
    if (raw.version !== 2) throw new Error(`cast: unsupported version ${raw.version} (only v2 is supported)`);
    if (typeof raw.width !== "number" || typeof raw.height !== "number") {
      throw new Error("cast: header is missing numeric width/height");
    }
    header = { version: 2, width: raw.width, height: raw.height, title: raw.title };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("cast:")) throw e;
    throw new Error(`cast: header line is not valid JSON: ${(e as Error).message}`);
  }

  const events: CastOutputEvent[] = [];
  const resizes: CastResizeEvent[] = [];
  for (let i = firstEventIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      // A truncated trailing line (recording cut off mid-write) — stop cleanly.
      break;
    }
    if (!Array.isArray(ev) || ev.length < 3) continue;
    const [time, code, data] = ev as [number, string, string];
    if (typeof time !== "number" || typeof data !== "string") continue;
    if (code === "o") {
      events.push({ time, data });
    } else if (code === "r") {
      // Resize data is `"<cols>x<rows>"` (e.g. `"80x24"`).
      const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(data);
      if (m != null) resizes.push({ time, cols: +m[1], rows: +m[2] });
    }
    // input ("i") + marker ("m") events are not replayable; ignore.
  }

  // Duration is the timestamp of the last event of ANY kind we kept.
  const lastOut = events.length > 0 ? events[events.length - 1].time : 0;
  const lastResize = resizes.length > 0 ? resizes[resizes.length - 1].time : 0;
  const duration = Math.max(lastOut, lastResize);
  return { header, events, resizes, duration };
}
