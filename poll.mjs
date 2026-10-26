#!/usr/bin/env node
/**
 * Poll Danish news RSS feeds for cyber-incident keywords and POST new matches
 * to a webhook. Secrets come from env (never logged).
 *
 * Env:
 *   WEBHOOK_URL  — destination URL (required unless DRY_RUN=1)
 *   WEBHOOK_KEY  — panel "key" or full "header" value; normalized to Authorization (required unless DRY_RUN=1)
 *   DRY_RUN      — if set, print matches and skip POST / seen.json write
 *   SEEN_PATH    — path to seen.json (default: ./seen.json)
 *   FEEDS_PATH   — path to feeds.json (default: ./feeds.json)
 *   MAX_AGE_HOURS — skip items older than this when first seen (default: 48)
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Parser from "rss-parser";

const FEEDS_PATH = resolve(process.env.FEEDS_PATH || "feeds.json");
const SEEN_PATH = resolve(process.env.SEEN_PATH || "seen.json");
const MAX_AGE_MS = (Number(process.env.MAX_AGE_HOURS) || 48) * 60 * 60 * 1000;
const DRY_RUN = Boolean(process.env.DRY_RUN);
const MAX_SEEN = 5000;

/** Cyber / security keywords (DA + EN). Matched with Unicode-aware word boundaries. */
const KEYWORDS = [
  "hack",
  "hacker",
  "hackere",
  "hacket",
  "hackede",
  "hacking",
  "cyberangreb",
  "cyberangrebet",
  "cyberangrebene",
  "cyberattack",
  "cyberattacks",
  "cyber attack",
  "cyber-attack",
  "ransomware",
  "databrud",
  "databruddet",
  "datalæk",
  "datalækage",
  "dataleak",
  "data leak",
  "data breach",
  "databreach",
  "ddos",
  "sikkerhedshændelse",
  "sikkerhedshaendelse",
  "sikkerhedsbrud",
  "sikkerhedsbruddet",
  "malware",
  "phishing",
  "zero-day",
  "zeroday",
  "zero day",
  "infosec",
  "cyberkriminalitet",
  "cybercrime",
  "it-sikkerhed",
  "informationssikkerhed",
  "sikkerhedsincident",
  "security incident",
  "security breach",
  "botnet",
  "trojan",
  "spyware",
  "cryptolocker",
  "extortion",
  "afpresning",
];

