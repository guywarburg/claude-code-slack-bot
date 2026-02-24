import * as fs from 'fs';
import * as path from 'path';
import cron, { ScheduledTask } from 'node-cron';
import { Logger } from './logger';

export interface ScheduledTaskConfig {
  /** Cron expression (e.g., "0 9 * * *" for daily at 9 AM) */
  cron: string;
  /** Channel name (e.g., "#general") or channel ID */
  channel: string;
  /** The prompt/command to execute */
  prompt: string;
  /** Optional description for logging */
  description?: string;
  /** Whether the task is enabled (defaults to true) */
  enabled?: boolean;
}

export interface ScheduledTasksConfiguration {
  tasks: ScheduledTaskConfig[];
}

export class ScheduledTasksManager {
  private logger = new Logger('ScheduledTasksManager');
  private config: ScheduledTasksConfiguration | null = null;
  private configPath: string;
  private scheduledTasks: ScheduledTask[] = [];

  constructor(configPath: string = './scheduled-tasks.json') {
    this.configPath = path.resolve(configPath);
  }

  loadConfiguration(): ScheduledTasksConfiguration | null {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('No scheduled tasks configuration file found', { path: this.configPath });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);

      if (!parsedConfig.tasks || !Array.isArray(parsedConfig.tasks)) {
        this.logger.warn('Invalid scheduled tasks configuration: missing or invalid tasks array', { path: this.configPath });
        return null;
      }

      // Validate task configurations
      const validTasks: ScheduledTaskConfig[] = [];
      for (const task of parsedConfig.tasks) {
        if (this.validateTaskConfig(task)) {
          validTasks.push(task);
        }
      }

      this.config = { tasks: validTasks };

      this.logger.info('Loaded scheduled tasks configuration', {
        path: this.configPath,
        taskCount: validTasks.length,
      });

      return this.config;
    } catch (error) {
      this.logger.error('Failed to load scheduled tasks configuration', error);
      return null;
    }
  }

  private validateTaskConfig(task: any): task is ScheduledTaskConfig {
    if (!task || typeof task !== 'object') {
      this.logger.warn('Invalid task: not an object');
      return false;
    }

    if (!task.cron || typeof task.cron !== 'string') {
      this.logger.warn('Invalid task: missing or invalid cron expression', { task });
      return false;
    }

    if (!cron.validate(task.cron)) {
      this.logger.warn('Invalid task: invalid cron expression', { cron: task.cron });
      return false;
    }

    if (!task.channel || typeof task.channel !== 'string') {
      this.logger.warn('Invalid task: missing or invalid channel', { task });
      return false;
    }

    if (!task.prompt || typeof task.prompt !== 'string') {
      this.logger.warn('Invalid task: missing or invalid prompt', { task });
      return false;
    }

    return true;
  }

  /**
   * Schedule all configured tasks.
   * @param executeTask Callback function to execute when a task is triggered
   */
  scheduleAll(executeTask: (channel: string, prompt: string) => Promise<void>): void {
    // Stop any existing scheduled tasks
    this.stopAll();

    const config = this.loadConfiguration();
    if (!config || config.tasks.length === 0) {
      this.logger.info('No scheduled tasks to register');
      return;
    }

    for (const task of config.tasks) {
      if (task.enabled === false) {
        this.logger.info('Skipping disabled task', {
          channel: task.channel,
          prompt: task.prompt,
          description: task.description
        });
        continue;
      }

      const scheduledTask = cron.schedule(task.cron, async () => {
        const description = task.description || `${task.prompt} to ${task.channel}`;
        this.logger.info('Running scheduled task', { description, channel: task.channel, prompt: task.prompt });
        await executeTask(task.channel, task.prompt);
      });

      this.scheduledTasks.push(scheduledTask);

      this.logger.info('Scheduled task registered', {
        cron: task.cron,
        channel: task.channel,
        prompt: task.prompt,
        description: task.description,
      });
    }

    this.logger.info('All scheduled tasks registered', { count: this.scheduledTasks.length });
  }

  /**
   * Stop all scheduled tasks.
   */
  stopAll(): void {
    for (const task of this.scheduledTasks) {
      task.stop();
    }
    this.scheduledTasks = [];
    this.logger.info('All scheduled tasks stopped');
  }

  /**
   * Reload configuration and reschedule tasks.
   */
  reload(executeTask: (channel: string, prompt: string) => Promise<void>): void {
    this.config = null;
    this.scheduleAll(executeTask);
  }

  /**
   * Get the current configuration for display.
   */
  getTasksInfo(): string {
    const config = this.loadConfiguration();
    if (!config || config.tasks.length === 0) {
      return 'No scheduled tasks configured.';
    }

    let info = '⏰ **Scheduled Tasks:**\n\n';

    for (const task of config.tasks) {
      const status = task.enabled === false ? '🔴 Disabled' : '🟢 Enabled';
      const description = task.description || task.prompt;
      info += `• **${description}**\n`;
      info += `  Channel: \`${task.channel}\`\n`;
      info += `  Schedule: \`${task.cron}\`\n`;
      info += `  Prompt: \`${task.prompt}\`\n`;
      info += `  Status: ${status}\n\n`;
    }

    return info;
  }
}
