import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { ClaudeHandler } from './claude-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { OfflineQueueManager } from './offline-queue-manager';
import { OfflineQueueProcessor } from './offline-queue-processor';
import { Logger } from './logger';

const logger = new Logger('Main');

let offlineQueueManager: OfflineQueueManager | null = null;

async function start() {
  try {
    // Validate configuration
    validateConfig();

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);

    // Initialize offline queue manager
    offlineQueueManager = new OfflineQueueManager();
    const offlineQueueProcessor = new OfflineQueueProcessor(app, offlineQueueManager, slackHandler);

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();
    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });

    // Start the heartbeat to track online status
    offlineQueueManager.startHeartbeat();

    // Process offline messages in the background (non-blocking)
    logger.info('Processing offline message queue...');
    offlineQueueProcessor.processOfflineQueue()
      .then(() => {
        logger.info('Offline queue processing completed');
      })
      .catch((error) => {
        logger.error('Error processing offline queue', error);
      });

  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

// Graceful shutdown handlers
function handleShutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  if (offlineQueueManager) {
    offlineQueueManager.stopHeartbeat();
  }

  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

start();