const parser = new Parser({
  timeout: 20000,
  headers: {
    "User-Agent": "dannebrud-rss/1.0 (+https://github.com/casperstorm/dannebrud-rss)",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  },
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(keyword) {
  const parts = keyword.trim().split(/\s+/).map(escapeRegex);
  const body = parts.join("\\s+");
  // Unicode letter/number aware "word" boundaries (JS \\b is ASCII-only).
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${body}(?=[^\\p{L}\\p{N}]|$)`, "iu");
}

const KEYWORD_RES = KEYWORDS.map(keywordPattern);

function matchesKeywords(text) {
  if (!text) return false;
  const normalized = text.normalize("NFC");
  return KEYWORD_RES.some((re) => re.test(normalized));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(item) {
  const raw = item.isoDate || item.pubDate || item.published || item.updated || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function loadSeen(path) {
  const data = await loadJson(path, { links: [] });
  const links = Array.isArray(data.links) ? data.links : [];
  return new Set(links.filter((x) => typeof x === "string" && x.length > 0));
}

async function saveSeen(path, seen) {
  const links = [...seen].slice(-MAX_SEEN);
  const payload = {
    updatedAt: new Date().toISOString(),
    links,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function summarize(item) {
  const content =
    item.contentSnippet ||
    item.summary ||
    item.content ||
    item.description ||
    "";
  const text = stripHtml(content);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return { feed, items: parsed.items || [], error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // Never include URLs that might embed credentials; feed.url is public.
    console.error(`Feed error [${feed.name}]: ${message}`);
    return { feed, items: [], error: message };
  }
}

function toMatch(feed, item) {
  const link = (item.link || item.guid || "").trim();
  if (!link) return null;

  const title = stripHtml(item.title || "");
  const summary = summarize(item);
  const haystack = `${title}\n${summary}`;
  if (!matchesKeywords(haystack)) return null;

  const date = parseDate(item);
  return {
    feed: feed.name,
    title: title || "(untitled)",
    link,
    date: date ? date.toISOString() : null,
    summary,
    _dateMs: date ? date.getTime() : null,
  };
}

/**
 * Normalize WEBHOOK_KEY into an Authorization header value.
 * Accepts a bare panel key, "Bearer …" / "Basic …", or a full
 * "Authorization: …" line (as copied from the routine panel header field).
 */
function normalizeAuthorization(raw) {
  let value = String(raw ?? "").trim();
  value = value.replace(/^authorization:\s*/i, "").trim();
  if (/^(Bearer|Basic)\s+/i.test(value)) {
    return value;
  }
  return `Bearer ${value}`;
}

async function postWebhook(items) {
  const url = process.env.WEBHOOK_URL;
  const key = process.env.WEBHOOK_KEY;

  if (!url || !key) {
    console.error("Missing WEBHOOK_URL or WEBHOOK_KEY");
    process.exitCode = 1;
    return false;
  }

  const authorization = normalizeAuthorization(key);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "User-Agent": "dannebrud-rss/1.0",
    },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    // Do not log response body (may echo secrets or tokens).
    console.error(`Webhook POST failed: HTTP ${res.status}`);
    process.exitCode = 1;
    return false;
  }

  console.log(`Posted ${items.length} item(s) to webhook (HTTP ${res.status})`);
  return true;
}

async function main() {
  const feeds = await loadJson(FEEDS_PATH, []);
  if (!Array.isArray(feeds) || feeds.length === 0) {
    console.error("No feeds configured");
    process.exitCode = 1;
    return;
  }

  const seen = await loadSeen(SEEN_PATH);
  const firstRun = seen.size === 0;
  const cutoff = Date.now() - MAX_AGE_MS;

  if (firstRun) {
    console.log(
      `seen.json empty — first-run mode: only items newer than ${process.env.MAX_AGE_HOURS || 48}h`,
    );
  }

  console.log(`Polling ${feeds.length} feed(s); ${seen.size} link(s) already seen`);

  const results = await Promise.all(feeds.map(fetchFeed));
  const newMatches = [];
  let scanned = 0;
  let keywordHits = 0;

  for (const { feed, items } of results) {
    for (const item of items) {
      scanned += 1;
      const match = toMatch(feed, item);
      if (!match) continue;
      keywordHits += 1;

      if (seen.has(match.link)) continue;

      if (firstRun && match._dateMs != null && match._dateMs < cutoff) {
        // Mark old matches as seen so we do not flood on first run, but skip POST.
        seen.add(match.link);
        continue;
      }

      if (firstRun && match._dateMs == null) {
        // Undated on first run: treat as too risky to flood — mark seen, skip POST.
        seen.add(match.link);
        continue;
      }

      seen.add(match.link);
      const { _dateMs, ...publicItem } = match;
      newMatches.push(publicItem);
    }
  }

  console.log(
    `Scanned ${scanned} item(s); ${keywordHits} keyword hit(s); ${newMatches.length} new match(es)`,
  );

  if (newMatches.length > 0) {
    for (const m of newMatches) {
      console.log(`  + [${m.feed}] ${m.title}`);
    }
    if (DRY_RUN) {
      console.log("DRY_RUN=1 — skipping webhook POST and seen.json write");
      return;
    }
    const ok = await postWebhook(newMatches);
    if (!ok) return;
  } else {
    console.log("No new matching items — skipping webhook POST");
  }

  if (!DRY_RUN) {
    // Persist all seen links (including first-run skips) so later runs only send truly new ones.
    await saveSeen(SEEN_PATH, seen);
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
