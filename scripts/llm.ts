/**
 * llm.ts — Shared LLM calling module for all article series.
 * Handles provider selection, API calls, and cert-pin verification.
 */

import { execSync } from "node:child_process";

export type Provider = "anthropic" | "openai";

export interface LLMConfig {
  provider: Provider;
  model: string;
}

/** Resolve provider and model from environment */
export function resolveConfig(): LLMConfig {
  const provider = (process.env.AI_PROVIDER ?? "anthropic") as Provider;
  let model: string;

  if (provider === "anthropic") {
    model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250514";
  } else {
    model = process.env.OPENAI_MODEL ?? "gpt-5.4";
  }

  return { provider, model };
}

/** Verify cert pin before making API calls (Rule 2 from protocol) */
export function verifyCertPin(provider: Provider): boolean {
  const host = provider === "anthropic" ? "api.anthropic.com" : "api.openai.com";
  const checker = "/usr/local/lib/ws-enforcement/cert-pin-check.sh";

  try {
    execSync(`test -x ${checker} && ${checker} ${host}`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return true;
  } catch {
    // On GitHub Actions the checker won't exist — that's OK,
    // the runner has a different network path (no hop 8)
    if (process.env.GITHUB_ACTIONS) {
      console.log(`[cert-pin] Skipped — running on GitHub Actions (different network path)`);
      return true;
    }
    console.error(`[cert-pin] FAILED for ${host} — aborting per protocol Rule 2`);
    return false;
  }
}

/** Call an LLM with system + user prompt, return the text response */
export async function generate(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 8192
): Promise<string> {
  if (config.provider === "anthropic") {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  } else {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI();
    const response = await client.chat.completions.create({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return response.choices[0]?.message?.content ?? "";
  }
}
