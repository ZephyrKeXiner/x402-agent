import OpenAI from "openai";

export const toolDefinition: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read local file content",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path when you need to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the directory's content",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The directory path that you want to know the file in it",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content into file",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path that you want to write",
          },
          content: {
            type: "string",
            description: "The content that you want to write in the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search for a keyword in the file content and return the matching lines",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The file path in which to search for the keyword",
          },
          keyword: {
            type: "string",
            description: "The keyword to search for in the file content",
          },
        },
        required: ["file_path", "keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace a specific string in a file. The old_string must be unique in the file.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The file path in which to edit the content",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace",
          },
          new_string: {
            type: "string",
            description: "The replacement string",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute bash command on local enviroment",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command that you want to execute",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "subagent",
      description:
        "Launch an independent sub-agent to handle a subtask. The sub-agent has its own conversation context and access to all tools. Use this when you need to delegate a self-contained task (e.g. research, search, or a focused code change) without polluting the main conversation.",
      parameters: {
        type: "object",
        properties: {
          systemprompt: {
            type: "string",
            description: "The system prompt for the sub-agent to follow",
          },
          prompt: {
            type: "string",
            description: "The task description for the sub-agent to complete",
          },
        },
        required: ["systemprompt", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sandbox",
      description: "Launch a remote sandbox for dangerous action.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The commmand that you want to execute in the sandbox",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_image",
      description:
        "Read an image file and return its visual content for analysis. " +
        "Use this when you need to see/analyze an image file in the project ",
      parameters: {
        type: "object",
        properties: {
          image_path: {
            type: "string",
            description:
              "The path of the image that you want to read or analyze",
          },
        },
        required: ["image_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "worktree",
      description:
        "Manage git worktrees for parallel development on different branches. " +
        "Actions: 'create' - create a new worktree + branch, 'list' - list all worktrees, " +
        "'remove' - remove a worktree, 'switch' - switch to a different worktree. " +
        "Worktrees allow you to work on multiple branches simultaneously without stashing or committing.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "remove", "switch"],
            description: "The worktree action to perform",
          },
          branch: {
            type: "string",
            description:
              "The branch name for 'create' action. Will be created if it doesn't exist.",
          },
          base_branch: {
            type: "string",
            description:
              "The base branch to create the new branch from (for 'create' action). Defaults to current branch.",
          },
          worktree_path: {
            type: "string",
            description:
              "The worktree path for 'remove' or 'switch' action. Use the path returned by 'list' action.",
          },
          switch_to: {
            type: "boolean",
            description:
              "Whether to switch to the new worktree immediately after creation (for 'create' action). Default: false.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pr",
      description:
        "Create a GitHub Pull Request from the current branch. " +
        "This will push the branch to origin and create a PR using the GitHub CLI (gh). " +
        "Make sure you have committed your changes before calling this. " +
        "Requires GitHub CLI to be installed and authenticated.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The title of the pull request",
          },
          body: {
            type: "string",
            description:
              "The body/description of the pull request. Supports GitHub-flavored markdown.",
          },
          base: {
            type: "string",
            description:
              "The base branch to merge into. Defaults to the repository's default branch.",
          },
          head: {
            type: "string",
            description:
              "The head branch (source). Defaults to the current branch.",
          },
          draft: {
            type: "boolean",
            description: "Create as a draft pull request. Default: false.",
          },
          push: {
            type: "boolean",
            description:
              "Push the branch to origin before creating the PR. Default: true.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_pr",
      description:
        "Merge a GitHub Pull Request and automatically clean up: " +
        "removes the worktree, deletes the local and remote branch, " +
        "and pulls latest main. Use this after a PR is approved.",
      parameters: {
        type: "object",
        properties: {
          pr: {
            type: "string",
            description:
              "The PR number or URL to merge (e.g. '5' or the full URL)",
          },
          method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge method. Default: squash.",
          },
        },
        required: ["pr"],
      },
    },
  },
];
