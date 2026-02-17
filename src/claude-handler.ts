import { spawn, ChildProcess } from 'child_process';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import * as fs from 'fs';
import * as path from 'path';

// CLI Message types that mirror the SDK's SDKMessage shape
export interface SystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: any[];
  [key: string]: any;
}

export interface AssistantTurnMessage {
  type: 'assistant';
  message: { role: 'assistant'; content: Array<{ type: string; text?: string; name?: string; input?: any; [key: string]: any }> };
  [key: string]: any;
}

export interface ResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  is_error?: boolean;
  [key: string]: any;
}

export type CLIMessage = SystemInitMessage | AssistantTurnMessage | ResultMessage | { type: string; [key: string]: any };

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<CLIMessage, void, unknown> {
    const cliBinary = process.env.CLAUDE_CLI_PATH || 'claude';
    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];

    // Session resume
    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    // Permission mode
    const permissionMode = process.env.PERMISSION_MODE || 'skip';
    switch (permissionMode) {
      case 'skip':
        args.push('--dangerously-skip-permissions');
        break;
      case 'allowedTools':
        const allowedTools = process.env.ALLOWED_TOOLS || 'Bash,Read,Write,Edit,MultiEdit,Grep,Glob';
        args.push('--allowedTools', allowedTools);
        break;
      case 'acceptEdits':
        args.push('--permission-mode', 'acceptEdits');
        break;
      case 'default':
        if (slackContext) {
          args.push('--permission-prompt-tool', 'mcp__permission-prompt__permission_prompt');
        }
        break;
    }

    // MCP servers configuration
    const mcpServers = this.mcpManager.getServerConfiguration();
    let mcpConfigPath: string | undefined;

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      // Add permission prompt server if we have Slack context
      let finalMcpServers = { ...mcpServers };

      if (slackContext && permissionMode === 'default') {
        const permissionServer = {
          'permission-prompt': {
            command: 'npx',
            args: ['tsx', path.join(__dirname, 'permission-mcp-server.ts')],
            env: {
              SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
              SLACK_CONTEXT: JSON.stringify(slackContext)
            }
          }
        };
        finalMcpServers = { ...finalMcpServers, ...permissionServer };
      }

      // Write MCP config to temp file
      mcpConfigPath = path.join(workingDirectory || process.cwd(), '.claude-mcp-servers.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: finalMcpServers }, null, 2));
      args.push('--mcp-config', mcpConfigPath);

      // Allow MCP tools
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext && permissionMode === 'default') {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0 && permissionMode !== 'skip') {
        args.push('--allowedTools', defaultMcpTools.join(','));
      }

      this.logger.debug('Added MCP configuration', {
        serverCount: Object.keys(finalMcpServers).length,
        servers: Object.keys(finalMcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    // Optional env-driven flags
    if (process.env.CLAUDE_MODEL) {
      args.push('--model', process.env.CLAUDE_MODEL);
    }
    if (process.env.MAX_TURNS) {
      args.push('--max-turns', process.env.MAX_TURNS);
    }
    if (process.env.APPEND_SYSTEM_PROMPT) {
      args.push('--append-system-prompt', process.env.APPEND_SYSTEM_PROMPT);
    }

    // Add the prompt as the last argument
    args.push(prompt);

    this.logger.debug('Claude CLI args', {
      binary: cliBinary,
      args: args.map(a => a.length > 100 ? a.substring(0, 100) + '...' : a),
      workingDirectory
    });

    // Spawn the process
    const proc = spawn(cliBinary, args, {
      cwd: workingDirectory || process.cwd(),
      env: { ...process.env, CLAUDE_CODE_HEADLESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wire abort controller
    const abortHandler = () => {
      this.logger.debug('Aborting CLI process');
      proc.kill('SIGTERM');
    };

    if (abortController) {
      abortController.signal.addEventListener('abort', abortHandler);
    }

    // Collect stderr for error reporting
    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    // Parse JSONL from stdout
    let buffer = '';
    let processExited = false;
    let exitCode: number | null = null;

    const exitPromise = new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        processExited = true;
        exitCode = code;
        resolve();
      });
    });

    try {
      for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const message: CLIMessage = JSON.parse(trimmed);

            // Capture session_id from init message
            if (message.type === 'system' && message.subtype === 'init' && session) {
              session.sessionId = message.session_id;
              this.logger.info('Session initialized', {
                sessionId: message.session_id,
                model: message.model,
                tools: message.tools?.length || 0,
              });
            }

            yield message;
          } catch {
            // Non-JSON verbose output — skip
            this.logger.debug('Non-JSON output from CLI', { line: trimmed.substring(0, 100) });
            continue;
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const message: CLIMessage = JSON.parse(buffer.trim());
          if (message.type === 'system' && message.subtype === 'init' && session) {
            session.sessionId = message.session_id;
          }
          yield message;
        } catch {
          // Non-JSON output
        }
      }

      // Wait for process to fully exit
      await exitPromise;

      // If non-zero exit code and not aborted, yield a synthetic error result
      if (exitCode !== 0 && exitCode !== null && !abortController?.signal.aborted) {
        const stderr = stderrChunks.join('');
        this.logger.error('CLI exited with error', { exitCode, stderr: stderr.substring(0, 500) });
        yield {
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: `CLI exited with code ${exitCode}. ${stderr}`.trim(),
        };
      }
    } finally {
      // Cleanup
      if (abortController) {
        abortController.signal.removeEventListener('abort', abortHandler);
      }

      // Clean up temp MCP config file
      if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch (e) {
          this.logger.warn('Failed to cleanup MCP config file', { path: mcpConfigPath });
        }
      }
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}
