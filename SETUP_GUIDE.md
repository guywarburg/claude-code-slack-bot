# Step-by-Step Setup Guide

This guide walks you through setting up the Claude Code Slack Bot from scratch.

---

## Prerequisites Checklist

Before starting, ensure you have:
- [ ] Node.js 18+ installed (`node --version`)
- [ ] A Slack workspace where you have admin permissions
- [ ] Terminal access on the machine where the bot will run

---

## Step 1: Install Claude Code CLI

The bot requires the Claude Code CLI to be installed and authenticated.

### 1.1 Install globally via npm

```bash
npm install -g @anthropic-ai/claude-code
```

### 1.2 Verify installation

```bash
claude --version
```

You should see something like `claude-code/1.x.x`.

### 1.3 Authenticate with Claude

```bash
claude login
```

This will open a browser window. Log in with your Anthropic account (or the account linked to your Claude subscription).

### 1.4 Verify authentication

```bash
claude -p "Say hello"
```

If you see Claude respond, authentication is working.

---

## Step 2: Create a Slack App

### 2.1 Go to the Slack API dashboard

Open [https://api.slack.com/apps](https://api.slack.com/apps) in your browser.

### 2.2 Create a new app

1. Click **"Create New App"**
2. Select **"From an app manifest"**
3. Choose your workspace from the dropdown
4. Click **"Next"**

### 2.3 Paste the app manifest

Copy the contents of `slack-app-manifest.yaml` from this project and paste it into the YAML tab:

```yaml
display_information:
  name: Claude Code Bot
  description: AI-powered coding assistant using Claude Code
  background_color: "#4a154b"
features:
  bot_user:
    display_name: Claude Code
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### 2.4 Create the app

1. Click **"Next"**
2. Review the permissions
3. Click **"Create"**

---

## Step 3: Configure the Slack App

### 3.1 Enable Socket Mode

1. In the left sidebar, go to **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** to ON
3. You'll be prompted to create an app-level token:
   - Name it: `socket-token`
   - Add scope: `connections:write`
   - Click **"Generate"**
4. **Copy this token** (starts with `xapp-`) — you'll need it for `.env`

### 3.2 Install the app to your workspace

1. In the left sidebar, go to **"Install App"**
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**

### 3.3 Get the Bot User OAuth Token

1. After installation, you'll see **"Bot User OAuth Token"**
2. **Copy this token** (starts with `xoxb-`) — you'll need it for `.env`

### 3.4 Get the Signing Secret

1. In the left sidebar, go to **"Basic Information"**
2. Scroll down to **"App Credentials"**
3. **Copy the "Signing Secret"** — you'll need it for `.env`

---

## Step 4: Configure Environment Variables

### 4.1 Create your .env file

```bash
cp .env.example .env
```

### 4.2 Edit the .env file

Open `.env` in your editor and fill in the values:

```env
# Slack App Configuration (from Step 3)
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here

# Working Directory Configuration
# Set this to your code projects folder
BASE_DIRECTORY=/Users/YOUR_USERNAME/Code/

# Claude CLI Configuration
# "skip" = no permission prompts (recommended for personal use)
PERMISSION_MODE=skip

# Optional: Enable debug logging
# DEBUG=true
```

### 4.3 Replace placeholders

| Placeholder | Where to get it |
|-------------|-----------------|
| `xoxb-your-bot-token-here` | Step 3.3 - Bot User OAuth Token |
| `xapp-your-app-token-here` | Step 3.1 - App-Level Token |
| `your-signing-secret-here` | Step 3.4 - Signing Secret |
| `/Users/YOUR_USERNAME/Code/` | Your local projects directory |

---

## Step 5: Install Dependencies

```bash
npm install
```

This will install all required packages (Slack Bolt, MCP SDK, etc.).

---

## Step 6: Run the Bot

### 6.1 Start in development mode

```bash
npm run dev
```

You should see output like:
```
[SlackHandler] Setting up event handlers
[index] Slack bot is running!
```

### 6.2 Keep it running

The bot needs to stay running to respond to messages. For development, keep the terminal open.

For production, consider using:
- `pm2`: `pm2 start npm -- run start`
- `screen` or `tmux`
- A systemd service

---

## Step 7: Test the Bot

### 7.1 Invite the bot to a channel

In Slack:
1. Go to a channel (or create a test channel)
2. Type `/invite @Claude Code` (or whatever you named your bot)
3. The bot should send a welcome message asking for a working directory

### 7.2 Set the working directory

In the channel, type:
```
cwd /path/to/your/project
```

Or if you set `BASE_DIRECTORY`:
```
cwd project-folder-name
```

### 7.3 Send a test message

```
@Claude Code What files are in this directory?
```

The bot should:
1. React with a thinking emoji
2. Send a "Thinking..." status
3. List the files using the Claude CLI
4. Update the status to "Task completed"

---

## Step 8: Direct Messages (Optional)

You can also DM the bot directly:

1. In Slack, go to **"Apps"** in the sidebar
2. Find **"Claude Code"** (or your bot name)
3. Start a direct message
4. Set a working directory: `cwd /path/to/project`
5. Chat with Claude!

---

## Troubleshooting

### Bot doesn't respond

1. **Check the terminal** for error messages
2. **Verify tokens** are correct in `.env`
3. **Ensure Socket Mode** is enabled in Slack app settings
4. **Check the bot is invited** to the channel

### "CLI not found" error

```bash
# Check claude is in PATH
which claude

# If not found, reinstall
npm install -g @anthropic-ai/claude-code

# Or set custom path in .env
CLAUDE_CLI_PATH=/full/path/to/claude
```

### "Not authenticated" error

```bash
# Re-authenticate
claude login
```

### Permission errors

If Claude can't read/write files:
1. Ensure the working directory path is correct
2. Check file permissions on the directory
3. Try using an absolute path

### Debug mode

Enable detailed logging:
```env
DEBUG=true
```

Then restart the bot to see verbose output.

---

## Quick Reference

### Slack Commands

| Command | Description |
|---------|-------------|
| `cwd /path` | Set working directory |
| `cwd` | Show current working directory |
| `mcp` | Show MCP server status |
| `mcp reload` | Reload MCP configuration |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (xoxb-...) |
| `SLACK_APP_TOKEN` | Yes | App-level token (xapp-...) |
| `SLACK_SIGNING_SECRET` | Yes | App signing secret |
| `BASE_DIRECTORY` | No | Base path for relative cwd |
| `PERMISSION_MODE` | No | `skip`, `allowedTools`, `acceptEdits`, `default` |
| `CLAUDE_CLI_PATH` | No | Custom path to claude binary |
| `CLAUDE_MODEL` | No | Override model selection |
| `DEBUG` | No | Enable debug logging |

---

## Next Steps

- **Add MCP servers**: Copy `mcp-servers.example.json` to `mcp-servers.json` and configure additional tools
- **Restrict permissions**: Change `PERMISSION_MODE` to `allowedTools` for safer operation
- **Deploy to server**: Set up the bot on a server that's always running

---

## Need Help?

- Check the [README.md](./README.md) for more details
- Review Claude Code documentation: `claude --help`
- Open an issue on the repository
