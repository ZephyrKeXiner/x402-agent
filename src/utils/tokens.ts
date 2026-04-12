import OpenAI from "openai";

export function estimateTokens(
  message: OpenAI.Chat.Completions.ChatCompletionMessageParam,
): number {
  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content
      .map((part: any) => part.text || "")
      .join(" ");
  } else if (message.content === null || message.content === undefined) {
    text = "";
  }
  const msg = message as any;
  if (msg.tool_calls) {
    text += JSON.stringify(msg.tool_calls);
  }
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 3);
}

export function trimMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  lastPromptTokens: number,
  maxContextTokens: number,
): void {
  if (lastPromptTokens < maxContextTokens * 0.8) return;

  const targetTokens = maxContextTokens * 0.6;
  let currentTokens = lastPromptTokens;

  while (currentTokens > targetTokens && messages.length > 2) {
    let removeEnd = 1;
    for (let i = 1; i < messages.length; i++) {
      removeEnd = i + 1;
      const msg = messages[i] as any;
      if (msg.role === "assistant" && !msg.tool_calls) {
        break;
      }
    }

    let removedTokens = 0;
    for (let i = 1; i < removeEnd; i++) {
      removedTokens += estimateTokens(messages[i]);
    }

    messages.splice(1, removeEnd - 1);
    currentTokens -= removedTokens;
  }
}
