import path from "node:path";

import type { AppConfig, RepoTarget } from "../config.js";

function wordBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

type MajorMinor = { major: number; minor: number; raw: string };

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function defaultVariant(repos: RepoTarget[]): RepoTarget {
  const master = repos.find((r) => normalizeName(r.variant) === "master");
  if (master) return master;
  const main = repos.find((r) => normalizeName(r.variant) === "main");
  if (main) return main;
  return repos[0]!;
}

function matchesVariant(textLower: string, variant: string): boolean {
  const v = variant.trim().toLowerCase();
  if (!v) return false;
  if (textLower.includes(v)) return true;

  // If the variant looks like "v8.5", also match "8.5".
  const withoutV = v.startsWith("v") ? v.slice(1) : "";
  if (withoutV && /^\d+(\.\d+)+$/.test(withoutV) && textLower.includes(withoutV)) return true;

  return false;
}

function compareMajorMinor(a: MajorMinor, b: MajorMinor): number {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

function parseLikelyTidbVersion(text: string): MajorMinor | undefined {
  const candidates: Array<{ v: MajorMinor; score: number }> = [];

  const re = /(?:\bv)?(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0] ?? "";
    const major = Number.parseInt(m[1] ?? "", 10);
    const minor = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) continue;
    if (major <= 0 || minor < 0) continue;
    if (major > 50) continue;

    const start = m.index ?? 0;
    const end = start + raw.length;
    const before = text.slice(Math.max(0, start - 24), start).toLowerCase();
    const after = text.slice(end, Math.min(text.length, end + 24)).toLowerCase();

    let score = 0;
    if (raw.toLowerCase().startsWith("v")) score += 3;
    if (/\b(version|ver|release|tidb|ticdc|tiflow|tikv|tiflash|pd|cdc|dm)\b/.test(`${before} ${after}`)) score += 2;

    // Heuristic: if immediately followed by ".<digit>", it's likely an IP address (x.y.z.w).
    const nextChar = text[end];
    const nextNext = text[end + 1];
    if (nextChar === "." && typeof nextNext === "string" && /\d/.test(nextNext)) score -= 4;

    if (score <= 0) continue;
    candidates.push({ v: { major, minor, raw }, score });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.score - a.score || compareMajorMinor(b.v, a.v));
  return candidates[0]!.v;
}

function isCdcRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return /\bcdc\b/.test(lower) || /\bchangefeed(s)?\b/.test(lower) || /\bticdc\b/.test(lower);
}

function isDmRelated(text: string): boolean {
  const lower = text.toLowerCase();
  if (wordBoundaryRegex("dm").test(text)) return true;
  return /\bdata\s+migration\b/.test(lower) || /\bdata-migration\b/.test(lower) || /\btiflow\b/.test(lower);
}

function classifyCdcArchitecture(text: string): "new" | "old" | undefined {
  const lower = text.toLowerCase();
  const hasNew =
    /\bnew\s+architecture\b/.test(lower) ||
    /\bnew\s+arch\b/.test(lower) ||
    /\bnew\s+pipeline\b/.test(lower) ||
    /\bnew\s+framework\b/.test(lower) ||
    /新架构/.test(text);
  const hasOld =
    /\bold\s+architecture\b/.test(lower) ||
    /\bold\s+arch\b/.test(lower) ||
    /\blegacy\b/.test(lower) ||
    /\blegacy\s+architecture\b/.test(lower) ||
    /旧架构/.test(text) ||
    /老架构/.test(text);

  if (hasNew && !hasOld) return "new";
  if (hasOld && !hasNew) return "old";
  return undefined;
}

function deriveAliases(repoName: string): string[] {
  const name = normalizeName(repoName);
  const out = new Set<string>();
  if (name) out.add(name);

  // Common TiDB repo prefixes.
  if (name.startsWith("ti") && name.length >= 5) {
    const suffix = name.slice(2);
    // Avoid extremely generic short aliases like "db" or "kv".
    if (suffix.length >= 3 && suffix !== "db" && suffix !== "kv") out.add(suffix);
  }

  // A few ecosystem-specific aliases.
  if (name === "ticdc") {
    out.add("cdc");
    out.add("changefeed");
  }
  if (name === "tiflow") {
    out.add("dm");
    out.add("data migration");
    out.add("data-migration");
  }
  if (name === "pd") {
    out.add("placement driver");
    out.add("placement-driver");
  }

  return Array.from(out);
}

