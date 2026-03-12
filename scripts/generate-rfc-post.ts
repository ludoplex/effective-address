#!/usr/bin/env npx tsx
/**
 * generate-rfc-post.ts
 *
 * Generates the next "RFCs in Context" article using fravia-style search methodology.
 *
 * Process:
 * 1. Reads all previous RFC articles
 * 2. Picks the next RFC from the manifest
 * 3. Fetches the raw RFC text
 * 4. Runs 7+ search queries (fravia-style advanced operators) to find:
 *    - Insider blog posts about the RFC
 *    - Mailing list discussions from the authors
 *    - Implementation war stories
 *    - Known exploits and edge cases
 *    - Usenet/archive.org discussions
 * 5. Feeds everything to the LLM
 * 6. Generates article with both dry analysis AND insider context
 * 7. Appends provenance (model, timestamp, network path, search queries used)
 *
 * Env vars:
 *   AI_PROVIDER        - "anthropic" or "openai" (default: anthropic)
 *   ANTHROPIC_API_KEY   - Required if provider is anthropic
 *   OPENAI_API_KEY      - Required if provider is openai
 *   SEARCH_API_KEY      - Google Custom Search API key (optional, falls back to DDG)
 *   SEARCH_ENGINE_ID    - Google Custom Search engine ID (optional)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  traceNetworkPath,
  formatProvenance,
  apiHostForProvider,
  type Provenance,
  type NetworkHop,
} from "./provenance.js";

const BLOG_DIR = join(import.meta.dirname, "..", "src", "content", "blog");
const MANIFEST_PATH = join(import.meta.dirname, "rfc-manifest.json");

const provider = (process.env.AI_PROVIDER ?? "anthropic") as "anthropic" | "openai";
const CONTACT_EMAIL = "theanderproject@gmail.com";

function getModel(): string {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250514";
  }
  return process.env.OPENAI_MODEL ?? "gpt-5.4";
}

// ── Manifest ───────────────────────────────────────────

interface RfcEntry {
  rfc: number;
  title: string;
  note: string;
}

interface Manifest {
  files: RfcEntry[];
  completed: number[];
  contact: string;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function saveManifest(m: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

function getNextEntry(m: Manifest): RfcEntry | null {
  for (const e of m.files) {
    if (!m.completed.includes(e.rfc)) return e;
  }
  return null;
}

// ── Previous articles ──────────────────────────────────

function readPreviousArticles(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((f) => f.startsWith("rfc-") && f.endsWith(".md"))
    .sort()
    .map((f) => {
      const content = readFileSync(join(BLOG_DIR, f), "utf-8");
      return `--- FILE: ${f} ---\n${content}`;
    });
}

// ── Fetch RFC text ─────────────────────────────────────

function fetchRfcText(num: number): string {
  try {
    const text = execSync(
      `curl -sL "https://www.rfc-editor.org/rfc/rfc${num}.txt"`,
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 15_000 }
    );
    // Truncate very long RFCs to first ~4000 lines to stay within context
    const lines = text.split("\n");
    if (lines.length > 4000) {
      return lines.slice(0, 4000).join("\n") + "\n\n[... truncated at 4000 lines ...]";
    }
    return text;
  } catch {
    return `(Failed to fetch RFC ${num} text)`;
  }
}

// ── Fravia-style search ────────────────────────────────

interface SearchResult {
  query: string;
  source: string;
  results: string;
}

/** Build 7+ search queries using advanced operators for a given RFC */
function buildSearchQueries(rfc: number, title: string, authors?: string): string[] {
  const rfcNum = `RFC ${rfc}`;
  const rfcCompact = `RFC${rfc}`;
  return [
    // 1. Implementation war stories
    `"${rfcNum}" implementation "lessons learned" OR "war story" OR "the hard way"`,
    // 2. Mailing list / author discussions
    `"${rfcNum}" site:mailarchive.ietf.org OR site:lists.w3.org`,
    // 3. Blog posts from practitioners
    `"${rfcCompact}" OR "${rfcNum}" blog "in practice" OR "real world" -site:rfc-editor.org -site:wikipedia.org`,
    // 4. Known issues, errata, exploits
    `"${rfcNum}" errata OR vulnerability OR exploit OR "security consideration" OR CVE`,
    // 5. Usenet / archive.org historical discussion
    `"${rfcNum}" site:groups.google.com OR site:web.archive.org OR site:news.ycombinator.com`,
    // 6. Stack Overflow deep dives
    `"${rfcNum}" OR "${rfcCompact}" site:stackoverflow.com answers:5.. score:20..`,
    // 7. Academic / niche technical analysis
    `"${rfcNum}" "${title}" analysis OR critique OR "design decision" filetype:pdf OR site:cr.yp.to OR site:sockpuppet.org`,
    // 8. i2p / tor hidden service references (searched via clearnet proxies)
    `"${rfcNum}" site:i2pforum.net OR inurl:i2p OR "onion" "${title}"`,
  ];
}

