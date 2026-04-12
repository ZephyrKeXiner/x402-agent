#!/usr/bin/env node
import dotenv from "dotenv";
import OpenAI from "openai";
import * as readline from "readline";
import { exec, execSync } from "node:child_process";
import { Read, Ls, Write, Grep, Edit, ReadImage } from "./tools/fileSystem.js";
import { toolDefinition } from "./types/tool_def.js";
import { isDangerous } from "./tools/safety.js";
import { trimMessages } from "./utils/tokens.js";
import { loadMessages, saveMessages, listSessions } from "./memory/session.js";
import { readFileSync } from "node:fs";
import { McpClient } from "./mcp/client.js";
import { E2BSandbox, killSandbox } from "./sandbox/e2b.js";
import { promisify } from "node:util";

const execPromise = promisify(exec);
// ─── Configuration ──────────────────────────────────────────────────
dotenv.config({ path: ".env.local" });

const mcpConfig = JSON.parse(readFileSync("mcp.json", "utf-8"));
const mcpClients = new Map<string, McpClient>();

for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
  const { command, args } = config as any;
  const client = new McpClient(command, args);
  await client.connect();
  const tools = await client.listTools();

  for (const tool of tools) {
    toolDefinition.push({
      type: "function",
      function: {
        name: `mcp_${name}_${tool.name}`,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    });
  }

  mcpClients.set(name, client);
}

const MODEL = process.env.MODEL || "anthropic/claude-opus-4.6";
const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS || "100000",
  10,
);
const BASH_TIMEOUT = parseInt(process.env.BASH_TIMEOUT || "30000", 10);
const MAX_DEPTH = 3;

// ─── Readline / Colors ─────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const colors = {
  assistant: "\x1b[37m",
  tool: "\x1b[33m",
  error: "\x1b[31m",
  info: "\x1b[90m",
  success: "\x1b[32m",
  prompt: "\x1b[36m",
  reset: "\x1b[0m",
};

