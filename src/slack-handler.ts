import { App } from '@slack/bolt';
import cron from 'node-cron';
import { ClaudeHandler, CLIMessage } from './claude-handler';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { VoiceHandler } from './voice-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { permissionServer } from './permission-mcp-server';
import { config } from './config';

export interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private voiceHandler: VoiceHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;
  private voiceServicesAvailable: { stt: boolean; tts: boolean } = { stt: false, tts: false };

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.voiceHandler = new VoiceHandler();
    this.todoManager = new TodoManager();

    // Check voice service availability on startup
    if (config.voice.enabled) {
      this.checkVoiceServices();
    }
  }

  private async checkVoiceServices(): Promise<void> {
    this.voiceServicesAvailable = await this.voiceHandler.checkServicesAvailable();
    this.logger.info('Voice services status', this.voiceServicesAvailable);
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;
    
    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    let voiceFile: ProcessedFile | undefined;
    let isVoiceMessage = false;

    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      // Check if any file is a voice message
      voiceFile = processedFiles.find(f => f.isAudio);
      isVoiceMessage = !!voiceFile && config.voice.enabled;

      if (processedFiles.length > 0) {
        const fileIcon = isVoiceMessage ? '🎤' : '📎';
        const fileDescription = isVoiceMessage
          ? 'voice message'
          : `${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`;

        try {
          await say({
            text: `${fileIcon} Processing ${fileDescription}`,
            thread_ts: thread_ts || ts,
          });
        } catch (error) {
          this.logger.error('Failed to send file processing notification', {
            error: (error as Error).message,
            channel,
            thread_ts: thread_ts || null,
            ts,
          });
          // Continue processing even if the notification fails
        }
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
      isVoiceMessage,
      channelStartsWithD: channel?.startsWith('D'),
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      // Log detailed debug info when working directory lookup fails
      this.logger.warn('Working directory lookup failed', {
        channel,
        thread_ts: thread_ts || null,
        ts,
        isDM,
        hasChannelConfig: this.workingDirManager.hasChannelWorkingDirectory(channel),
        isVoiceMessage,
        fileCount: processedFiles.length,
      });

      let errorMessage = `⚠️ No working directory set. `;

      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }

      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Handle voice message transcription
      let voiceTranscription: string | undefined;
      if (isVoiceMessage && voiceFile) {
        // Check if voice services are available
        if (!this.voiceServicesAvailable.stt) {
          await this.checkVoiceServices();
        }

        if (!this.voiceServicesAvailable.stt) {
          await say({
            text: '⚠️ Voice transcription service is not available. Please ensure Whisper is running (`voicemode service whisper start`)',
            thread_ts: thread_ts || ts,
          });
          await this.fileHandler.cleanupTempFiles(processedFiles);
          return;
        }

        try {
          voiceTranscription = await this.voiceHandler.transcribeAudio(voiceFile);
          this.logger.info('Voice transcription completed', {
            textLength: voiceTranscription.length,
            preview: voiceTranscription.substring(0, 100)
          });

          // Show the transcription to the user
          await say({
            text: `📝 *Transcription:*\n> ${voiceTranscription}`,
            thread_ts: thread_ts || ts,
          });
        } catch (transcriptionError) {
          this.logger.error('Voice transcription failed', transcriptionError);
          await say({
            text: `❌ Failed to transcribe voice message: ${(transcriptionError as Error).message}`,
            thread_ts: thread_ts || ts,
          });
          await this.fileHandler.cleanupTempFiles(processedFiles);
          return;
        }
      }

      // Prepare the prompt - use transcription for voice messages
      let finalPrompt: string;
      if (isVoiceMessage && voiceTranscription) {
        // For voice messages, use transcription + any additional text
        finalPrompt = voiceTranscription + (text ? `\n\nAdditional context: ${text}` : '');
      } else if (processedFiles.length > 0) {
        finalPrompt = await this.fileHandler.formatFilePrompt(processedFiles, text || '');
      } else {
        finalPrompt = text || '';
      }

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, 'thinking_face');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user
      };
      
      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, 'gear');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) => 
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              
              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });
          
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, 'white_check_mark');

      // Handle voice response if this was a voice message
      if (isVoiceMessage && currentMessages.length > 0) {
        await this.handleVoiceResponse(
          currentMessages.join('\n\n'),
          channel,
          thread_ts || ts,
          session,
          say
        );
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, 'x');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, 'stop_button');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  /**
   * Process a queued message from the offline queue.
   * Creates a synthetic say function and calls handleMessage().
   */
  async processQueuedMessage(message: MessageEvent): Promise<void> {
    this.logger.info('Processing queued message', {
      channel: message.channel,
      user: message.user,
      ts: message.ts,
      thread_ts: message.thread_ts,
      textPreview: message.text?.substring(0, 50),
    });

    // Create a synthetic say function that posts messages to the channel
    const say = async (opts: { text: string; thread_ts?: string }) => {
      try {
        const result = await this.app.client.chat.postMessage({
          channel: message.channel,
          text: opts.text,
          thread_ts: opts.thread_ts,
        });
        return { ts: result.ts };
      } catch (error) {
        this.logger.error('Failed to post message from queue', error);
        throw error;
      }
    };

    await this.handleMessage(message, say);
  }

  private extractTextContent(message: CLIMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise'; // Tasks in progress
    } else {
      emoji = 'clipboard'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private async handleVoiceResponse(
    responseText: string,
    channel: string,
    threadTs: string,
    session: any,
    say: any
  ): Promise<void> {
    this.logger.info('Starting voice response generation', {
      responseLength: responseText.length,
      channel,
      threadTs,
      responseMode: config.voice.responseMode,
      ttsAvailable: this.voiceServicesAvailable.tts,
    });

    // Check if TTS is available
    if (!this.voiceServicesAvailable.tts) {
      this.logger.info('TTS not cached as available, rechecking services...');
      await this.checkVoiceServices();
    }

    if (!this.voiceServicesAvailable.tts) {
      this.logger.warn('TTS service not available after recheck, skipping voice response');
      return;
    }

    // Check response mode
    if (config.voice.responseMode === 'text') {
      this.logger.info('Voice response mode is text-only, skipping TTS');
      return;
    }

    try {
      let textToSpeak = responseText;

      // If response is too long, ask Claude for a summary
      if (this.voiceHandler.isResponseTooLongForVoice(responseText)) {
        this.logger.info('Response too long for voice, requesting summary');

        await say({
          text: '🔊 *Generating voice summary...*',
          thread_ts: threadTs,
        });

        // Get a summary from Claude
        const summaryPrompt = this.voiceHandler.getVoiceSummaryPrompt(responseText);
        const abortController = new AbortController();

        let summary = '';
        for await (const message of this.claudeHandler.streamQuery(
          summaryPrompt,
          session,
          abortController,
          session.workingDirectory || process.cwd(),
          { channel, threadTs, user: session.userId }
        )) {
          if (message.type === 'assistant' && message.message.content) {
            const textParts = message.message.content
              .filter((part: any) => part.type === 'text')
              .map((part: any) => part.text);
            summary += textParts.join('');
          } else if (message.type === 'result' && message.subtype === 'success') {
            if ((message as any).result) {
              summary = (message as any).result;
            }
          }
        }

        if (summary) {
          textToSpeak = summary;
          this.logger.info('Using summarized response for voice', {
            originalLength: responseText.length,
            summaryLength: summary.length
          });
        }
      }

      // Synthesize speech
      this.logger.info('Synthesizing voice response', {
        textLength: textToSpeak.length,
        textPreview: textToSpeak.substring(0, 100),
        ttsEndpoint: config.voice.ttsEndpoint,
      });
      const audioBuffer = await this.voiceHandler.synthesizeSpeech(textToSpeak);
      this.logger.info('Speech synthesis successful', { audioSize: audioBuffer.length });

      // Save to temp file
      const tempAudioPath = await this.voiceHandler.saveAudioToTemp(audioBuffer, 'response.mp3');
      this.logger.info('Audio saved to temp file', { path: tempAudioPath });

      try {
        // Upload audio to Slack using files.uploadV2
        this.logger.info('Uploading voice response to Slack', { channel, threadTs });
        await this.app.client.filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          file: tempAudioPath,
          filename: 'voice_response.mp3',
          title: 'Voice Response',
        });

        this.logger.info('Voice response uploaded to Slack successfully');
      } finally {
        // Clean up temp file
        await this.voiceHandler.cleanupTempFile(tempAudioPath);
      }
    } catch (error: any) {
      this.logger.error('Failed to generate voice response', {
        error: error.message || error,
        stack: error.stack,
        code: error.code,
        ttsEndpoint: config.voice.ttsEndpoint,
      });
      // Don't fail the whole message, just log the error
      await say({
        text: `⚠️ Could not generate voice response: ${error.message || 'Unknown error'}`,
        thread_ts: threadTs,
      });
    }
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  /**
   * Execute a scheduled task by directly invoking the Claude handler.
   * This simulates an internal message without needing an external trigger.
   */
  async executeScheduledTask(channel: string, prompt: string): Promise<void> {
    this.logger.info('Executing scheduled task', { channel, prompt });

    // Resolve channel name to ID if needed (e.g., #sentry -> C12345)
    let channelId = channel;
    if (channel.startsWith('#')) {
      try {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          limit: 1000,
        });
        const channelName = channel.slice(1);
        const found = result.channels?.find((c: any) => c.name === channelName);
        if (found?.id) {
          channelId = found.id;
        } else {
          this.logger.error('Channel not found', { channel });
          return;
        }
      } catch (error) {
        this.logger.error('Failed to resolve channel', error);
        return;
      }
    }

    // Get working directory for this channel
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channelId);
    if (!workingDirectory) {
      this.logger.error('No working directory set for scheduled task channel', { channel, channelId });
      return;
    }

    // Create a synthetic session for the scheduled task
    const systemUser = 'SYSTEM';
    const sessionKey = this.claudeHandler.getSessionKey(systemUser, channelId, `scheduled-${Date.now()}`);

    let session = this.claudeHandler.createSession(systemUser, channelId, `scheduled-${Date.now()}`);
    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    // Post initial status message
    let statusMessageTs: string | undefined;
    let threadTs: string | undefined;

    try {
      const statusResult = await this.app.client.chat.postMessage({
        channel: channelId,
        text: '🤔 *Running scheduled task...*',
      });
      statusMessageTs = statusResult.ts as string;
      threadTs = statusResult.ts as string;

      // Store for reaction updates
      if (statusMessageTs) {
        this.originalMessages.set(sessionKey, { channel: channelId, ts: statusMessageTs });
      }

      await this.updateMessageReaction(sessionKey, 'thinking_face');

      const slackContext = {
        channel: channelId,
        threadTs,
        user: systemUser
      };

      let currentMessages: string[] = [];

      for await (const message of this.claudeHandler.streamQuery(prompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel: channelId,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }
            await this.updateMessageReaction(sessionKey, 'gear');

            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool && threadTs) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channelId, threadTs, async (opts: any) => {
                return await this.app.client.chat.postMessage({
                  channel: channelId,
                  thread_ts: opts.thread_ts,
                  text: opts.text,
                });
              });
            }

            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent && threadTs) {
              await this.app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: toolContent,
              });
            }
          } else {
            const content = this.extractTextContent(message);
            if (content && threadTs) {
              currentMessages.push(content);
              const formatted = this.formatMessage(content, false);
              await this.app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: formatted,
              });
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult) && threadTs) {
              const formatted = this.formatMessage(finalResult, true);
              await this.app.client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: formatted,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel: channelId,
          ts: statusMessageTs,
          text: '✅ *Scheduled task completed*',
        });
      }
      await this.updateMessageReaction(sessionKey, 'white_check_mark');

      this.logger.info('Scheduled task completed', { channel, sessionKey });
    } catch (error: any) {
      this.logger.error('Error executing scheduled task', error);

      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel: channelId,
          ts: statusMessageTs,
          text: '❌ *Scheduled task failed*',
        });
      }
      await this.updateMessageReaction(sessionKey, 'x');

      if (threadTs) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Error: ${error.message || 'Something went wrong'}`,
        });
      }
    } finally {
      this.activeControllers.delete(sessionKey);

      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        const fileEvent = event as any;

        // Log full event details to debug voice message thread context loss
        this.logger.info('Handling file upload event', {
          channel: fileEvent.channel,
          thread_ts: fileEvent.thread_ts || null,
          ts: fileEvent.ts,
          user: fileEvent.user,
          filesCount: fileEvent.files?.length,
          hasText: !!fileEvent.text,
          // Additional fields that might help debug
          parent_user_id: fileEvent.parent_user_id || null,
          channel_type: fileEvent.channel_type || null,
          // Check if this is a reply without thread_ts (potential Slack bug)
          eventKeys: Object.keys(fileEvent).sort().join(','),
        });

        // WORKAROUND: For voice clips and other file uploads in threads,
        // Slack sometimes doesn't include thread_ts. Try to detect and fix this.
        let messageEvent = event as MessageEvent;

        // If we have parent_user_id but no thread_ts, this might be a reply
        // that lost its thread context (common with voice clips)
        if (!fileEvent.thread_ts && fileEvent.parent_user_id) {
          this.logger.warn('File upload appears to be a reply but missing thread_ts', {
            channel: fileEvent.channel,
            parent_user_id: fileEvent.parent_user_id,
            ts: fileEvent.ts,
          });
        }

        await this.handleMessage(messageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });
      
      permissionServer.resolveApproval(approvalId, true);
      
      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      permissionServer.resolveApproval(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Daily scheduled task to #sentry at 9:00 AM local time
    cron.schedule('0 9 * * *', async () => {
      this.logger.info('Running scheduled triage-sentry task');
      await this.executeScheduledTask('#sentry', 'triage-sentry');
    });

    this.logger.info('Scheduled daily 9:00 AM triage-sentry task to #sentry');

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}