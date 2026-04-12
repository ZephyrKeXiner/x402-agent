# Coda

Terminal AI coding agent. Powered by [OpenRouter](https://openrouter.ai/), default model Claude Opus 4.6.

LLM can read, write, edit, search files, run bash commands, and spawn sub-agents in your local project.

## Quick Start

```bash
git clone <your-repo-url>
cd coda
npm install

# Configure
cp .env.example .env.local
# Add your OPENROUTER_API_KEY to .env.local

# Run
npm run dev
```

## Features

- **File tools** - read, write, edit, list, grep
- **Bash execution** - with dangerous command detection and confirmation
- **Sub-agent** - delegate subtasks to independent agent instances (max depth 3)
- **Sandbox** - E2B cloud sandbox for isolated command execution
- **Memory** - conversation history persisted to JSON, auto-saved on exit (Ctrl+C)
- **Streaming** - real-time streamed responses
- **Token management** - usage tracking and automatic context trimming
- **MCP** - Model Context Protocol client for connecting external tool servers
- **Security** - path traversal protection, dangerous command patterns

## Usage

```bash
# Development
npm run dev

# Production
npm run build && npm start

# Global CLI
npm link
coda
```

## Commands

| Command   | Description          |
|-----------|----------------------|
| `/clear`  | Clear conversation   |
| `/tokens` | Show token usage     |
| `/model`  | Show current model   |
| `/resume` | Resume session       |
| `/worktree` | Show git worktree status |
| `/help`   | Show help            |
| `/exit`   | Exit                 |

## Tools

| Tool         | Description                                    |
|--------------|------------------------------------------------|
| `read_file`  | Read file contents                             |
| `write_file` | Write to file (auto-creates parent dirs)       |
| `edit_file`  | Find and replace unique string in file         |
| `list_dir`   | List directory contents                        |
| `grep`       | Search keyword in file with line numbers       |
| `bash`       | Execute shell command                          |
| `subagent`   | Spawn sub-agent for independent subtasks       |
| `worktree`   | Manage git worktrees for parallel development  |
| `create_pr`  | Create a GitHub Pull Request                   |

## Configuration

`.env.local`:

| Variable             | Default                     | Description             |
|----------------------|-----------------------------|-------------------------|
| `OPENROUTER_API_KEY` | *(required)*                | OpenRouter API key      |
| `MODEL`              | `anthropic/claude-opus-4.6` | LLM model               |
| `MAX_CONTEXT_TOKENS` | `100000`                    | Context window limit    |
| `BASH_TIMEOUT`       | `30000`                     | Bash timeout (ms)       |

## Project Structure

```
src/
  index.ts              - Main loop, agent core, slash commands
  types/
    def.ts              - Tool definitions for OpenAI function calling
  tools/
    fileSystem.ts       - File operation tools (read, write, edit, grep, ls)
    safety.ts           - Dangerous command detection patterns
  utils/
    tokens.ts           - Token estimation and context trimming
  memory/
    session.ts          - Conversation persistence and vector index (vectra)
  mcp/
    client.ts           - MCP client (JSON-RPC over stdio)
    server.ts           - MCP server skeleton
  sandbox/
    e2b.ts              - E2B cloud sandbox integration
  tools/
    worktree.ts         - Git worktree management and PR creation
  __tests__/
    test.ts             - Test suite
bin/
  coda.sh               - CLI entry point
```

## Testing

```bash
npm test
```

## License

ISC
