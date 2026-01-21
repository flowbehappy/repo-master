export type TomlPrimitive = string | number | boolean;

export type TomlValue = TomlPrimitive | TomlPrimitive[];

export type TomlFlatConfig = Record<string, TomlValue>;

function stripComments(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    // Minimal unescape for common sequences.
    return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return undefined;
}

function splitTopLevelCommaList(raw: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;

    if (ch === "," && !inSingle && !inDouble) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

function parseArray(raw: string): TomlPrimitive[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  const parts = splitTopLevelCommaList(inner)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: TomlPrimitive[] = [];
  for (const p of parts) {
    const v = parseValue(p);
    if (v === undefined) continue;
    if (Array.isArray(v)) continue;
    out.push(v);
  }
  return out;
}

function parseValue(raw: string): TomlValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const asArray = parseArray(trimmed);
  if (asArray) return asArray;

  const asString = parseString(trimmed);
  if (typeof asString === "string") return asString;

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (/^-?\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n)) return n;
  }

  // Support bare strings for simple values (not full TOML spec).
  return trimmed;
}

function normalizeSectionName(sectionRaw: string): string | undefined {
  const inner = sectionRaw.trim();
  if (!inner) return undefined;
  return inner;
}

export function parseTomlToFlatConfig(tomlText: string): TomlFlatConfig {
  const out: TomlFlatConfig = {};
  let currentSection = "";
  let pendingArrayKey: string | undefined;
  let pendingArrayRaw = "";

  const lines = tomlText.split(/\r?\n/g);
  for (const rawLine of lines) {
    const noComments = stripComments(rawLine).trim();
    if (!noComments) continue;

    if (pendingArrayKey) {
      pendingArrayRaw += ` ${noComments}`;
      const done = pendingArrayRaw.trim().endsWith("]");
      if (!done) continue;

      const value = parseValue(pendingArrayRaw);
      if (value !== undefined) out[pendingArrayKey] = value;
      pendingArrayKey = undefined;
      pendingArrayRaw = "";
      continue;
    }

    if (noComments.startsWith("[") && noComments.endsWith("]")) {
      const section = normalizeSectionName(noComments.slice(1, -1));
      currentSection = section ? section : "";
      continue;
    }

    const eq = noComments.indexOf("=");
    if (eq === -1) continue;

    const key = noComments.slice(0, eq).trim();
    const valueRaw = noComments.slice(eq + 1).trim();
    if (!key) continue;

    const fullKey = currentSection ? `${currentSection}.${key}` : key;

    const valueTrimmed = valueRaw.trim();
    if (valueTrimmed.startsWith("[") && !valueTrimmed.endsWith("]")) {
      pendingArrayKey = fullKey;
      pendingArrayRaw = valueTrimmed;
      continue;
    }

    const value = parseValue(valueRaw);
    if (value === undefined) continue;
    out[fullKey] = value;
  }

  return out;
}

export function getString(cfg: TomlFlatConfig, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = cfg[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function getStringArray(cfg: TomlFlatConfig, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const v = cfg[key];
    if (!Array.isArray(v)) continue;
    const values = v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return undefined;
}

export function getNumber(cfg: TomlFlatConfig, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = cfg[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && /^-?\d+$/.test(v.trim())) {
      const n = Number.parseInt(v.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function getBoolean(cfg: TomlFlatConfig, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = cfg[key];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true") return true;
      if (t === "false") return false;
    }
  }
  return undefined;
}