// ─── OpenAI client ──────────────────────────────────────────────────
if (!process.env.OPENROUTER_API_KEY) {
  console.error(
    `${colors.error}Error: OPENROUTER_API_KEY is not set. Create a .env.local file with your key.${colors.reset}`,
  );
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ─── Token usage tracking ───────────────────────────────────────────
const totalTokensUsed = { prompt: 0, completion: 0, total: 0 };

// ─── Helpers ────────────────────────────────────────────────────────
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

async function confirmDangerous(command: string): Promise<boolean> {
  const answer = await ask(
    `${colors.error}⚠ Dangerous command detected: ${command}\nDo you want to proceed? (y/N): ${colors.reset}`,
  );
  return answer.trim().toLowerCase() === "y";
}

// estimateTokens and trimMessages imported from utils.ts

function printUsageStats(): void {
  console.log(
    `${colors.info}[tokens] prompt: ${totalTokensUsed.prompt} | completion: ${totalTokensUsed.completion} | total: ${totalTokensUsed.total}${colors.reset}`,
  );
}

// ─── Base tool handlers ─────────────────────────────────────────────
const baseToolHandlers: Record<
  string,
  (args: Record<string, any>) => Promise<string>
> = {
  bash: async (args) => {
    const cmd = args.command as string;
    console.log(`${colors.tool}[bash] ${cmd}${colors.reset}`);
    if (isDangerous(cmd)) {
      const confirmed = await confirmDangerous(cmd);
      if (!confirmed) {
        return "Command cancelled by user.";
      }
    }
    try {
      const { stdout, stderr } = await execPromise(cmd, {
        encoding: "utf-8",
        timeout: BASH_TIMEOUT,
        cwd: process.cwd(),
      });
      return stdout + (stderr ? `\nstderr: ${stderr}` : "");
    } catch (e: any) {
      return `Exit code: ${e.status ?? "unknown"}\n${e.stderr || e.message}`;
    }
  },
  read_file: async (args) => {
    return await Read(args.path);
  },
  list_dir: async (args) => {
    return Ls(args.path).join("\n");
  },
  write_file: async (args) => {
    await Write(args.path, args.content);
    return `Successfully wrote to ${args.path}`;
  },
  grep: async (args) => {
    return await Grep(args.file_path, args.keyword);
  },
  edit_file: async (args) => {
    return await Edit(args.file_path, args.old_string, args.new_string);
  },
  sandbox: async (args) => {
    return await E2BSandbox(args.command);
  },
};

// ─── Build initial context ──────────────────────────────────────────
const filetree = execSync(`ls ${process.cwd()}`).toString();

const systemPrompt: string = `You are a coding agent assistant. The file structure: ${filetree}.

    Workflow:
    - First, you need to understand user's requirement.
    - Use the tool 'list_dir' to know the structure of the program
    - Use the tool 'read_file' to read related files and understand existed code
    - Thinking the resolution of user's requirement
    - Use the tool 'write_file to modify related files'
    - At last, use 'read_file' again to verify the modification
    - If you can, use the tool 'edit_file more but not 'write_file'

When making function calls using tools that accept array or object parameters ensure those are structured using JSON. For example:
{"color": "orange", "options": {"option_key_1": true}}

Answer the user's request using the relevant tool(s), if they are available. Check that all the required parameters for each tool call are provided or can reasonably be inferred from context. IF there are no relevant tools or there are missing values for required parameters, ask the user to supply these values; otherwise proceed with the tool calls. If the user provides a specific value for a parameter (for example provided in quotes), make sure to use that value EXACTLY. DO NOT make up values for or ask about optional parameters.

If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same turn, otherwise you MUST wait for previous calls to finish first to determine the dependent values (do NOT use placeholders or guess missing parameters).

IMPORTANT: Tools are executed in parallel. Never call multiple tools that write to the same file simultaneously, or run shell commands that depend on each other's side effects in the same turn. When in doubt, split writes into separate turns.`;

// ─── Core agent loop ────────────────────────────────────────────────
export async function runAgent(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  depth: number = 0,
): Promise<string> {
  const deferredMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [];

  const toolHandlers: Record<
    string,
    (args: Record<string, any>) => Promise<string>
  > = {
    ...baseToolHandlers,
    read_image: async (args) => {
      const { dataUri, size } = await ReadImage(args.image_path);
      deferredMessages.push({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: dataUri, detail: "low" },
          },
        ],
      } as any);
      return `Image loaded: ${args.image_path} (${(size / 1024).toFixed(1)}KB). The image is now visible to you.`;
    },
    subagent: async (args) => {
      if (depth + 1 > MAX_DEPTH) {
        return `Error: max sub-agent depth (${MAX_DEPTH}) exceeded`;
      }
      console.log(
        `${colors.tool}[subagent depth=${depth + 1}] \n${(args.systemprompt as string).slice(0, 80)}...\n${(args.prompt as string).slice(0, 80)}...${colors.reset}`,
      );
      const subMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          { role: "system", content: args.systemPrompt },
          {
            role: "user",
            content: [{ type: "text", text: args.prompt }],
          },
        ];
      return await runAgent(subMessages, depth + 1);
    },
  };

  while (true) {
    try {
      const stream = await openai.chat.completions.create({
        model: MODEL,
        messages: messages,
        tools: toolDefinition,
        stream: true,
      });

      let fullContext = "";
      const toolCallUse: any[] = [];
      let finishReason = "";
      let lastPromptTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        if (delta?.content) {
          process.stdout.write(delta.content);
          fullContext += delta.content;
        }

        if (delta?.tool_calls) {
          for (const call of delta.tool_calls) {
            if (!toolCallUse[call.index]) {
              toolCallUse[call.index] = {
                type: call.type,
                id: call.id,
                function: { name: "", arguments: "" },
              };
            }
            if (call.function?.name) {
              toolCallUse[call.index].function.name += call.function.name;
            }
            if (call.function?.arguments) {
              toolCallUse[call.index].function.arguments +=
                call.function.arguments;
            }
          }
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          totalTokensUsed.prompt += chunk.usage.prompt_tokens ?? 0;
          totalTokensUsed.completion += chunk.usage.completion_tokens ?? 0;
          totalTokensUsed.total += chunk.usage.total_tokens ?? 0;
          lastPromptTokens = chunk.usage.prompt_tokens ?? lastPromptTokens;
        }
      }

      if (finishReason === "tool_calls") {
        messages.push({
          role: "assistant",
          content: fullContext || null,
          tool_calls: toolCallUse,
        } as any);

        if (fullContext) process.stdout.write("\n");

        const toolResults = await Promise.all(
          toolCallUse
            .filter((call) => call.type === "function")
            .map(async (call) => {
              try {
                const args = JSON.parse(call.function.arguments);
                let result: string;

                if (call.function.name.startsWith("mcp")) {
                  const parts = call.function.name.split("_");
                  const serverName = parts[1];
                  const toolName = parts.slice(2).join("_");
                  const client = mcpClients.get(serverName);
                  if (!client)
                    throw new Error(`MCP server not found: ${serverName}`);
                  const mcpResult = await client.callTool(toolName, args);
                  result = JSON.stringify(mcpResult);
                } else {
                  const handler = toolHandlers[call.function.name];
                  console.log(
                    `${colors.tool}[tool] ${call.function.name}${colors.reset}`,
                  );
                  if (!handler)
                    throw new Error(`Unknown tool: ${call.function.name}`);
                  result = await handler(args);
                }

                return {
                  role: "tool" as const,
                  tool_call_id: call.id,
                  content: result || "(empty result)",
                };
              } catch (e: any) {
                console.log(
                  `${colors.error}[error] ${e.message}${colors.reset}`,
                );
                return {
                  role: "tool" as const,
                  tool_call_id: call.id,
                  content: `Error: ${e.message}`,
                };
              }
            }),
        );

        messages.push(...toolResults);
        // 图片等延迟消息在 tool results 之后注入，保证消息顺序正确
        if (deferredMessages.length > 0) {
          messages.push(...deferredMessages);
          deferredMessages.length = 0;
        }
        trimMessages(messages, lastPromptTokens, MAX_CONTEXT_TOKENS);
      } else if (finishReason === "stop") {
        process.stdout.write("\n");
        messages.push({ role: "assistant", content: fullContext });
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i] as any;
          if (msg.role === "user" && Array.isArray(msg.content)) {
            const hasImage = msg.content.some(
              (part: any) => part.type === "image_url",
            );
            if (hasImage) {
              let turnsSince = 0;
              for (let j = i + 1; j < messages.length; j++) {
                if (messages[j].role === "assistant") turnsSince++;
              }
              if (turnsSince >= 3) {
                messages[i] = {
                  role: "user",
                  content: "[image was previously provided and analyzed]",
                };
              }
            }
          }
        }
        trimMessages(messages, lastPromptTokens, MAX_CONTEXT_TOKENS);
        return fullContext;
      } else {
        console.log(
          `\n${colors.error}[warn] Unexpected finish reason: ${finishReason}${colors.reset}`,
        );
        if (fullContext) {
          messages.push({ role: "assistant", content: fullContext });
        }
        return fullContext;
      }
    } catch (e: any) {
      console.error(`${colors.error}[API Error] ${e.message}${colors.reset}`);
      if (messages[messages.length - 1]?.role === "user") {
        messages.pop();
      }
      return `Error: ${e.message}`;
    }
  }
}

