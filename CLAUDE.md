# Claude Code Slack Bot

This is a TypeScript-based Slack bot that integrates with the Claude Code SDK to provide AI-powered coding assistance directly within Slack workspaces.

## Project Overview

The bot allows users to interact with Claude Code through Slack, providing real-time coding assistance, file analysis, code reviews, and project management capabilities. It supports both direct messages and channel conversations, with sophisticated working directory management and task tracking.

## Architecture

### Core Components

- **`src/index.ts`** - Application entry point and initialization
- **`src/config.ts`** - Environment configuration and validation
- **`src/slack-handler.ts`** - Main Slack event handling and message processing
- **`src/claude-handler.ts`** - Claude Code SDK integration and session management
- **`src/working-directory-manager.ts`** - Working directory configuration and resolution
- **`src/file-handler.ts`** - File upload processing and content embedding
- **`src/todo-manager.ts`** - Task list management and progress tracking
- **`src/mcp-manager.ts`** - MCP server configuration and management
- **`src/scheduled-tasks-manager.ts`** - Scheduled/cron task configuration and execution
- **`src/logger.ts`** - Structured logging utility
- **`src/types.ts`** - TypeScript type definitions

### Key Features

#### 1. Working Directory Management
- **Base Directory Support**: Configure a base directory (e.g., `/Users/username/Code/`) to use short project names
- **Channel Defaults**: Each channel gets a default working directory when the bot is first added
- **Thread Overrides**: Individual threads can override the channel default by mentioning the bot
- **Hierarchy**: Thread-specific > Channel default > DM-specific
- **Smart Resolution**: Supports both relative paths (`cwd project-name`) and absolute paths

#### 2. Real-Time Task Tracking
- **Todo Lists**: Displays Claude's planning process as formatted task lists in Slack
- **Progress Updates**: Updates task status in real-time as Claude works
- **Priority Indicators**: Visual priority levels (🔴 High, 🟡 Medium, 🟢 Low)
- **Status Reactions**: Emoji reactions on original messages show overall progress
- **Live Updates**: Single message updates instead of spam

#### 3. File Upload Support
- **Multiple Formats**: Images (JPG, PNG, GIF, WebP), text files, code files, documents
- **Content Embedding**: Text files are embedded directly in prompts
- **Image Analysis**: Images are saved for Claude to analyze using the Read tool
- **Size Limits**: 50MB file size limit with automatic cleanup
- **Security**: Secure download using Slack bot token authentication

#### 4. Advanced Message Handling
- **Streaming Responses**: Real-time message updates as Claude generates responses
- **Tool Formatting**: Rich formatting for file edits, bash commands, and other tool usage
- **Status Indicators**: Clear visual feedback (🤔 Thinking, ⚙️ Working, ✅ Completed)
- **Error Handling**: Graceful error recovery with informative messages
- **Session Management**: Conversation context maintained across interactions

#### 5. Channel Integration
- **Auto-Setup**: Automatic welcome message when added to channels
- **Mentions**: Responds to @mentions in channels
- **Thread Support**: Maintains context within threaded conversations
- **File Uploads**: Handles file uploads in any conversation context

#### 6. MCP (Model Context Protocol) Integration
- **External Tools**: Extends Claude's capabilities with external MCP servers
- **Multiple Server Types**: Supports stdio, SSE, and HTTP MCP servers
- **Auto-Configuration**: Loads servers from `mcp-servers.json` automatically
- **Tool Management**: All MCP tools are allowed by default with `mcp__serverName__toolName` pattern
- **Runtime Management**: Reload configuration without restarting the bot
- **Popular Integrations**: Filesystem access, GitHub API, database connections, web search

#### 7. Scheduled Tasks
- **Cron-Based Scheduling**: Configure recurring tasks using standard cron expressions
- **Channel Targeting**: Tasks can target specific channels by name or ID
- **Configurable Prompts**: Each task executes a custom prompt
- **Enable/Disable**: Individual tasks can be enabled or disabled without removal
- **Auto-Configuration**: Loads tasks from `scheduled-tasks.json` automatically

## Environment Configuration

### Required Variables
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  
SLACK_SIGNING_SECRET=your-signing-secret

# Claude Code Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key
```

### Optional Variables
```env
# Working Directory Configuration
BASE_DIRECTORY=/Users/username/Code/

# Third-party API Providers
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1

# Development
DEBUG=true
```

## Slack App Configuration

### Required Permissions
- `app_mentions:read` - Read mentions
- `channels:history` - Read channel messages
- `chat:write` - Send messages
- `chat:write.public` - Write to public channels
- `files:write` - Upload files (required for voice responses)
- `im:history` - Read direct messages
- `im:read` - Basic DM info
- `im:write` - Send direct messages
- `users:read` - Read user information
- `reactions:read` - Read message reactions
- `reactions:write` - Add/remove reactions

### Required Events
- `app_mention` - When the bot is mentioned
- `message.im` - Direct messages
- `member_joined_channel` - When bot is added to channels

### Socket Mode
The bot uses Socket Mode for real-time event handling, requiring an app-level token with `connections:write` scope.

## Usage Patterns

### Channel Setup
```
1. Add bot to channel
2. Bot sends welcome message asking for working directory
3. Set default: `cwd project-name` or `cwd /absolute/path`
4. Start using: `@ClaudeBot help me with authentication`
```

### Thread Overrides
```
@ClaudeBot cwd different-project
@ClaudeBot now help me with this other codebase
```

### File Analysis
```
[Upload image/code file]
Analyze this screenshot and suggest improvements
```

### Task Tracking
Users see real-time task lists as Claude plans and executes work:
```
📋 Task List

🔄 In Progress:
🔴 Analyze authentication system

