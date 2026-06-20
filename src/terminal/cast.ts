/**
 * asciinema v2 `.cast` parser (DM-1225).
 *
 * The format (https://docs.asciinema.org/manual/asciicast/v2/) is newline-
 * delimited JSON: the FIRST line is a header object, every subsequent line is a
 * 3-element event array `[time, code, data]`. We only care about output events
 * (`code === "o"`); input (`"i"`), resize (`"r"`), and marker (`"m"`) events are
 * ignored for replay (a future enhancement could honor `"r"` mid-stream).
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

export interface ParsedCast {
  header: CastHeader;
  events: CastOutputEvent[];
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
    if (code !== "o") continue;
    if (typeof time !== "number" || typeof data !== "string") continue;
    events.push({ time, data });
  }

  const duration = events.length > 0 ? events[events.length - 1].time : 0;
  return { header, events, duration };
}
