#!/usr/bin/env npx tsx
/**
 * generate-cosmo-post.ts — "Actually Reading jart/cosmopolitan" series plugin.
 * Thin wrapper over series-runner.ts.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { runSeries, type SeriesPlugin } from "./series-runner.js";

const MANIFEST_PATH = join(import.meta.dirname, "cosmo-manifest.json");
const COSMO_REPO = "jart/cosmopolitan";

interface CosmoEntry {
  path: string;
  lines: [number, number] | null;
  note: string;
}

function entryKey(e: CosmoEntry): string {
  return e.lines ? `${e.path}:${e.lines[0]}-${e.lines[1]}` : e.path;
}

function fetchSourceFile(entry: CosmoEntry): string {
  const ref = "main";
  let commitSha = "unknown";
  try {
    const shaJson = execSync(
      `curl -sH "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${COSMO_REPO}/commits?path=${entry.path}&per_page=1&sha=${ref}"`,
      { encoding: "utf-8" }
    );
    const commits = JSON.parse(shaJson);
    if (Array.isArray(commits) && commits.length > 0) {
      commitSha = commits[0].sha?.slice(0, 10) ?? "unknown";
    }
  } catch { /* best effort */ }

  const raw = execSync(
    `curl -sL "https://raw.githubusercontent.com/${COSMO_REPO}/${ref}/${entry.path}"`,
    { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
  );

  const lines = raw.split("\n");
  let numbered: string;
  if (entry.lines) {
    const [start, end] = entry.lines;
    numbered = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)} | ${l}`)
      .join("\n");
  } else {
    numbered = lines
      .map((l, i) => `${String(i + 1).padStart(5)} | ${l}`)
      .join("\n");
  }

  const lineRange = entry.lines ? ` lines ${entry.lines[0]}-${entry.lines[1]}` : "";
  return `File: \`${entry.path}\`${lineRange} from ${COSMO_REPO} (commit ${commitSha})\n\n\`\`\`\n${numbered}\n\`\`\``;
}

const cosmoPlugin: SeriesPlugin = {
  prefix: "cosmo",
  seriesName: "Actually Reading jart/cosmopolitan",
  baseTags: ["cosmopolitan", "c", "assembly", "reverse-engineering", "source-reading"],
  manifestPath: MANIFEST_PATH,

  getNextEntry(manifest) {
    for (const entry of manifest.files) {
      if (!manifest.completed.includes(entryKey(entry))) return entry;
    }
    return null;
  },

  markCompleted(manifest, entry: CosmoEntry) {
    manifest.completed.push(entryKey(entry));
  },

  async fetchSource(entry: CosmoEntry) {
    return fetchSourceFile(entry);
  },

  buildSystemPrompt() {
    return `You are writing for "Effective Address," a blog about reverse engineering, DIY electronics, bare-metal programming, and reading source code the hard way.

You are writing the next entry in the "Actually Reading jart/cosmopolitan" series. This series goes through Justine Tunney's cosmopolitan libc one file at a time. Each article builds on previous entries — readers have read them all.

Style guidelines:
- Write like you're explaining this to a curious engineer at a whiteboard
- Point out clever tricks, surprising design choices, and "wait, why did they do THAT" moments
- Connect to broader concepts (x86 architecture, OS internals, linker behavior, ABI details) when relevant
- Don't be dry. If something is wild, say it's wild. If a hack is beautiful, say so.
- Include specific line references (e.g., "line 42") when discussing code
- Use code blocks with the appropriate language tag
- Keep it technical but human — Michael Reeves energy, not textbook energy
- DO NOT include any provenance or disclaimer section — that will be appended automatically

Output format: Write ONLY the markdown body of the article (no frontmatter). Start with a # heading.`;
  },

  buildUserPrompt(previousArticles, source, entry: CosmoEntry) {
    const prev = previousArticles.length > 0
      ? `Here are all previous articles in the series (you MUST read these to maintain continuity):\n\n${previousArticles.join("\n\n")}\n\n---\n\n`
      : "";

    return `${prev}Today's source:\n\n${source}\n\n${entry.note}\n\nWrite the next article. Readers have read all previous entries — build on what they know.`;
  },

  slugify(entry: CosmoEntry) {
    return entry.path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();
  },
};

runSeries(cosmoPlugin).catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
