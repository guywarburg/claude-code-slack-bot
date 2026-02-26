# Claude Code Slack Bot (CLI Fork)

A Slack bot that integrates with your **local** Claude Code CLI to provide AI-powered coding assistance directly in your Slack workspace.

> **Note**: This is a fork of [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) that replaces the `@anthropic-ai/claude-code` SDK with direct CLI invocation. This lets you control your local Claude Code instance from Slack.

## Features

- Direct message support - chat with the bot privately
- Thread support - maintains conversation context within threads
- Streaming responses - see Claude's responses as they're generated
- Markdown formatting - code blocks and formatting are preserved
- Session management - maintains conversation context across messages (using `--resume`)
- Real-time updates - messages update as Claude thinks
- File uploads - analyze uploaded files and images
- MCP server support - extend Claude with additional tools

## Prerequisites

- Node.js 18+ installed
- **Claude Code CLI installed and authenticated:**
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```
- A Slack workspace where you can install apps

> **No API key needed** - the bot uses your existing Claude Code CLI authentication.

## Setup

### 1. Clone and Install

```bash
git clone <your-repo>
cd claude-code-slack
npm install
```

### 2. Create Slack App

#### Option A: Using App Manifest (Recommended)
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From an app manifest"
3. Select your workspace
4. Paste the contents of `slack-app-manifest.json` (or `slack-app-manifest.yaml`)
5. Review and create the app

#### Option B: Manual Configuration
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose "From scratch" and give your app a name
3. Select the workspace where you want to install it

### 3. Configure Slack App

After creating the app (either method), you need to:

#### Generate Tokens
1. Go to "OAuth & Permissions" and install the app to your workspace
2. Copy the "Bot User OAuth Token" (starts with `xoxb-`)
3. Go to "Basic Information" -> "App-Level Tokens"
4. Generate a token with `connections:write` scope
5. Copy the token (starts with `xapp-`)

#### Get Signing Secret
1. Go to "Basic Information"
2. Copy the "Signing Secret"

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# Working Directory Configuration
BASE_DIRECTORY=/Users/username/Code/

# Claude CLI Configuration
PERMISSION_MODE=skip
```

### 5. Run the Bot

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm run build
npm run prod
```

## Permission Modes

The bot supports different permission modes via the `PERMISSION_MODE` environment variable:

| Mode | CLI Flag | Description |
|------|----------|-------------|
| `skip` (default) | `--dangerously-skip-permissions` | No permission prompts, Claude has full access |
| `allowedTools` | `--allowedTools <list>` | Only allow specific tools (configured via `ALLOWED_TOOLS`) |
| `acceptEdits` | `--permission-mode acceptEdits` | Auto-accept file edits, prompt for other actions |
| `default` | Permission MCP server | Slack-based permission prompts via interactive buttons |

### Example: Restricting to safe tools only
```env
PERMISSION_MODE=allowedTools
ALLOWED_TOOLS=Read,Grep,Glob
```

## Usage

### Setting Working Directory

Before using Claude Code, you must set a working directory. This tells Claude where your project files are located.

#### Set working directory:

**Relative paths** (if BASE_DIRECTORY is configured):
```
cwd project-name
```

**Absolute paths**:
```
cwd /path/to/your/project
```
or
```
set directory /path/to/your/project
```

#### Check current working directory:
```
cwd
```
or
```
get directory
```

### Working Directory Scope

- **Direct Messages**: Working directory is set for the entire conversation
- **Channels**: Working directory is set for the entire channel (prompted when bot joins)
- **Threads**: Can override the channel/DM directory for a specific thread by mentioning the bot

### Direct Messages
Simply send a direct message to the bot with your request:
```
@ClaudeBot Can you help me write a Python function to calculate fibonacci numbers?
```

### In Channels
When you first add the bot to a channel, it will ask for a default working directory for that channel.

Mention the bot in any channel where it's been added:
```
@ClaudeBot Please review this code and suggest improvements
```

### Thread-Specific Working Directories
You can override the channel's default working directory for a specific thread:
```
@ClaudeBot cwd different-project
@ClaudeBot Now help me with this specific project
```

### Threads
Reply in a thread to maintain conversation context. The bot will remember previous messages in the thread using Claude Code's `--resume` flag.

### File Uploads
You can upload files and images directly to any conversation:

#### Supported File Types:
- **Images**: JPG, PNG, GIF, WebP, SVG
- **Text Files**: TXT, MD, JSON, JS, TS, PY, Java, etc.
- **Documents**: PDF, DOCX (limited support)
- **Code Files**: Most programming languages

#### Usage:
1. Upload a file by dragging and dropping or using the attachment button
2. Add optional text to describe what you want Claude to do with the file
3. Claude will analyze the file content and provide assistance

**Note**: Files are temporarily downloaded for processing and automatically cleaned up after analysis.

### MCP (Model Context Protocol) Servers

The bot supports MCP servers to extend Claude's capabilities with additional tools.

#### Setup MCP Servers

1. **Create MCP configuration file:**
   ```bash
   cp mcp-servers.example.json mcp-servers.json
   ```

2. **Configure your servers** in `mcp-servers.json`:
   ```json
   {
     "mcpServers": {
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
       },
       "github": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": {
           "GITHUB_TOKEN": "your-token"
         }
       }
     }
   }
   ```

#### MCP Commands

- **View configured servers**: `mcp` or `servers`
- **Reload configuration**: `mcp reload`

### Scheduled Tasks

Configure recurring tasks that run automatically on a schedule.

#### Setup Scheduled Tasks

1. **Create scheduled tasks configuration file:**
   ```bash
   cp scheduled-tasks.example.json scheduled-tasks.json
   ```

2. **Configure your tasks** in `scheduled-tasks.json`:
   ```json
   {
     "tasks": [
       {
         "cron": "0 9 * * *",
         "channel": "#daily-standup",
         "prompt": "summarize-yesterday",
         "description": "Daily standup summary",
         "enabled": true
       },
       {
         "cron": "0 9 * * 1-5",
         "channel": "#engineering",
         "prompt": "Review open pull requests and summarize their status",
         "description": "Weekday PR review"
       }
     ]
   }
   ```

#### Task Configuration Options

| Field | Required | Description |
|-------|----------|-------------|
| `cron` | Yes | Standard cron expression (e.g., `0 9 * * *` for daily at 9 AM) |
| `channel` | Yes | Target channel name (`#channel`) or channel ID |
| `prompt` | Yes | The prompt/command to execute |
| `description` | No | Human-readable description for logging |
| `enabled` | No | Set to `false` to disable without removing (defaults to `true`) |

