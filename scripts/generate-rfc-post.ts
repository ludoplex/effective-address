#!/usr/bin/env npx tsx
/**
 * generate-rfc-post.ts — "RFCs in Context" series plugin.
 * Thin wrapper over series-runner.ts with fravia-style search.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { runSeries, type SeriesPlugin } from "./series-runner.js";

const MANIFEST_PATH = join(import.meta.dirname, "rfc-manifest.json");
const CONTACT_EMAIL = "theanderproject@gmail.com";

interface RfcEntry {
  rfc: number;
  title: string;
  note: string;
}

interface SearchResult {
  query: string;
  source: string;
  results: string;
}

// ── Fravia-style search ────────────────────────────────

function buildSearchQueries(rfc: number, title: string): string[] {
  const rfcNum = `RFC ${rfc}`;
  const rfcCompact = `RFC${rfc}`;
  return [
    `"${rfcNum}" implementation "lessons learned" OR "war story" OR "the hard way"`,
    `"${rfcNum}" site:mailarchive.ietf.org OR site:lists.w3.org`,
    `"${rfcCompact}" OR "${rfcNum}" blog "in practice" OR "real world" -site:rfc-editor.org -site:wikipedia.org`,
    `"${rfcNum}" errata OR vulnerability OR exploit OR "security consideration" OR CVE`,
    `"${rfcNum}" site:groups.google.com OR site:web.archive.org OR site:news.ycombinator.com`,
    `"${rfcNum}" OR "${rfcCompact}" site:stackoverflow.com answers:5.. score:20..`,
    `"${rfcNum}" "${title}" analysis OR critique OR "design decision" filetype:pdf OR site:cr.yp.to OR site:sockpuppet.org`,
    `"${rfcNum}" site:i2pforum.net OR inurl:i2p OR "onion" "${title}"`,
  ];
}

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
            `- [${item.title}](${item.link}): ${item.snippet}`)
          .join("\n");
      }
      return "(no results)";
    } catch { return "(Google search failed)"; }
  }

  try {
    const encoded = encodeURIComponent(query);
    const html = execSync(
      `curl -sL -A "Mozilla/5.0" "https://lite.duckduckgo.com/lite?q=${encoded}" 2>/dev/null | head -c 50000`,
      { encoding: "utf-8", timeout: 10_000 }
    );
    const snippets: string[] = [];
    const resultPattern = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = resultPattern.exec(html)) !== null && snippets.length < 5) {
      snippets.push(`- [${match[2].trim()}](${match[1]})`);
    }
    return snippets.length > 0 ? snippets.join("\n") : "(no results from DDG)";
  } catch { return "(search unavailable)"; }
}

function runSearches(rfc: number, title: string): SearchResult[] {
  const queries = buildSearchQueries(rfc, title);
  const results: SearchResult[] = [];
  const source = process.env.SEARCH_API_KEY ? "Google Custom Search" : "DuckDuckGo Lite";

  for (const query of queries) {
    console.log(`  Search: ${query.slice(0, 80)}...`);
    results.push({ query, source, results: executeSearch(query) });
    execSync("sleep 1");
  }
  return results;
}

// Stash search results for provenance
let lastSearchResults: SearchResult[] = [];

// ── Plugin ─────────────────────────────────────────────

const rfcPlugin: SeriesPlugin = {
  prefix: "rfc",
  seriesName: "RFCs in Context",
  baseTags: ["rfc", "networking", "protocols", "standards"],
  manifestPath: MANIFEST_PATH,

  getNextEntry(manifest) {
    for (const e of manifest.files) {
      if (!manifest.completed.includes(e.rfc)) return e;
    }
    return null;
  },

  markCompleted(manifest, entry: RfcEntry) {
    manifest.completed.push(entry.rfc);
  },

  async fetchSource(entry: RfcEntry) {
    // Fetch RFC text
    let rfcText: string;
    try {
      rfcText = execSync(
        `curl -sL "https://www.rfc-editor.org/rfc/rfc${entry.rfc}.txt"`,
        { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 15_000 }
      );
      const lines = rfcText.split("\n");
      if (lines.length > 4000) {
        rfcText = lines.slice(0, 4000).join("\n") + "\n\n[... truncated at 4000 lines ...]";
      }
    } catch { rfcText = `(Failed to fetch RFC ${entry.rfc} text)`; }

    // Run searches
    console.log(`Running fravia-style searches for RFC ${entry.rfc}...`);
    lastSearchResults = runSearches(entry.rfc, entry.title);

    const searchContext = lastSearchResults
      .map((s) => `### Query: ${s.query}\nSource: ${s.source}\n${s.results}`)
      .join("\n\n");

    return `## RFC ${entry.rfc} — ${entry.title}\n\n${entry.note}\n\n\`\`\`\n${rfcText.slice(0, 30000)}\n\`\`\`\n\n## Research Results:\n\n${searchContext}`;
  },

  buildSystemPrompt() {
    return `You are writing for "Effective Address," a blog about reverse engineering, DIY electronics, bare-metal programming, and reading source code the hard way.

You are writing the next entry in the "RFCs in Context" series. This series takes dry RFC specifications and brings them to life with:

1. **Technical analysis** — what the RFC actually specifies, key sections highlighted
2. **Insider context** — blog posts, mailing list threads, implementation war stories, obscure resources
3. **The gap** — what changed between the RFC and reality

Style:
- Start with why this RFC matters — what breaks if it didn't exist
- Quote specific RFC sections when they're interesting or surprising
- Weave in the search results naturally — these are the "context"
- Note where the RFC is silent on things that turned out to matter
- Include a "Further Reading" section with the best links
- End with a note inviting corrections/context: "${CONTACT_EMAIL}"
- DO NOT include any provenance or disclaimer section — that will be appended automatically

Output format: Write ONLY the markdown body (no frontmatter). Start with a # heading.`;
  },

  buildUserPrompt(previousArticles, source, entry: RfcEntry) {
    const prev = previousArticles.length > 0
      ? `Previous articles:\n\n${previousArticles.join("\n\n")}\n\n---\n\n`
      : "";
    return `${prev}${source}\n\nWrite the article. Incorporate the most interesting search results as insider context. Skip irrelevant results.`;
  },

  slugify(entry: RfcEntry) {
    return `rfc${entry.rfc}`;
  },

  extraProvenance() {
    if (lastSearchResults.length === 0) return "";
    const lines = lastSearchResults
      .map((s, i) => `${i + 1}. \`${s.query.slice(0, 100)}\` — via ${s.source}`)
      .join("\n");
    return `### Search queries used\n\n${lines}`;
  },
};

runSeries(rfcPlugin).catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
