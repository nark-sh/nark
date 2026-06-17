#!/usr/bin/env node
// Reads raw-score.json (produced by `socket package score npm nark --json`),
// extracts the overall score + the 5 category scores, and appends one entry
// to status/history.json in the shape the status page expects.
//
// Socket's CLI JSON shape drifts across versions, so this script tries a few
// known field paths and prints the raw blob if none match. Run locally once
// to validate against the live shape before scheduling the workflow:
//
//   socket package score npm nark --json | jq
//
// If the workflow logs "score is null", check the printed blob and adjust
// pickScore() / pickCategories() below.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const PKG_NAME = process.env.PKG_NAME || "nark";
const PKG_ECOSYSTEM = process.env.PKG_ECOSYSTEM || "npm";
const RAW_PATH = "raw-score.json";
const HISTORY_PATH = "status/history.json";

function pickScore(raw) {
  // Try known shapes in order.
  // Shape A (newer CLI): { score: { overall: 92 } }
  if (typeof raw?.score?.overall === "number") return raw.score.overall;
  // Shape B: { overallScore: 92 }
  if (typeof raw?.overallScore === "number") return raw.overallScore;
  // Shape C: { score: 92 } (flat)
  if (typeof raw?.score === "number") return raw.score;
  // Shape D (markdown variant): { data: { score: 92 } }
  if (typeof raw?.data?.score === "number") return raw.data.score;
  if (typeof raw?.data?.score?.overall === "number") return raw.data.score.overall;
  return null;
}

function pickCategories(raw) {
  // Try known shapes in order.
  // Shape A: { score: { supplyChain: 100, vulnerability: 100, ... } }
  const a = raw?.score;
  if (
    a &&
    typeof a === "object" &&
    typeof a.supplyChain === "number"
  ) {
    return normalize(a);
  }
  // Shape B: { categories: { supplyChain: ..., ... } }
  if (raw?.categories) return normalize(raw.categories);
  // Shape C: { score: { categories: { ... } } }
  if (raw?.score?.categories) return normalize(raw.score.categories);
  // Shape D: { data: { categories: { ... } } }
  if (raw?.data?.categories) return normalize(raw.data.categories);
  return null;
}

function normalize(obj) {
  // Socket sometimes returns floats 0..1, sometimes ints 0..100. Coerce
  // everything to a 0..100 integer so the status page math is consistent.
  const out = {};
  const keys = [
    "supplyChain",
    "vulnerability",
    "quality",
    "maintenance",
    "license",
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== "number") continue;
    out[k] = v <= 1 ? Math.round(v * 100) : Math.round(v);
  }
  return out;
}

function pickAlertCount(raw) {
  if (typeof raw?.alerts === "number") return raw.alerts;
  if (Array.isArray(raw?.alerts)) return raw.alerts.length;
  if (typeof raw?.data?.alerts === "number") return raw.data.alerts;
  if (Array.isArray(raw?.data?.alerts)) return raw.data.alerts.length;
  return null;
}

function pickVersion(raw) {
  return (
    raw?.version ??
    raw?.data?.version ??
    raw?.package?.version ??
    null
  );
}

async function main() {
  const rawText = await readFile(RAW_PATH, "utf8");
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    console.error("Failed to parse raw-score.json:", err.message);
    console.error(rawText.slice(0, 4096));
    process.exit(1);
  }

  const score = pickScore(raw);
  const categories = pickCategories(raw);
  const alerts = pickAlertCount(raw);
  const version = pickVersion(raw);

  if (score === null) {
    console.error("Could not extract score from raw-score.json — field shape unknown.");
    console.error("Raw blob:");
    console.error(JSON.stringify(raw, null, 2).slice(0, 4096));
    process.exit(1);
  }

  let history;
  try {
    const existing = await readFile(HISTORY_PATH, "utf8");
    history = JSON.parse(existing);
  } catch {
    history = {
      package: PKG_NAME,
      ecosystem: PKG_ECOSYSTEM,
      updated: null,
      checks: [],
    };
  }

  const entry = {
    t: new Date().toISOString(),
    version,
    score,
    categories: categories || {},
    alerts,
  };

  history.package = PKG_NAME;
  history.ecosystem = PKG_ECOSYSTEM;
  history.updated = entry.t;
  history.checks.push(entry);

  // Keep the last 365 entries (one year of daily checks) to bound file size.
  if (history.checks.length > 365) {
    history.checks = history.checks.slice(history.checks.length - 365);
  }

  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  console.log(
    `Appended entry: score=${score} version=${version} alerts=${alerts} (checks=${history.checks.length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
