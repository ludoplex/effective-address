#!/usr/bin/env npx tsx
/**
 * generate-cosmo-post.ts
 *
 * Generates the next "Actually Reading jart/cosmopolitan" article.
 * 1. Reads all previous articles in the series (full context)
 * 2. Fetches the next file from the cosmopolitan repo
 * 3. Calls an LLM to write the article
 * 4. Captures network provenance (model, timestamp, network path)
 * 5. Writes the markdown post with provenance footer
 *
 * Env vars:
 *   AI_PROVIDER       - "anthropic" or "openai" (default: anthropic)
 *   ANTHROPIC_API_KEY  - Required if provider is anthropic
 *   OPENAI_API_KEY     - Required if provider is openai
 *   ANTHROPIC_MODEL    - Override model (default: claude-opus-4-5-20250514)
 *   OPENAI_MODEL       - Override model (default: gpt-5.4)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  traceNetworkPath,
  formatProvenance,
  apiHostForProvider,
  type Provenance,
} from "./provenance.js";

const BLOG_DIR = join(import.meta.dirname, "..", "src", "content", "blog");
const MANIFEST_PATH = join(import.meta.dirname, "cosmo-manifest.json");
const COSMO_REPO = "jart/cosmopolitan";

// ── Config ─────────────────────────────────────────────

const provider = (process.env.AI_PROVIDER ?? "anthropic") as
  | "anthropic"
  | "openai";

function getModel(): string {
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250514";
  }
  return process.env.OPENAI_MODEL ?? "gpt-5.4";
}

// ── Read previous articles ─────────────────────────────

function readPreviousArticles(): string[] {
  const files = readdirSync(BLOG_DIR)
    .filter((f) => f.startsWith("cosmo-") && f.endsWith(".md"))
    .sort();

  return files.map((f) => {
    const content = readFileSync(join(BLOG_DIR, f), "utf-8");
    return `--- FILE: ${f} ---\n${content}`;
  });
}

// ── Manifest management ────────────────────────────────

interface ManifestEntry {
  path: string;
  lines: [number, number] | null;
  note: string;
}

interface Manifest {
  repo: string;
  files: ManifestEntry[];
  completed: string[];
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function saveManifest(m: Manifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

function getNextEntry(manifest: Manifest): ManifestEntry | null {
  for (const entry of manifest.files) {
    const key = entry.lines
      ? `${entry.path}:${entry.lines[0]}-${entry.lines[1]}`
      : entry.path;
    if (!manifest.completed.includes(key)) return entry;
  }
  return null;
}

function markCompleted(manifest: Manifest, entry: ManifestEntry): void {
  const key = entry.lines
    ? `${entry.path}:${entry.lines[0]}-${entry.lines[1]}`
    : entry.path;
  manifest.completed.push(key);
}

// ── Fetch source from GitHub ───────────────────────────

function fetchSourceFile(
  entry: ManifestEntry
): { content: string; commitSha: string } {
  const ref = "main";
  // Get the latest commit SHA for the file
  const shaJson = execSync(
    `curl -sH "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${COSMO_REPO}/commits?path=${entry.path}&per_page=1&sha=${ref}"`,
    { encoding: "utf-8" }
  );
  let commitSha = "unknown";
  try {
    const commits = JSON.parse(shaJson);
    if (Array.isArray(commits) && commits.length > 0) {
      commitSha = commits[0].sha?.slice(0, 10) ?? "unknown";
    }
  } catch { /* best effort */ }

  // Fetch raw file content
  const raw = execSync(
    `curl -sL "https://raw.githubusercontent.com/${COSMO_REPO}/${ref}/${entry.path}"`,
    { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
  );

  if (entry.lines) {
    const lines = raw.split("\n");
    const [start, end] = entry.lines;
    const slice = lines.slice(start - 1, end);
    return {
      content: slice
        .map((l, i) => `${String(start + i).padStart(5)} | ${l}`)
        .join("\n"),
      commitSha,
    };
  }

  // For full files, add line numbers
  const lines = raw.split("\n");
  return {
    content: lines
      .map((l, i) => `${String(i + 1).padStart(5)} | ${l}`)
      .join("\n"),
    commitSha,
  };
}

// ── LLM calls ──────────────────────────────────────────

