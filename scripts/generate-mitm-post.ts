#!/usr/bin/env npx tsx
/**
 * generate-mitm-post.ts — Infrastructure-side MITM detection tooling.
 *
 * Runs live network probes (mtr, tcpdump, dmesg, dig, openssl, curl),
 * queries flow logs and eBPF instrumentation, then generates analysis
 * with the LLM for the "Infrastructure MITM Investigation" blog series.
 *
 * Must be run on the investigation host (not GitHub Actions) since
 * probes need to originate from the Vyve/Cogent path.
 *
 * Env vars:
 *   AI_PROVIDER        - "anthropic" or "openai" (default: anthropic)
 *   ANTHROPIC_API_KEY   - Required if provider is anthropic
 *   OPENAI_API_KEY      - Required if provider is openai
 *   PROBE_DURATION      - tcpdump capture duration in seconds (default: 30)
 *   MITM_SKIP_PROBES    - set to "1" to use cached probe data (for testing)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runSeries, type SeriesPlugin } from "./series-runner.js";

const MANIFEST_PATH = join(import.meta.dirname, "mitm-manifest.json");
const PROBE_CACHE_DIR = join(import.meta.dirname, "..", ".probe-cache");
const PROBE_DURATION = parseInt(process.env.PROBE_DURATION ?? "30");

interface MitmEntry {
  slug: string;
  probes: string[];
  targets: string[];
  note: string;
  existing: boolean;
}

interface Manifest {
  probeTargets: Record<string, string>;
  files: MitmEntry[];
  completed: string[];
}

// ── Probe runners ──────────────────────────────────────

function ensureCacheDir(): void {
  if (!existsSync(PROBE_CACHE_DIR)) mkdirSync(PROBE_CACHE_DIR, { recursive: true });
}

function resolveTargets(manifest: Manifest, targetKeys: string[]): string[] {
  return targetKeys.map((k) => manifest.probeTargets[k] ?? k);
}

function runMtr(hosts: string[]): string {
  const results: string[] = [];
  for (const host of hosts) {
    console.log(`  MTR → ${host}`);
    try {
      const out = execSync(
        `mtr --report --report-cycles 5 --no-dns ${host} 2>/dev/null`,
        { encoding: "utf-8", timeout: 60_000 }
      );
      results.push(`### MTR to ${host}\n\`\`\`\n${out}\`\`\``);
    } catch {
      results.push(`### MTR to ${host}\n(probe failed or timed out)`);
    }
  }
  return results.join("\n\n");
}

function runTcpdump(hosts: string[], durationSec: number): string {
  const hostFilter = hosts.map((h) => {
    try {
      const ips = execSync(`dig +short ${h} 2>/dev/null`, { encoding: "utf-8" })
        .trim().split("\n").filter(Boolean);
      return ips.map((ip) => `host ${ip}`).join(" or ");
    } catch {
      return `host ${h}`;
    }
  }).filter(Boolean).join(" or ");

  if (!hostFilter) return "(no hosts resolved for tcpdump)";

  console.log(`  tcpdump (${durationSec}s) — filter: ${hostFilter.slice(0, 100)}...`);
  try {
    const out = execSync(
      `timeout ${durationSec} tcpdump -nn -c 5000 '(${hostFilter})' 2>&1 || true`,
      { encoding: "utf-8", timeout: (durationSec + 10) * 1000, maxBuffer: 10 * 1024 * 1024 }
    );
    const lines = out.split("\n");
    const summary = lines.slice(-5).join("\n");
    // Keep first 500 lines + summary for context window
    const capture = lines.slice(0, 500).join("\n");
    return `### tcpdump capture (${durationSec}s, first 500 lines)\n\`\`\`\n${capture}\n\`\`\`\n\n### Capture summary\n\`\`\`\n${summary}\n\`\`\``;
  } catch (e) {
    return `### tcpdump\n(capture failed — may need root: ${e})`;
  }
}

function runDmesg(): string {
  console.log("  dmesg (last 100 lines)");
  try {
    const out = execSync("dmesg --time-format iso | tail -100 2>/dev/null || dmesg | tail -100", {
      encoding: "utf-8", timeout: 5_000,
    });
    return `### dmesg (last 100 lines)\n\`\`\`\n${out}\`\`\``;
  } catch {
    return "### dmesg\n(not available or insufficient permissions)";
  }
}

function runDig(hosts: string[]): string {
  const results: string[] = [];
  for (const host of hosts) {
    console.log(`  dig → ${host}`);
    try {
      // System resolver
      const system = execSync(`dig +short ${host} 2>/dev/null`, { encoding: "utf-8", timeout: 10_000 });
      // Try DoH via Cloudflare
      let doh = "(DoH not available)";
      try {
        doh = execSync(
          `curl -sH 'accept: application/dns-json' 'https://1.1.1.1/dns-query?name=${host}&type=A' 2>/dev/null | head -c 500`,
          { encoding: "utf-8", timeout: 10_000 }
        );
      } catch { /* ok */ }
      results.push(`### DNS: ${host}\nSystem resolver:\n\`\`\`\n${system}\`\`\`\nDoH (1.1.1.1):\n\`\`\`\n${doh}\n\`\`\``);
    } catch {
      results.push(`### DNS: ${host}\n(dig failed)`);
    }
  }
  return results.join("\n\n");
}

