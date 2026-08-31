import OpenAI from "openai";
import type { LlmProvider } from "./provider.js";

export class OpenAIProvider implements LlmProvider {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      // A comprehensive JSON-LD graph for a rich page needs room; the default
      // is model-dependent and a truncated response drops entities silently.
      max_tokens: 16384,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content || "{}";
  }
}