async function generateWithAnthropic(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

async function generateWithOpenAI(
  systemPrompt: string,
  userPrompt: string,
  model: string
): Promise<string> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

// ── Main ───────────────────────────────────────────────

async function main() {
  console.log(`Provider: ${provider}`);
  const model = getModel();
  console.log(`Model: ${model}`);

  // 1. Load manifest and find next file
  const manifest = loadManifest();
  const entry = getNextEntry(manifest);
  if (!entry) {
    console.log("All manifest entries completed. Add more files to cosmo-manifest.json.");
    process.exit(0);
  }
  console.log(`Next file: ${entry.path}${entry.lines ? ` (lines ${entry.lines[0]}-${entry.lines[1]})` : ""}`);
  console.log(`Note: ${entry.note}`);

  // 2. Read all previous articles
  const previous = readPreviousArticles();
  console.log(`Read ${previous.length} previous article(s) for context`);

  // 3. Fetch the source file
  console.log(`Fetching ${entry.path} from ${COSMO_REPO}...`);
  const { content: sourceCode, commitSha } = fetchSourceFile(entry);
  console.log(`Got ${sourceCode.split("\n").length} lines, commit ${commitSha}`);

  // 4. Capture network path BEFORE the API call
  const apiHost = apiHostForProvider(provider);
  console.log(`Tracing network path to ${apiHost}...`);
  const networkPath = traceNetworkPath(apiHost);

  // 5. Build prompts
  const articleNum = previous.length + 1;
  const paddedNum = String(articleNum).padStart(2, "0");
  const lineRange = entry.lines ? ` lines ${entry.lines[0]}-${entry.lines[1]}` : "";

  const systemPrompt = `You are writing for "Effective Address," a blog about reverse engineering, DIY electronics, bare-metal programming, and reading source code the hard way.

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

  const previousContext =
    previous.length > 0
      ? `Here are all previous articles in the series (you MUST read these to maintain continuity):\n\n${previous.join("\n\n")}\n\n---\n\n`
      : "";

  const userPrompt = `${previousContext}Today's file: \`${entry.path}\`${lineRange} from jart/cosmopolitan (commit ${commitSha}).

${entry.note}

\`\`\`
${sourceCode}
\`\`\`

Write the next article in the series. Remember: readers have read all previous entries. Build on what they already know. Don't repeat explanations from earlier articles unless adding new depth.`;

  // 6. Generate
  console.log("Generating article...");
  const generatedAt = new Date().toISOString();
  let articleBody: string;

  if (provider === "anthropic") {
    articleBody = await generateWithAnthropic(systemPrompt, userPrompt, model);
  } else {
    articleBody = await generateWithOpenAI(systemPrompt, userPrompt, model);
  }

  // 7. Build provenance
  const provenance: Provenance = {
    model,
    provider,
    generatedAt,
    apiHost,
    networkPath,
  };

  // 8. Assemble full post
  const slug = `cosmo-${paddedNum}`;
  const title = articleBody.match(/^#\s+(.+)$/m)?.[1] ?? entry.note;
  const description = `Actually Reading jart/cosmopolitan: ${entry.path}${lineRange} — ${entry.note}`;

  const frontmatter = `---
title: '${title.replace(/'/g, "''")}'
description: '${description.replace(/'/g, "''")}'
pubDate: '${generatedAt.slice(0, 10)}'
series: 'Actually Reading jart/cosmopolitan'
seriesPart: ${articleNum}
tags: ['cosmopolitan', 'c', 'assembly', 'reverse-engineering', 'source-reading']
---`;

  const fullPost = `${frontmatter}

${articleBody}

${formatProvenance(provenance)}
`;

  // 9. Write post
  const outPath = join(BLOG_DIR, `${slug}-${entry.path.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.md`);
  writeFileSync(outPath, fullPost);
  console.log(`Wrote: ${outPath}`);

  // 10. Update manifest
  markCompleted(manifest, entry);
  saveManifest(manifest);
  console.log(`Marked completed: ${entry.path}${lineRange}`);

  // Output for GitHub Actions
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = `slug=${slug}\nfile=${outPath}\ntitle=${title}\n`;
    writeFileSync(outputFile, outputs, { flag: "a" });
  }
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