function runOpenssl(hosts: string[]): string {
  const results: string[] = [];
  for (const host of hosts) {
    console.log(`  openssl s_client → ${host}`);
    try {
      const out = execSync(
        `echo | openssl s_client -connect ${host}:443 -servername ${host} 2>/dev/null | openssl x509 -text -noout 2>/dev/null | head -40`,
        { encoding: "utf-8", timeout: 10_000 }
      );
      const fp = execSync(
        `echo | openssl s_client -connect ${host}:443 -servername ${host} 2>/dev/null | openssl x509 -fingerprint -sha256 -noout 2>/dev/null`,
        { encoding: "utf-8", timeout: 10_000 }
      );
      results.push(`### TLS cert: ${host}\n\`\`\`\n${out}\n${fp}\`\`\``);
    } catch {
      results.push(`### TLS cert: ${host}\n(openssl probe failed)`);
    }
  }
  return results.join("\n\n");
}

function runCurl(hosts: string[]): string {
  const results: string[] = [];
  for (const host of hosts) {
    console.log(`  curl timing → ${host}`);
    try {
      const out = execSync(
        `curl -so /dev/null -w 'tcp_connect: %{time_connect}s\\ntls_handshake: %{time_appconnect}s\\nfirst_byte: %{time_starttransfer}s\\ntotal: %{time_total}s\\nremote_ip: %{remote_ip}\\nhttp_version: %{http_version}\\n' --connect-timeout 10 'https://${host}/' 2>/dev/null`,
        { encoding: "utf-8", timeout: 15_000 }
      );
      // Try HTTP/3
      let h3 = "(HTTP/3 not attempted)";
      try {
        h3 = execSync(
          `curl -so /dev/null --http3-only -w 'http3_total: %{time_total}s\\nhttp_version: %{http_version}\\n' --connect-timeout 10 'https://${host}/' 2>/dev/null`,
          { encoding: "utf-8", timeout: 15_000 }
        );
      } catch { /* ok */ }
      results.push(`### curl: ${host}\nHTTPS/TCP:\n\`\`\`\n${out}\`\`\`\nHTTP/3 (QUIC):\n\`\`\`\n${h3}\`\`\``);
    } catch {
      results.push(`### curl: ${host}\n(curl failed)`);
    }
  }
  return results.join("\n\n");
}

function runFlowLog(): string {
  const flowLog = join(process.env.HOME ?? "/home/compturerstore", "process-net-monitor/logs/current.jsonl");
  console.log("  flowlog analysis");
  try {
    const raw = readFileSync(flowLog, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const total = lines.length;
    // Extract last 500 lines + summary stats
    const recent = lines.slice(-500).join("\n");
    // Count unique remote IPs and processes
    const ips = new Set<string>();
    const procs = new Set<string>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.remote_ip) ips.add(obj.remote_ip);
        if (obj.process) procs.add(obj.process);
      } catch { /* skip malformed */ }
    }
    return `### Flow log summary\nTotal records: ${total}\nUnique remote IPs: ${ips.size}\nUnique processes: ${procs.size}\n\n### Last 500 flow records\n\`\`\`json\n${recent}\n\`\`\``;
  } catch (e) {
    return `### Flow log\n(not available: ${e})`;
  }
}