function extractMentionedRepoNames(opts: { text: string; repos: RepoTarget[] }): Set<string> {
  const textLower = opts.text.toLowerCase();
  const mentioned = new Set<string>();

  const byName = new Map<string, RepoTarget[]>();
  for (const r of opts.repos) {
    const k = normalizeName(r.name);
    if (!k) continue;
    const list = byName.get(k) ?? [];
    list.push(r);
    byName.set(k, list);
  }

  for (const [nameLower, group] of byName.entries()) {
    const aliases = deriveAliases(group[0]!.name);
    for (const alias of aliases) {
      if (!alias) continue;

      const hit =
        alias.length <= 2
          ? wordBoundaryRegex(alias).test(opts.text)
          : alias.includes(" ")
            ? textLower.includes(alias)
            : wordBoundaryRegex(alias).test(opts.text);

      if (hit) {
        mentioned.add(nameLower);
        break;
      }
    }
  }

  return mentioned;
}

export function selectReposForSearch(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
}): RepoTarget[] {
  if (opts.config.repos.length === 0) return [];

  const combined = `${opts.question}\n\n${opts.transcript}`.trim();
  const combinedLower = combined.toLowerCase();

  const byName = new Map<string, RepoTarget[]>();
  for (const r of opts.config.repos) {
    const nameLower = normalizeName(r.name);
    if (!nameLower) continue;
    const list = byName.get(nameLower) ?? [];
    list.push({ ...r, path: path.resolve(r.path) });
    byName.set(nameLower, list);
  }

  const mentionedNames = extractMentionedRepoNames({ text: combined, repos: opts.config.repos });

  // Domain knowledge: CDC new architecture lives in TiCDC (v8.5+),
  // CDC old architecture and DM live in TiFlow.
  const hasTicdc = byName.has("ticdc");
  const hasTiflow = byName.has("tiflow");
  const cdc = isCdcRelated(combined);
  const dm = isDmRelated(combined);
  const arch = classifyCdcArchitecture(combined);
  const version = parseLikelyTidbVersion(combined);
  const v85: MajorMinor = { major: 8, minor: 5, raw: "v8.5" };
  const versionCmp = version ? compareMajorMinor(version, v85) : undefined;

  const explicitTicdc = wordBoundaryRegex("ticdc").test(combined);
  const explicitTiflow = wordBoundaryRegex("tiflow").test(combined);

  if (dm && hasTiflow) mentionedNames.add("tiflow");

  if (cdc && (hasTicdc || hasTiflow)) {
    const wantsOld =
      arch === "old" ||
      explicitTiflow ||
      dm ||
      (typeof versionCmp === "number" && versionCmp < 0);
    const wantsNew =
      arch === "new" ||
      explicitTicdc ||
      (typeof versionCmp === "number" && versionCmp >= 0);

    if (wantsOld && hasTiflow) mentionedNames.add("tiflow");
    if (wantsNew && hasTicdc) mentionedNames.add("ticdc");

    if (!wantsOld && !wantsNew) {
      // Unknown version/architecture: scan both if available.
      if (hasTicdc) mentionedNames.add("ticdc");
      if (hasTiflow) mentionedNames.add("tiflow");
    }
  }

  const wantsAllVariants =
    /\b(all\s+branches|all\s+versions|both\s+branches|all\s+variants)\b/i.test(combined) ||
    /\b(全部分支|所有分支|所有版本)\b/.test(combined);

  const selected: RepoTarget[] = [];
  const add = (repo: RepoTarget) => {
    const abs = path.resolve(repo.path);
    if (selected.some((r) => path.resolve(r.path) === abs)) return;
    selected.push({ ...repo, path: abs });
  };

  const namesToUse = mentionedNames.size > 0 ? Array.from(mentionedNames) : Array.from(byName.keys());

  for (const nameLower of namesToUse) {
    const group = byName.get(nameLower);
    if (!group || group.length === 0) continue;

    if (wantsAllVariants) {
      for (const repo of group) add(repo);
      continue;
    }

    const matched = group.filter((r) => matchesVariant(combinedLower, r.variant));
    if (matched.length > 0) {
      for (const repo of matched) add(repo);
      continue;
    }

    add(defaultVariant(group));
  }

  return selected;
}