⏳ Pending:  
🟡 Implement OAuth flow
🟢 Add error handling

Progress: 1/3 tasks completed (33%)
```

### MCP Server Management
```
# View configured MCP servers
User: mcp
Bot: 🔧 MCP Servers Configured:
     • filesystem (stdio)
     • github (stdio)
     • postgres (stdio)

# Reload MCP configuration
User: mcp reload
Bot: ✅ MCP configuration reloaded successfully.

# Use MCP tools automatically
User: @ClaudeBot list all TODO comments in the project
Bot: [Uses mcp__filesystem tools to search files]
```

### Scheduled Tasks
Configure recurring tasks in `scheduled-tasks.json`:
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
      "prompt": "Review open pull requests",
      "description": "Weekday PR review"
    }
  ]
}
```

Task configuration options:
- `cron`: Standard cron expression (e.g., `0 9 * * *` for daily at 9 AM)
- `channel`: Target channel name (`#channel`) or ID
- `prompt`: The prompt/command to execute
- `description`: Optional human-readable description
- `enabled`: Optional boolean to enable/disable (defaults to true)

## Development

### Build and Run
```bash
npm install
npm run build
npm run dev     # Development with hot reload
npm run prod    # Production mode
```

## Production Deployment

To keep the bot running persistently in production, use one of the following approaches:

### Option 1: PM2 (Recommended for Node.js)

PM2 is a production process manager for Node.js with built-in load balancing, monitoring, and auto-restart.

```bash
# Install PM2 globally
npm install -g pm2

# Start the bot with PM2
pm2 start npm --name "slack-assist" -- run prod

# Configure PM2 to start on system boot
pm2 startup
pm2 save

# Useful PM2 commands
pm2 status              # View running processes
pm2 logs slack-assist   # View logs
pm2 restart slack-assist # Restart the bot
pm2 stop slack-assist   # Stop the bot
pm2 monit               # Real-time monitoring dashboard
```

Alternatively, create an `ecosystem.config.js` file:
```javascript
module.exports = {
  apps: [{
    name: 'slack-assist',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

Then run:
```bash
pm2 start ecosystem.config.js
```

### Option 2: systemd (Linux)

Create a systemd service file at `/etc/systemd/system/slack-assist.service`:

```ini
[Unit]
Description=Claude Code Slack Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/slack-assist
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=slack-assist
EnvironmentFile=/path/to/slack-assist/.env

[Install]
WantedBy=multi-user.target
```

Then enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable slack-assist
sudo systemctl start slack-assist

# Useful commands
sudo systemctl status slack-assist   # Check status
sudo journalctl -u slack-assist -f   # View logs
sudo systemctl restart slack-assist  # Restart
```

### Option 3: launchd (macOS)

Create a plist file at `~/Library/LaunchAgents/com.slack-assist.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.slack-assist</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/slack-assist/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/slack-assist</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/slack-assist/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/slack-assist/logs/stderr.log</string>
</dict>
</plist>
```

Load and start the service:
```bash
launchctl load ~/Library/LaunchAgents/com.slack-assist.plist

# Useful commands
launchctl list | grep slack-assist   # Check if running
launchctl unload ~/Library/LaunchAgents/com.slack-assist.plist  # Stop
launchctl load ~/Library/LaunchAgents/com.slack-assist.plist    # Start
```

### Option 4: Docker

Create a `Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

Build and run:
```bash
docker build -t slack-assist .
docker run -d --name slack-assist --restart always --env-file .env slack-assist
```

Or use Docker Compose with a `docker-compose.yml`:
```yaml
version: '3.8'
services:
  slack-assist:
    build: .
    restart: always
    env_file:
      - .env
    volumes:
      - ./mcp-servers.json:/app/mcp-servers.json:ro
      - ./scheduled-tasks.json:/app/scheduled-tasks.json:ro
```

Run with:
```bash
docker-compose up -d
```

### Project Structure
```
src/
├── index.ts                      # Entry point
├── config.ts                     # Configuration
├── slack-handler.ts              # Slack event handling
├── claude-handler.ts             # Claude Code SDK integration
├── working-directory-manager.ts  # Directory management
├── file-handler.ts               # File processing
├── todo-manager.ts               # Task tracking
├── mcp-manager.ts                # MCP server management
├── scheduled-tasks-manager.ts    # Scheduled task management
├── logger.ts                     # Logging utility
└── types.ts                      # Type definitions

# Configuration files
mcp-servers.json                  # MCP server configuration (gitignored)
mcp-servers.example.json          # Example MCP configuration
scheduled-tasks.json              # Scheduled tasks configuration (gitignored)
scheduled-tasks.example.json      # Example scheduled tasks configuration
```

### Key Design Decisions

1. **Append-Only Messages**: Instead of editing a single message, each response is a separate message for better conversation flow
2. **Session-Based Context**: Each conversation maintains its own Claude Code session for continuity
3. **Smart File Handling**: Text content embedded in prompts, images passed as file paths for Claude to read
4. **Hierarchical Working Directories**: Channel defaults with thread overrides for flexibility
5. **Real-Time Feedback**: Status reactions and live task updates for transparency

### Error Handling
- Graceful degradation when Slack API calls fail
- Automatic retry for transient errors
- Comprehensive logging for debugging
- User-friendly error messages
- Automatic cleanup of temporary files

### Security Considerations
- Environment variables for sensitive configuration
- Secure file download with proper authentication
- Temporary file cleanup after processing
- No storage of user data beyond session duration
- Validation of file types and sizes

## Future Enhancements

Potential areas for expansion:
- Persistent working directory storage (database)
- Advanced file format support (PDFs, Office docs)
- Integration with version control systems
- Custom slash commands
- Team-specific bot configurations
- Analytics and usage tracking