/** Execute a search query via Google Custom Search API or DuckDuckGo HTML */
function executeSearch(query: string): string {
  const googleKey = process.env.SEARCH_API_KEY;
  const engineId = process.env.SEARCH_ENGINE_ID;

  if (googleKey && engineId) {
    try {
      const encoded = encodeURIComponent(query);
      const json = execSync(
        `curl -s "https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${engineId}&q=${encoded}&num=5"`,
        { encoding: "utf-8", timeout: 10_000 }
      );
      const data = JSON.parse(json);
      if (data.items) {
        return data.items
          .map((item: { title: string; link: string; snippet: string }) =>
            `- [${item.title}](${item.link}): ${item.snippet}`
          )
          .join("\n");
      }
      return "(no results)";
    } catch {
      return "(Google search failed)";
    }
  }

  // Fallback: DuckDuckGo lite (HTML scrape for snippets)
  try {
    const encoded = encodeURIComponent(query);
    const html = execSync(
      `curl -sL -A "Mozilla/5.0" "https://lite.duckduckgo.com/lite?q=${encoded}" 2>/dev/null | head -c 50000`,
      { encoding: "utf-8", timeout: 10_000 }
    );
    // Extract result snippets from DDG lite HTML
    const snippets: string[] = [];
    const resultPattern = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
    const snippetPattern = /<td class="result-snippet">([^<]+)<\/td>/gi;
    let match;
    while ((match = resultPattern.exec(html)) !== null && snippets.length < 5) {
      snippets.push(`- [${match[2].trim()}](${match[1]})`);
    }
    while ((match = snippetPattern.exec(html)) !== null && snippets.length < 10) {
      snippets.push(`  ${match[1].trim()}`);
    }
    return snippets.length > 0 ? snippets.join("\n") : "(no results from DDG)";
  } catch {
    return "(search unavailable)";
  }
}

function runSearches(rfc: number, title: string): SearchResult[] {
  const queries = buildSearchQueries(rfc, title);
  const results: SearchResult[] = [];

  for (const query of queries) {
    console.log(`  Search: ${query.slice(0, 80)}...`);
    const searchResults = executeSearch(query);
    results.push({
      query,
      source: process.env.SEARCH_API_KEY ? "Google Custom Search" : "DuckDuckGo Lite",
      results: searchResults,
    });
    // Brief pause between searches to be polite
    execSync("sleep 1");
  }

  return results;
}

// ── LLM calls ──────────────────────────────────────────

async function generateWithAnthropic(system: string, user: string, model: string): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: user }],
  });
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

async function generateWithOpenAI(system: string, user: string, model: string): Promise<string> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI();
  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return response.choices[0]?.message?.content ?? "";
}

// ── Main ───────────────────────────────────────────────

