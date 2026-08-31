import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./provider.js";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      // A comprehensive JSON-LD graph for a rich page runs well past 4k tokens;
      // a low cap silently truncates the JSON mid-object and entities are lost.
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
}
