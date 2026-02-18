import { OfflineQueueState } from './types';
import { Logger } from './logger';
import * as path from 'path';
import * as fs from 'fs';

const PERSISTENCE_FILE = path.join(process.cwd(), 'offline-queue-state.json');
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 seconds
const MESSAGE_ID_RETENTION_DAYS = 7;

export class OfflineQueueManager {
  private state: OfflineQueueState;
  private logger = new Logger('OfflineQueueManager');
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): OfflineQueueState {
    try {
      if (fs.existsSync(PERSISTENCE_FILE)) {
        const data = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
        const parsed = JSON.parse(data) as OfflineQueueState;

        this.logger.info('Loaded offline queue state', {
          lastOnlineTimestamp: parsed.lastOnlineTimestamp,
          processedMessageCount: parsed.processedMessageIds.length,
          lastUpdated: parsed.lastUpdated,
        });

        return parsed;
      }
    } catch (error) {
      this.logger.error('Failed to load offline queue state', error);
    }

    // Return default state if file doesn't exist or failed to load
    const now = new Date().toISOString();
    return {
      lastOnlineTimestamp: now,
      processedMessageIds: [],
      lastUpdated: now,
    };
  }

  private saveState(): void {
    try {
      this.state.lastUpdated = new Date().toISOString();
      fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
      this.logger.debug('Saved offline queue state', {
        lastOnlineTimestamp: this.state.lastOnlineTimestamp,
        processedMessageCount: this.state.processedMessageIds.length,
      });
    } catch (error) {
      this.logger.error('Failed to save offline queue state', error);
    }
  }

  /**
   * Get the last online timestamp for fetching missed messages
   */
  getLastOnlineTimestamp(): string {
    return this.state.lastOnlineTimestamp;
  }

  /**
   * Get the last online timestamp as a Unix timestamp (for Slack API)
   */
  getLastOnlineUnixTimestamp(): string {
    const date = new Date(this.state.lastOnlineTimestamp);
    return (date.getTime() / 1000).toString();
  }

  /**
   * Update the last online timestamp (called periodically by heartbeat)
   */
  updateLastOnlineTimestamp(): void {
    this.state.lastOnlineTimestamp = new Date().toISOString();
    this.saveState();
  }

  /**
   * Check if a message has already been processed
   */
  isMessageProcessed(messageTs: string): boolean {
    return this.state.processedMessageIds.includes(messageTs);
  }

  /**
   * Mark a message as processed
   */
  markMessageProcessed(messageTs: string): void {
    if (!this.state.processedMessageIds.includes(messageTs)) {
      this.state.processedMessageIds.push(messageTs);
      this.saveState();
    }
  }

  /**
   * Mark multiple messages as processed
   */
  markMessagesProcessed(messageTs: string[]): void {
    let added = false;
    for (const ts of messageTs) {
      if (!this.state.processedMessageIds.includes(ts)) {
        this.state.processedMessageIds.push(ts);
        added = true;
      }
    }
    if (added) {
      this.saveState();
    }
  }

  /**
   * Cleanup old processed message IDs (older than retention period)
   */
  cleanupOldMessageIds(): void {
    const retentionCutoff = Date.now() - (MESSAGE_ID_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffUnix = retentionCutoff / 1000;

    const beforeCount = this.state.processedMessageIds.length;

    // Slack message timestamps are Unix timestamps with decimal
    this.state.processedMessageIds = this.state.processedMessageIds.filter(ts => {
      const messageUnix = parseFloat(ts);
      return messageUnix >= cutoffUnix;
    });

    const removedCount = beforeCount - this.state.processedMessageIds.length;
    if (removedCount > 0) {
      this.logger.info('Cleaned up old processed message IDs', {
        removedCount,
        remainingCount: this.state.processedMessageIds.length,
      });
      this.saveState();
    }
  }

  /**
   * Start the heartbeat to periodically update last online timestamp
   */
  startHeartbeat(): void {
    if (this.heartbeatInterval) {
      this.logger.warn('Heartbeat already running');
      return;
    }

    // Update immediately on start
    this.updateLastOnlineTimestamp();

    // Cleanup old message IDs on start
    this.cleanupOldMessageIds();

    this.heartbeatInterval = setInterval(() => {
      this.updateLastOnlineTimestamp();
    }, HEARTBEAT_INTERVAL_MS);

    this.logger.info('Started offline queue heartbeat', {
      intervalMs: HEARTBEAT_INTERVAL_MS,
    });
  }

  /**
   * Stop the heartbeat (called on graceful shutdown)
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;

      // Final update before shutdown
      this.updateLastOnlineTimestamp();

      this.logger.info('Stopped offline queue heartbeat');
    }
  }

  /**
   * Get processed message IDs (for debugging/logging)
   */
  getProcessedMessageIds(): string[] {
    return [...this.state.processedMessageIds];
  }

  /**
   * Get full state (for debugging)
   */
  getState(): OfflineQueueState {
    return { ...this.state };
  }
}