async function main() {
  console.log(`Provider: ${provider}, Model: ${getModel()}`);

  const manifest = loadManifest();
  const entry = getNextEntry(manifest);
  if (!entry) {
    console.log("All RFCs completed. Add more entries to rfc-manifest.json.");
    process.exit(0);
  }
  console.log(`\nNext: RFC ${entry.rfc} — ${entry.title}`);

  // Read previous articles
  const previous = readPreviousArticles();
  console.log(`Read ${previous.length} previous RFC article(s)`);

  // Fetch RFC text
  console.log(`Fetching RFC ${entry.rfc}...`);
  const rfcText = fetchRfcText(entry.rfc);

  // Run fravia-style searches
  console.log(`Running search queries for RFC ${entry.rfc}...`);
  const searchResults = runSearches(entry.rfc, entry.title);

  // Trace network path
  const apiHost = apiHostForProvider(provider);
  console.log(`Tracing network path to ${apiHost}...`);
  const networkPath = traceNetworkPath(apiHost);

  // Build prompts
  const articleNum = previous.length + 1;
  const paddedNum = String(articleNum).padStart(2, "0");
  const model = getModel();

  const searchContext = searchResults
    .map((s) => `### Query: ${s.query}\nSource: ${s.source}\n${s.results}`)
    .join("\n\n");

  const systemPrompt = `You are writing for "Effective Address," a blog about reverse engineering, DIY electronics, bare-metal programming, and reading source code the hard way.

You are writing the next entry in the "RFCs in Context" series. This series takes dry RFC specifications and brings them to life with:

1. **Technical analysis** — what the RFC actually specifies, with key sections highlighted
2. **Insider context** — blog posts, mailing list threads, implementation war stories, and obscure resources that explain what the spec doesn't say
3. **The gap** — what changed between the RFC and reality, what implementors got wrong, what the authors wish they'd specified differently

Style:
- Start with why this RFC matters — what breaks if it didn't exist
- Quote specific RFC sections when they're interesting or surprising
- Weave in the search results naturally — these are the "context" that makes the series valuable
- Note where the RFC is silent on things that turned out to matter
- Include a "Further Reading" section with the best links from the search results
- End with a note inviting corrections/context: "${CONTACT_EMAIL}"
- DO NOT include any provenance or disclaimer section — that will be appended automatically

Output format: Write ONLY the markdown body (no frontmatter). Start with a # heading.`;

  const previousContext = previous.length > 0
    ? `Previous articles in the series:\n\n${previous.join("\n\n")}\n\n---\n\n`
    : "";

  const userPrompt = `${previousContext}Today's RFC: RFC ${entry.rfc} — ${entry.title}

${entry.note}

## RFC Text (may be truncated):
\`\`\`
${rfcText.slice(0, 30000)}
\`\`\`

## Research Results (fravia-style search across web, usenet archives, i2p forums):

${searchContext}

Write the article. Incorporate the most interesting search results as "context" that surrounds the dry RFC spec. If a search result is a dead end or irrelevant, skip it. Prioritize practitioner insights over academic summaries.`;

  // Generate
  console.log("Generating article...");
  const generatedAt = new Date().toISOString();
  let articleBody: string;

  if (provider === "anthropic") {
    articleBody = await generateWithAnthropic(systemPrompt, userPrompt, model);
  } else {
    articleBody = await generateWithOpenAI(systemPrompt, userPrompt, model);
  }

  // Build provenance (include search queries in the footer)
  const provenance: Provenance = {
    model,
    provider,
    generatedAt,
    apiHost,
    networkPath,
  };

  const searchDisclosure = searchResults
    .map((s, i) => `${i + 1}. \`${s.query.slice(0, 100)}\` — via ${s.source}`)
    .join("\n");

  // Assemble
  const title = articleBody.match(/^#\s+(.+)$/m)?.[1] ?? `RFC ${entry.rfc}: ${entry.title}`;
  const description = `RFCs in Context: RFC ${entry.rfc} (${entry.title}) — ${entry.note}`;

  const frontmatter = `---
title: '${title.replace(/'/g, "''")}'
description: '${description.replace(/'/g, "''")}'
pubDate: '${generatedAt.slice(0, 10)}'
series: 'RFCs in Context'
seriesPart: ${articleNum}
tags: ['rfc', 'networking', 'protocols', 'standards']
---`;

  const provenanceBlock = formatProvenance(provenance);
  // Inject search queries into the provenance
  const extendedProvenance = provenanceBlock.replace(
    "</details>",
    `\n### Search queries used\n\n${searchDisclosure}\n\n</details>`
  );

  const fullPost = `${frontmatter}

${articleBody}

${extendedProvenance}
`;

  const outPath = join(BLOG_DIR, `rfc-${paddedNum}-rfc${entry.rfc}.md`);
  writeFileSync(outPath, fullPost);
  console.log(`Wrote: ${outPath}`);

  // Update manifest
  manifest.completed.push(entry.rfc);
  saveManifest(manifest);

  // GitHub Actions output
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    writeFileSync(outputFile, `slug=rfc-${paddedNum}\ntitle=${title}\n`, { flag: "a" });
  }
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