// ─── Slash commands ─────────────────────────────────────────────────
async function handleSlashCommand(input: string): Promise<boolean> {
  const trimmed = input.trim();
  if (trimmed === "/clear") {
    messages.length = 1;
    console.log(`${colors.success}✓ Conversation cleared.${colors.reset}`);
    return true;
  }
  if (trimmed === "/tokens") {
    printUsageStats();
    return true;
  }
  if (trimmed === "/model") {
    console.log(`${colors.info}Current model: ${MODEL}${colors.reset}`);
    return true;
  }
  if (trimmed === "/resume") {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      await loadMessages(session_id);
  }
  if (trimmed === "/help") {
    console.log(`${colors.info}Available commands:
  /clear   - Clear conversation history
  /tokens  - Show token usage statistics
  /model   - Show current model
  /help    - Show this help message
  /exit    - Exit the program${colors.reset}
  /resume  - resume the session`);
    return true;
  }
  if (trimmed === "/exit" || trimmed === "/quit") {
    printUsageStats();
    console.log(`${colors.success}Goodbye!${colors.reset}`);
    process.exit(0);
  }
  return false;
}

// ─── Graceful shutdown ──────────────────────────────────────────────
async function gracefulShutdown() {
  saveMessages(messages, session_id);
  await killSandbox();
  console.log(`\n${colors.info}Interrupted.${colors.reset}`);
  printUsageStats();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
rl.on("close", gracefulShutdown);
rl.on("SIGINT", gracefulShutdown);

// ─── Session selection ─────────────────────────────────────────────
async function selectSession(): Promise<string> {
  const sessions = listSessions();
  if (sessions.length === 0) return crypto.randomUUID();

  console.log(`\n${colors.info}  0) New session${colors.reset}`);
  sessions.forEach((s, i) => {
    console.log(`${colors.info}  ${i + 1}) ${s}${colors.reset}`);
  });

  const answer = await ask(`\n${colors.prompt}Select session: ${colors.reset}`);
  const idx = parseInt(answer);

  if (isNaN(idx) || idx === 0) return crypto.randomUUID();
  if (idx >= 1 && idx <= sessions.length) return sessions[idx - 1];
  return crypto.randomUUID();
}

// ─── Main loop ──────────────────────────────────────────────────────
console.log(`${colors.info}Coda coding agent (model: ${MODEL})${colors.reset}`);
console.log(
  `${colors.info}Type /help for available commands.${colors.reset}\n`,
);

const session_id = await selectSession();
const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
  await loadMessages(session_id);

if (messages.length > 0 && messages[0].role === "system") {
  messages[0] = { role: "system", content: systemPrompt };
} else {
  messages.unshift({ role: "system", content: systemPrompt });
}

console.log(`${colors.success}Session: ${session_id}${colors.reset}\n`);

while (true) {
  const prompt = await ask(`${colors.prompt}> ${colors.reset}`);

  if (!prompt.trim()) continue;
  if (prompt.trim().startsWith("/")) {
    if (await handleSlashCommand(prompt)) continue;
  }

  messages.push({ role: "user", content: prompt });
  await runAgent(messages, 0);
}
