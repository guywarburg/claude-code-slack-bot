import { App } from '@slack/bolt';
import { QueuedMessage } from './types';
import { OfflineQueueManager } from './offline-queue-manager';
import { SlackHandler, MessageEvent } from './slack-handler';
import { Logger } from './logger';

const RATE_LIMIT_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class OfflineQueueProcessor {
  private app: App;
  private queueManager: OfflineQueueManager;
  private slackHandler: SlackHandler;
  private logger = new Logger('OfflineQueueProcessor');
  private botUserId: string | null = null;

  constructor(app: App, queueManager: OfflineQueueManager, slackHandler: SlackHandler) {
    this.app = app;
    this.queueManager = queueManager;
    this.slackHandler = slackHandler;
  }

  /**
   * Get the bot's user ID
   */
  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
        this.logger.debug('Got bot user ID', { botUserId: this.botUserId });
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        throw error;
      }
    }
    return this.botUserId;
  }

  /**
   * Delay helper for rate limiting
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute an API call with retry logic for rate limiting
   */
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    let lastError: Error | null = null;
    let backoff = INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (error.code === 'slack_webapi_rate_limited' || error.data?.error === 'ratelimited') {
          const retryAfter = error.headers?.['retry-after'] || error.data?.retry_after || 30;
          const waitTime = (parseInt(retryAfter, 10) * 1000) || backoff;

          this.logger.warn(`Rate limited on ${operationName}, waiting ${waitTime}ms (attempt ${attempt}/${MAX_RETRIES})`);
          await this.delay(waitTime);
          backoff *= 2; // Exponential backoff
        } else if (attempt < MAX_RETRIES) {
          this.logger.warn(`Error on ${operationName}, retrying (attempt ${attempt}/${MAX_RETRIES})`, { error: error.message });
          await this.delay(backoff);
          backoff *= 2;
        } else {
          throw error;
        }
      }
    }

    throw lastError;
  }

  /**
   * Fetch all channels/DMs the bot is a member of
   */
  private async fetchAllChannels(): Promise<string[]> {
    const channels: string[] = [];
    let cursor: string | undefined;

    do {
      await this.delay(RATE_LIMIT_DELAY_MS);

      const result = await this.withRetry(
        () => this.app.client.conversations.list({
          types: 'public_channel,private_channel,im,mpim',
          exclude_archived: true,
          limit: 200,
          cursor,
        }),
        'conversations.list'
      );

      if (result.channels) {
        for (const channel of result.channels) {
          // Only include channels the bot is a member of
          if (channel.id && channel.is_member) {
            channels.push(channel.id);
          }
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    this.logger.info('Fetched all channels', { count: channels.length });
    return channels;
  }

  /**
   * Fetch messages from a channel since a specific timestamp
   */
  private async fetchMissedMessages(channel: string, oldest: string): Promise<any[]> {
    const messages: any[] = [];
    let cursor: string | undefined;

    do {
      await this.delay(RATE_LIMIT_DELAY_MS);

      try {
        const result = await this.withRetry(
          () => this.app.client.conversations.history({
            channel,
            oldest,
            limit: 100,
            cursor,
          }),
          `conversations.history(${channel})`
        );

        if (result.messages) {
          messages.push(...result.messages);
        }

        cursor = result.response_metadata?.next_cursor;
      } catch (error: any) {
        // Handle channel not found or no access
        if (error.data?.error === 'channel_not_found' ||
            error.data?.error === 'not_in_channel' ||
            error.data?.error === 'is_archived') {
          this.logger.debug('Skipping channel', { channel, error: error.data?.error });
          return [];
        }
        throw error;
      }
    } while (cursor);

    return messages;
  }

  /**
   * Fetch thread replies for a message
   */
  private async fetchThreadReplies(channel: string, threadTs: string, oldest: string): Promise<any[]> {
    const replies: any[] = [];
    let cursor: string | undefined;

    do {
      await this.delay(RATE_LIMIT_DELAY_MS);

      try {
        const result = await this.withRetry(
          () => this.app.client.conversations.replies({
            channel,
            ts: threadTs,
            oldest,
            limit: 100,
            cursor,
          }),
          `conversations.replies(${channel}, ${threadTs})`
        );

        if (result.messages) {
          // Skip the first message (parent) as we already have it
          // Replies include the parent message as the first element
          for (const msg of result.messages) {
            if (msg.ts !== threadTs) {
              replies.push(msg);
            }
          }
        }

        cursor = result.response_metadata?.next_cursor;
      } catch (error: any) {
        // Handle thread not found
        if (error.data?.error === 'thread_not_found') {
          this.logger.debug('Thread not found', { channel, threadTs });
          return [];
        }
        throw error;
      }
    } while (cursor);

    return replies;
  }

  /**
   * Check if a message mentions the bot
   */
  private messageContainsMention(text: string | undefined, botUserId: string): boolean {
    if (!text) return false;
    return text.includes(`<@${botUserId}>`);
  }

  /**
   * Filter messages to only those relevant to the bot (DMs and @mentions)
   */
  private async filterRelevantMessages(
    messages: any[],
    channel: string,
    botUserId: string
  ): Promise<QueuedMessage[]> {
    const relevant: QueuedMessage[] = [];
    const isDM = channel.startsWith('D');

    for (const msg of messages) {
      // Skip messages from the bot itself
      if (msg.user === botUserId || msg.bot_id) {
        continue;
      }

      // Skip already processed messages
      if (this.queueManager.isMessageProcessed(msg.ts)) {
        continue;
      }

      // For DMs, include all user messages
      if (isDM) {
        relevant.push({
          channel,
          user: msg.user,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
          text: msg.text,
          files: msg.files,
        });
        continue;
      }

      // For channels, only include messages that mention the bot
      if (this.messageContainsMention(msg.text, botUserId)) {
        relevant.push({
          channel,
          user: msg.user,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
          text: msg.text,
          files: msg.files,
        });
      }
    }

    return relevant;
  }

  /**
   * Process the offline queue - fetch and process all missed messages
   */
  async processOfflineQueue(): Promise<void> {
    const startTime = Date.now();
    const oldestTimestamp = this.queueManager.getLastOnlineUnixTimestamp();

    this.logger.info('Starting offline queue processing', {
      lastOnline: this.queueManager.getLastOnlineTimestamp(),
      oldestUnix: oldestTimestamp,
    });

    try {
      const botUserId = await this.getBotUserId();
      const channels = await this.fetchAllChannels();

      if (channels.length === 0) {
        this.logger.info('No channels to process');
        return;
      }

      const allMessages: QueuedMessage[] = [];

      // Fetch messages from each channel
      for (const channel of channels) {
        try {
          const messages = await this.fetchMissedMessages(channel, oldestTimestamp);

          if (messages.length === 0) {
            continue;
          }

          this.logger.debug('Fetched messages from channel', {
            channel,
            messageCount: messages.length,
          });

          // Check for threads with replies
          for (const msg of messages) {
            if (msg.reply_count && msg.reply_count > 0) {
              const replies = await this.fetchThreadReplies(channel, msg.ts, oldestTimestamp);
              if (replies.length > 0) {
                this.logger.debug('Fetched thread replies', {
                  channel,
                  threadTs: msg.ts,
                  replyCount: replies.length,
                });
                // Add replies to messages array for filtering
                messages.push(...replies);
              }
            }
          }

          // Filter to relevant messages
          const relevant = await this.filterRelevantMessages(messages, channel, botUserId);
          allMessages.push(...relevant);
        } catch (error) {
          this.logger.error('Error fetching messages from channel', { channel, error });
          // Continue with other channels
        }
      }

      if (allMessages.length === 0) {
        this.logger.info('No missed messages to process');
        return;
      }

      // Sort by timestamp (oldest first)
      allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

      this.logger.info('Processing missed messages', {
        messageCount: allMessages.length,
        oldestTs: allMessages[0]?.ts,
        newestTs: allMessages[allMessages.length - 1]?.ts,
      });

      // Process each message
      let processed = 0;
      let failed = 0;

      for (const message of allMessages) {
        try {
          // Convert QueuedMessage to MessageEvent
          const event: MessageEvent = {
            user: message.user,
            channel: message.channel,
            ts: message.ts,
            thread_ts: message.thread_ts,
            text: message.text,
            files: message.files,
          };

          await this.slackHandler.processQueuedMessage(event);

          // Mark as processed
          this.queueManager.markMessageProcessed(message.ts);
          processed++;

          this.logger.debug('Processed queued message', {
            channel: message.channel,
            ts: message.ts,
          });

          // Small delay between message processing
          await this.delay(500);
        } catch (error) {
          this.logger.error('Failed to process queued message', {
            channel: message.channel,
            ts: message.ts,
            error,
          });

          // Mark as processed to avoid retry loops
          this.queueManager.markMessageProcessed(message.ts);
          failed++;
        }
      }

      const duration = Date.now() - startTime;
      this.logger.info('Completed offline queue processing', {
        totalMessages: allMessages.length,
        processed,
        failed,
        durationMs: duration,
      });
    } catch (error) {
      this.logger.error('Error processing offline queue', error);
    }
  }
}