function runEbpf(hosts: string[]): string {
  const results: string[] = [];

  // tcpretrans — TCP retransmissions (proxy-induced state issues)
  console.log("  ebpf: tcpretrans (10s sample)");
  try {
    const out = execSync(
      "timeout 10 tcpretrans-bpfcc 2>/dev/null || timeout 10 /usr/share/bcc/tools/tcpretrans 2>/dev/null || echo '(tcpretrans not available)'",
      { encoding: "utf-8", timeout: 15_000 }
    );
    results.push(`### eBPF: tcpretrans (10s)\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``);
  } catch { results.push("### eBPF: tcpretrans\n(failed — may need root)"); }

  // tcpdrop — dropped TCP packets
  console.log("  ebpf: tcpdrop (10s sample)");
  try {
    const out = execSync(
      "timeout 10 tcpdrop-bpfcc 2>/dev/null || timeout 10 /usr/share/bcc/tools/tcpdrop 2>/dev/null || echo '(tcpdrop not available)'",
      { encoding: "utf-8", timeout: 15_000 }
    );
    results.push(`### eBPF: tcpdrop (10s)\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``);
  } catch { results.push("### eBPF: tcpdrop\n(failed — may need root)"); }

  // tcpconnect — new TCP connections during sample
  console.log("  ebpf: tcpconnect (10s sample)");
  try {
    const out = execSync(
      "timeout 10 tcpconnect-bpfcc 2>/dev/null || timeout 10 /usr/share/bcc/tools/tcpconnect 2>/dev/null || echo '(tcpconnect not available)'",
      { encoding: "utf-8", timeout: 15_000 }
    );
    results.push(`### eBPF: tcpconnect (10s)\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``);
  } catch { results.push("### eBPF: tcpconnect\n(failed — may need root)"); }

  return results.join("\n\n");
}

function querySqlite(dbPath: string, query: string, label: string): string {
  console.log(`  sqlite: ${label}`);
  try {
    const out = execSync(
      `sqlite3 -header -column "${dbPath}" "${query}" 2>/dev/null`,
      { encoding: "utf-8", timeout: 10_000 }
    );
    return `### SQLite: ${label}\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``;
  } catch (e) {
    return `### SQLite: ${label}\n(query failed: ${e})`;
  }
}

// ── Probe orchestration ────────────────────────────────

function runProbes(entry: MitmEntry, manifest: Manifest): string {
  if (process.env.MITM_SKIP_PROBES === "1") {
    const cachePath = join(PROBE_CACHE_DIR, `${entry.slug}.txt`);
    if (existsSync(cachePath)) {
      console.log(`Using cached probe data for ${entry.slug}`);
      return readFileSync(cachePath, "utf-8");
    }
    console.log("No cached data, running probes anyway");
  }

  ensureCacheDir();
  const hosts = resolveTargets(manifest, entry.targets);
  const sections: string[] = [];

  for (const probe of entry.probes) {
    console.log(`Running probe: ${probe}`);
    switch (probe) {
      case "mtr":
        sections.push(runMtr(hosts));
        break;
      case "tcpdump":
        sections.push(runTcpdump(hosts, PROBE_DURATION));
        break;
      case "dmesg":
        sections.push(runDmesg());
        break;
      case "dig":
        sections.push(runDig(hosts));
        break;
      case "openssl":
        sections.push(runOpenssl(hosts));
        break;
      case "curl":
        sections.push(runCurl(hosts));
        break;
      case "flowlog":
        sections.push(runFlowLog());
        break;
      case "ebpf":
        sections.push(runEbpf(hosts));
        break;
      case "sqlite": {
        const home = process.env.HOME ?? "/home/compturerstore";
        sections.push(querySqlite(
          join(home, ".openclaw/memory/main.sqlite"),
          "SELECT * FROM memory ORDER BY rowid DESC LIMIT 50;",
          "openclaw recent memory"
        ));
        sections.push(querySqlite(
          join(home, ".codex/logs_1.sqlite"),
          "SELECT * FROM logs ORDER BY rowid DESC LIMIT 50;",
          "codex recent logs"
        ));
        break;
      }
      default:
        sections.push(`### ${probe}\n(unknown probe type)`);
    }
  }

  const result = sections.join("\n\n");

  // Cache for re-runs
  const cachePath = join(PROBE_CACHE_DIR, `${entry.slug}.txt`);
  writeFileSync(cachePath, result);

  return result;
}

// ── Infrastructure-side MITM detection tooling ────────

const mitmPlugin: SeriesPlugin = {
  prefix: "mitm",
  seriesName: "Infrastructure MITM Investigation",
  baseTags: ["networking", "security", "mitm", "tcpdump", "mtr"],
  manifestPath: MANIFEST_PATH,

  getNextEntry(manifest: Manifest) {
    for (const entry of manifest.files) {
      if (!manifest.completed.includes(entry.slug) && !entry.existing) return entry;
    }
    return null;
  },

  markCompleted(manifest: Manifest, entry: MitmEntry) {
    manifest.completed.push(entry.slug);
  },

  async fetchSource(entry: MitmEntry) {
    const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    console.log(`Running network probes for: ${entry.slug}`);
    console.log(`Probes: ${entry.probes.join(", ")}`);
    console.log(`Targets: ${entry.targets.join(", ")}`);
    const probeData = runProbes(entry, manifest);
    return `## Probe data for: ${entry.slug}\n\n${entry.note}\n\n${probeData}`;
  },

  buildSystemPrompt() {
    return `You are writing for "Effective Address," a blog about reverse engineering, DIY electronics, bare-metal programming, and reading source code the hard way.

You are writing the next entry in the "Infrastructure MITM Investigation" series. This series documents ongoing network forensics investigating a backbone-level MITM within Cogent's transit network (AS174) that uses BGP anycast hijacking to redirect CDN-destined traffic to local termination points.

You are given raw output from network probes (mtr, tcpdump, dmesg, dig, openssl, curl). Your job is to analyze the probe data and write a technical article about what it reveals.

Key context from previous articles:
- A backbone TCP proxy within Cogent hides as a silent hop (100% probe loss, no identity)
- WebSocket connections are killed with correct-sequence TCP FINs post-handshake
- QUIC bypasses the proxy (TCP/QUIC asymmetry is the structural fingerprint)
- All Cloudflare/Fastly anycast IPs converge to same TTL 55 / 9 hops with sub-ms latency from proxy
- The proxy uses BGP anycast hijacking + embedded CDN PoPs for TLS termination with legitimate certs
- I2P tunnel data shows application-layer corruption consistent with TCP checksum recalculation at proxy boundaries

Style:
- Lead with what the probes show, then explain what it means
- Include raw probe output in code blocks — readers should see the evidence
- Reference specific IP addresses, TTL values, timing data from the probes
- Connect findings to previous articles in the series
- Note anything that changed since previous probing
- Keep it technical but human — Michael Reeves energy, not textbook energy
- DO NOT include any provenance or disclaimer section — that will be appended automatically

PROBE DATA REDACTION:
The probe data below comes from a live investigation host. When quoting raw output:
- Replace the investigation host's source IP with [src] in tcpdump/mtr output
- Replace any LAN/residential IPs with [redacted]
- Infrastructure IPs (Cogent 38.x.x.x/154.x.x.x, Cloudflare 104.x.x.x/172.64.x.x, Fastly 151.x.x.x) are evidence — keep them
- Strip any hostnames that could identify the subscriber or their LAN

Output format: Write ONLY the markdown body (no frontmatter). Start with a # heading.`;
  },

  buildUserPrompt(previousArticles, source, entry: MitmEntry) {
    const prev = previousArticles.length > 0
      ? `Here are all previous articles in the series (you MUST read these for continuity):\n\n${previousArticles.join("\n\n")}\n\n---\n\n`
      : "";
    return `${prev}Today's investigation: ${entry.note}\n\n${source}\n\nWrite the article. Analyze the probe data. Show the evidence. Connect it to what we already know from previous articles.`;
  },

  slugify(entry: MitmEntry) {
    return entry.slug;
  },
};

runSeries(mitmPlugin).catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
