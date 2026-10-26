#!/usr/bin/env node
/**
 * Local verification:
 * 1) Mock webhook returns HTTP 200 headers then holds the connection open for
 *    HOLD_MS (default 120s). The poller must finish and exit in well under that —
 *    proving we do not await a held body.
 * 2) With an intentional never-cleared timer handle injected via --import, the
 *    poller must still exit (process.exit after main) — proving Actions cannot
 *    hang on leftover keep-alives / sockets.
 *
 * Usage: node scripts/verify-webhook-detach.mjs
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOLD_MS = Number(process.env.HOLD_MS) || 120_000;
const BUDGET_MS = Number(process.env.BUDGET_MS) || 8_000;
const ROOT = resolve(import.meta.dirname, "..");

async function runPoller({ leaveOpenHandle }) {
  const server = http.createServer((req, res) => {
    // Consume request body, then ACK with headers and hold the socket open
    // (Grok Bot shape: fast HTTP 200, connection stays open while routine runs).
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Transfer-Encoding": "chunked",
      });
      res.flushHeaders();
      setTimeout(() => {
        try {
          res.end("late\n");
        } catch {
          /* ignore */
        }
      }, HOLD_MS);
    });
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  const webhookUrl = `http://127.0.0.1:${port}/hook`;

  const dir = await mkdtemp(join(tmpdir(), "dannebrud-rss-"));
  const feedsPath = join(dir, "feeds.json");
  const seenPath = join(dir, "seen.json");
  const preloadPath = join(dir, "leave-open-handle.mjs");

  // Minimal Atom feed with a keyword hit and a recent date.
  const recent = new Date().toISOString();
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Test</title>
  <entry>
    <title>Cyberangreb rammer testvirksomhed</title>
    <link href="https://example.com/incident-detach-test"/>
    <updated>${recent}</updated>
    <summary>Et cyberangreb er konstateret.</summary>
  </entry>
</feed>`;

  const feedServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/atom+xml" });
    res.end(feedXml);
  });
  await new Promise((r) => feedServer.listen(0, "127.0.0.1", r));
  const feedPort = feedServer.address().port;

  await writeFile(
    feedsPath,
    JSON.stringify([{ name: "TestFeed", url: `http://127.0.0.1:${feedPort}/feed.xml` }], null, 2),
  );
  await writeFile(seenPath, `${JSON.stringify({ links: [] }, null, 2)}\n`);

  const nodeArgs = [];
  if (leaveOpenHandle) {
    // Intentional open handle: without process.exit, Node would never exit.
    await writeFile(
      preloadPath,
      `setInterval(() => {}, 1 << 30);\n`,
    );
    nodeArgs.push("--import", preloadPath);
  }
  nodeArgs.push("poll.mjs");

  const started = Date.now();
  const child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      WEBHOOK_URL: webhookUrl,
      WEBHOOK_KEY: "test-key-not-a-secret",
      WEBHOOK_TIMEOUT_MS: "5000",
      FEEDS_PATH: feedsPath,
      SEEN_PATH: seenPath,
      MAX_AGE_HOURS: "48",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });

  const exitCode = await new Promise((resolveExit) => {
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit(124);
    }, BUDGET_MS);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolveExit(code ?? 1);
    });
  });

  const elapsed = Date.now() - started;
  const seenRaw = await readFile(seenPath, "utf8");
  const seen = JSON.parse(seenRaw);

  server.close();
  feedServer.close();
  await rm(dir, { recursive: true, force: true });

  return { exitCode, elapsed, stdout, stderr, seen };
}

function assertResult(label, { exitCode, elapsed, stdout, stderr, seen }) {
  const okExit = exitCode === 0;
  const okFast = elapsed < BUDGET_MS;
  const okSeen =
    Array.isArray(seen.links) &&
    seen.links.includes("https://example.com/incident-detach-test");
  const okLog = /Posted 1 item\(s\) to webhook \(HTTP 200\)/.test(stdout);

  console.log(`--- verify-webhook-detach (${label}) ---`);
  console.log(`elapsed_ms=${elapsed} budget_ms=${BUDGET_MS} hold_ms=${HOLD_MS}`);
  console.log(`exit=${exitCode}`);
  console.log(`stdout:\n${stdout}`);
  if (stderr) console.log(`stderr:\n${stderr}`);
  console.log(JSON.stringify({ okExit, okFast, okSeen, okLog }, null, 2));

  if (!okExit || !okFast || !okSeen || !okLog) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS (${label})`);
}

const detach = await runPoller({ leaveOpenHandle: false });
assertResult("hard-detach held-open webhook", detach);

const forced = await runPoller({ leaveOpenHandle: true });
assertResult("process.exit despite open timer handle", forced);

console.log(
  "PASS: poller detached from held-open webhook, persisted seen.json, and forced exit with open handles",
);
// Force exit — the mock webhook intentionally holds sockets open.
process.exit(0);
