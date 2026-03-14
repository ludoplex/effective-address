/**
 * series-runner.ts — Generic article series engine.
 *
 * To add a new series, create a SeriesPlugin and call runSeries().
 * The runner handles: manifest tracking, previous article loading,
 * provenance capture, cert-pin checks, LLM dispatch, and file output.
 *
 * Usage:
 *   import { runSeries, type SeriesPlugin } from "./series-runner.js";
 *
 *   const mySeries: SeriesPlugin = { ... };
 *   await runSeries(mySeries);
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  traceNetworkPath,
  formatProvenance,
  apiHostForProvider,
  type Provenance,
} from "./provenance.js";
import { resolveConfig, verifyCertPin, generate, type LLMConfig } from "./llm.js";

const __dirname = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = join(__dirname, "..", "src", "content", "blog");

// ── Redaction rules (appended to every system prompt) ──

const REDACTION_RULES = `

MANDATORY REDACTION RULES — you MUST follow these before generating any output:

The following people and entities must NEVER appear by name in any generated article:
- Vincent L. Anderson (the publisher / site operator)
- Rachel (associated person)
- Will (associated person)
- Mighty House Inc.
- DSAIC
- Computer Store
- NSA, FBI, CIA
- DHL

If the source material or probe data contains references to any of the above, redact them (e.g., "[redacted]", "a logistics company", "a government agency", "a private individual"). Do not hint at their identity.

The following entities are PUBLIC and should be named freely:
- Cogent (AS174), Vyve Broadband, Cloudflare, Fastly, Akamai, OpenAI, Anthropic, Google, GitHub, and any other public infrastructure/CDN/tech company relevant to the technical analysis.

Additionally, redact:
- Any subscriber/residential IP addresses (RFC1918, CGNAT 100.64.x.x, or ISP-assigned IPs like 24.112.x.x)
- Any LAN hostnames or MAC addresses
- Any API keys, tokens, or credentials that appear in probe data

Infrastructure IPs (Cogent, Cloudflare, Fastly backbone addresses) should NOT be redacted — they are evidence.`;

// ── Plugin interface ───────────────────────────────────

export interface SeriesPlugin {
  /** Short kebab-case prefix for filenames, e.g. "cosmo", "rfc" */
  prefix: string;

  /** Human-readable series name for frontmatter */
  seriesName: string;

  /** Tags applied to every article in this series */
  baseTags: string[];

  /** Path to the JSON manifest file for this series */
  manifestPath: string;

  /**
   * Pick the next item from the manifest.
   * Return null if the series is exhausted.
   */
  getNextEntry(manifest: any): any | null;

  /**
   * Mark an entry as completed in the manifest.
   */
  markCompleted(manifest: any, entry: any): void;

  /**
   * Fetch source material for this entry (file contents, RFC text, etc.)
   * Return a string to include in the LLM prompt.
   */
  fetchSource(entry: any): Promise<string>;

  /**
   * Build the system prompt for the LLM.
   * Receives previous articles and article number for context.
   */
  buildSystemPrompt(articleNum: number): string;

  /**
   * Build the user prompt for the LLM.
   * Receives previous articles, source material, and the entry.
   */
  buildUserPrompt(
    previousArticles: string[],
    source: string,
    entry: any,
    articleNum: number
  ): string;

  /**
   * Generate a filename slug from the entry (without prefix or number).
   * e.g. "ape-header", "rfc791"
   */
  slugify(entry: any): string;

  /**
   * Optional: extra content to append after provenance (e.g., search queries).
   * Return empty string if not needed.
   */
  extraProvenance?(entry: any, context: any): string;
}

// ── Runner ─────────────────────────────────────────────

export async function runSeries(plugin: SeriesPlugin): Promise<void> {
  const config = resolveConfig();
  console.log(`Series: ${plugin.seriesName}`);
  console.log(`Provider: ${config.provider}, Model: ${config.model}`);

  // Pre-flight: ensure the required API key is configured
  const providerKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  const requiredKey = providerKeyMap[config.provider];
  if (!requiredKey || !process.env[requiredKey]) {
    const missing = requiredKey ?? `API key for unknown provider "${config.provider}"`;
    console.log(
      `Skipping article generation: ${missing} is not set. ` +
        `Configure the secret in your repository settings to enable generation.`
    );
    process.exit(0);
  }

  // Cert pin verification (Rule 2)
  if (!verifyCertPin(config.provider)) {
    process.exit(2);
  }

  // Load manifest
  const manifest = JSON.parse(readFileSync(plugin.manifestPath, "utf-8"));
  const entry = plugin.getNextEntry(manifest);
  if (!entry) {
    console.log(`All ${plugin.seriesName} entries completed. Add more to the manifest.`);
    process.exit(0);
  }

  // Read previous articles in this series
  const previous = readdirSync(BLOG_DIR)
    .filter((f) => f.startsWith(`${plugin.prefix}-`) && f.endsWith(".md"))
    .sort()
    .map((f) => `--- FILE: ${f} ---\n${readFileSync(join(BLOG_DIR, f), "utf-8")}`);
  console.log(`Read ${previous.length} previous ${plugin.seriesName} article(s)`);

  const articleNum = previous.length + 1;
  const paddedNum = String(articleNum).padStart(2, "0");

  // Fetch source material
  console.log("Fetching source material...");
  const source = await plugin.fetchSource(entry);

  // Trace network path
  const apiHost = apiHostForProvider(config.provider);
  console.log(`Tracing network path to ${apiHost}...`);
  const networkPath = traceNetworkPath(apiHost);

  // Build prompts (redaction rules appended to every system prompt)
  const systemPrompt = plugin.buildSystemPrompt(articleNum) + REDACTION_RULES;
  const userPrompt = plugin.buildUserPrompt(previous, source, entry, articleNum);

  // Generate
  console.log("Generating article...");
  const generatedAt = new Date().toISOString();
  const articleBody = await generate(config, systemPrompt, userPrompt);

  // Build provenance
  const provenance: Provenance = {
    model: config.model,
    provider: config.provider,
    generatedAt,
    apiHost,
    networkPath,
  };

  let provenanceBlock = formatProvenance(provenance);

  // Optional extra provenance (e.g., search queries for RFC series)
  const extra = plugin.extraProvenance?.(entry, {}) ?? "";
  if (extra) {
    provenanceBlock = provenanceBlock.replace("</details>", `\n${extra}\n</details>`);
  }

  // Extract title from generated body
  const title = articleBody.match(/^#\s+(.+)$/m)?.[1] ?? `${plugin.seriesName} #${articleNum}`;

  // Assemble post
  const frontmatter = `---
title: '${title.replace(/'/g, "''")}'
description: '${plugin.seriesName} #${articleNum}'
pubDate: '${generatedAt.slice(0, 10)}'
series: '${plugin.seriesName}'
seriesPart: ${articleNum}
tags: ${JSON.stringify(plugin.baseTags)}
---`;

  const fullPost = `${frontmatter}\n\n${articleBody}\n\n${provenanceBlock}\n`;

  // Write
  const slug = `${plugin.prefix}-${paddedNum}-${plugin.slugify(entry)}`;
  const outPath = join(BLOG_DIR, `${slug}.md`);
  writeFileSync(outPath, fullPost);
  console.log(`Wrote: ${outPath}`);

  // Update manifest
  plugin.markCompleted(manifest, entry);
  writeFileSync(plugin.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log("Manifest updated");

  // GitHub Actions outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    writeFileSync(outputFile, `slug=${slug}\ntitle=${title}\n`, { flag: "a" });
  }
}