## Advanced Configuration

### CLI Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `CLAUDE_CLI_PATH` | Path to claude binary | `claude` |
| `PERMISSION_MODE` | Permission handling mode | `skip` |
| `ALLOWED_TOOLS` | Comma-separated list of allowed tools | `Bash,Read,Write,Edit,MultiEdit,Grep,Glob` |
| `CLAUDE_MODEL` | Model to use | CLI default |
| `MAX_TURNS` | Maximum agentic turns | CLI default |
| `APPEND_SYSTEM_PROMPT` | Additional system prompt | none |

### Base Directory Configuration

You can configure a base directory in your `.env` file to use relative paths:

```env
BASE_DIRECTORY=/Users/username/Code/
```

With this set, you can use:
- `cwd herd-website` -> resolves to `/Users/username/Code/herd-website`
- `cwd /absolute/path` -> uses absolute path directly

## Development

### Debug Mode

Enable debug logging by setting `DEBUG=true` in your `.env` file:
```env
DEBUG=true
```

This will show detailed logs including:
- Incoming Slack messages
- Claude CLI invocation details
- Session management operations
- Message streaming updates

### Project Structure
```
src/
├── index.ts                      # Application entry point
├── config.ts                     # Configuration management
├── types.ts                      # TypeScript type definitions
├── claude-handler.ts             # Claude CLI integration (modified from SDK)
├── slack-handler.ts              # Slack event handling
├── working-directory-manager.ts  # Working directory management
├── file-handler.ts               # File upload handling
├── image-handler.ts              # Image processing
├── todo-manager.ts               # Todo list management
├── mcp-manager.ts                # MCP server configuration
├── scheduled-tasks-manager.ts    # Scheduled task configuration
├── permission-mcp-server.ts      # Slack permission prompts (MCP)
└── logger.ts                     # Logging utility
```

### What Changed from Original

This fork only modifies one file significantly:

- **`src/claude-handler.ts`** - Complete rewrite to use CLI spawn instead of SDK
- **`src/slack-handler.ts`** - Two lines changed (import swap from `SDKMessage` to `CLIMessage`)
- **`package.json`** - Removed `@anthropic-ai/claude-code` dependency

The CLI's `--output-format stream-json` produces the same message structure as the SDK, so `slack-handler.ts` (which consumes these messages) works unchanged.

### Available Scripts
- `npm run dev` - Start in development mode with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Run the compiled JavaScript
- `npm run prod` - Run production build

## Troubleshooting

### Bot not responding
1. Check that the bot is running (`npm run dev`)
2. Verify all environment variables are set correctly
3. Ensure the bot has been invited to the channel
4. Check Slack app permissions are configured correctly

### CLI not found
1. Ensure Claude Code is installed globally: `npm install -g @anthropic-ai/claude-code`
2. Check that `claude` is in your PATH: `which claude`
3. If using a custom path, set `CLAUDE_CLI_PATH` in your `.env`

### Authentication errors
1. Verify you're logged in to Claude Code: `claude login`
2. Check Slack tokens haven't expired
3. Ensure Socket Mode is enabled

### Message formatting issues
The bot converts Claude's markdown to Slack's formatting. Some complex formatting may not translate perfectly.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) - Original SDK-based Slack bot
- [MattKilmer/claude-autofix-bot](https://github.com/MattKilmer/claude-autofix-bot) - CLI process management inspiration

## License

MIT
