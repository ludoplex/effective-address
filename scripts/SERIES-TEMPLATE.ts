#!/usr/bin/env npx tsx
/**
 * SERIES-TEMPLATE.ts — Copy this file to create a new article series.
 *
 * Steps to add a new series:
 * 1. Copy this file to generate-<name>-post.ts
 * 2. Create a <name>-manifest.json with your entries
 * 3. Fill in the plugin fields below
 * 4. Create .github/workflows/<name>.yml (copy cosmo-daily.yml as template)
 * 5. Update the about page with the new series description
 *
 * The series-runner handles everything else: manifest tracking, previous
 * article loading, provenance capture, cert-pin checks, LLM dispatch.
 */

import { join } from "node:path";
import { runSeries, type SeriesPlugin } from "./series-runner.js";

const MANIFEST_PATH = join(import.meta.dirname, "CHANGEME-manifest.json");

// Define your manifest entry shape
interface MyEntry {
  // ... your fields
  title: string;
}

const myPlugin: SeriesPlugin = {
  // Short prefix for filenames (e.g., files will be <prefix>-01-<slug>.md)
  prefix: "CHANGEME",

  // Human name shown in frontmatter
  seriesName: "CHANGEME Series Name",

  // Tags for every article
  baseTags: ["CHANGEME"],

  manifestPath: MANIFEST_PATH,

  getNextEntry(manifest) {
    // Return the next uncompleted entry, or null if done
    return null;
  },

  markCompleted(manifest, entry: MyEntry) {
    // Mark entry as done in manifest
  },

  async fetchSource(entry: MyEntry) {
    // Fetch source material (file content, web page, etc.)
    // Return as a string to include in the LLM prompt
    return "";
  },

  buildSystemPrompt(articleNum) {
    // System prompt for the LLM
    // MUST include: "DO NOT include any provenance or disclaimer section"
    return `You are writing for "Effective Address." ...`;
  },

  buildUserPrompt(previousArticles, source, entry: MyEntry, articleNum) {
    // User prompt with previous articles + source material
    return "";
  },

  slugify(entry: MyEntry) {
    // Return a filename-safe slug for this entry
    return "changeme";
  },

  // Optional: extra provenance content (search queries, etc.)
  // extraProvenance(entry, context) { return ""; },
};

runSeries(myPlugin).catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
