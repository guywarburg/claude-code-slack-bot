import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import FormData from 'form-data';
import { Logger } from './logger';
import { config } from './config';
import { ProcessedFile } from './file-handler';

export interface VoiceProcessingResult {
  transcription: string;
  originalFile: ProcessedFile;
}

export class VoiceHandler {
  private logger = new Logger('VoiceHandler');

  /**
   * Check if a file is a voice/audio file
   */
  isVoiceFile(file: ProcessedFile): boolean {
    const mimetype = file.mimetype.toLowerCase();

    // Slack voice messages come as audio/webm, audio/mp4, video/webm
    // Also support standard audio formats
    return (
      mimetype.startsWith('audio/') ||
      mimetype === 'video/webm' || // Slack voice messages
      mimetype === 'video/mp4'     // Some mobile recordings
    );
  }

  /**
   * Check if voice services are available
   */
  async checkServicesAvailable(): Promise<{ stt: boolean; tts: boolean }> {
    const results = { stt: false, tts: false };

    // Check Whisper STT
    try {
      const sttResponse = await fetch(`${config.voice.sttEndpoint}/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      results.stt = sttResponse.ok;
    } catch {
      this.logger.debug('Whisper STT service not available');
    }

    // Check Kokoro TTS
    try {
      const ttsResponse = await fetch(`${config.voice.ttsEndpoint}/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      results.tts = ttsResponse.ok;
    } catch {
      this.logger.debug('Kokoro TTS service not available');
    }

    return results;
  }

  /**
   * Transcribe audio file using Whisper STT
   */
  async transcribeAudio(file: ProcessedFile): Promise<string> {
    this.logger.info('Transcribing audio file', {
      name: file.name,
      mimetype: file.mimetype,
      size: file.size
    });

    // Check file size (Whisper has 25MB limit)
    if (file.size > 25 * 1024 * 1024) {
      throw new Error('Audio file too large for transcription (max 25MB)');
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(file.path), {
      filename: file.name,
      contentType: file.mimetype,
    });
    formData.append('model', 'whisper-1');

    try {
      const response = await fetch(
        `${config.voice.sttEndpoint}/audio/transcriptions`,
        {
          method: 'POST',
          body: formData,
          headers: formData.getHeaders(),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper STT error: ${response.status} - ${errorText}`);
      }

      const result = await response.json() as { text: string };

      this.logger.info('Audio transcription successful', {
        textLength: result.text.length,
        preview: result.text.substring(0, 100)
      });

      return result.text;
    } catch (error) {
      this.logger.error('Failed to transcribe audio', error);
      throw error;
    }
  }

  /**
   * Synthesize speech from text using Kokoro TTS
   */
  async synthesizeSpeech(text: string): Promise<Buffer> {
    this.logger.info('Synthesizing speech', {
      textLength: text.length,
      preview: text.substring(0, 100)
    });

    try {
      const response = await fetch(
        `${config.voice.ttsEndpoint}/audio/speech`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.voice.ttsModel,
            voice: config.voice.ttsVoice,
            input: text,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Kokoro TTS error: ${response.status} - ${errorText}`);
      }

      const audioBuffer = await response.buffer();

      this.logger.info('Speech synthesis successful', {
        audioSize: audioBuffer.length
      });

      return audioBuffer;
    } catch (error) {
      this.logger.error('Failed to synthesize speech', error);
      throw error;
    }
  }

  /**
   * Save audio buffer to a temporary file
   */
  async saveAudioToTemp(audioBuffer: Buffer, filename: string = 'response.mp3'): Promise<string> {
    const tempDir = os.tmpdir();
    const tempPath = path.join(tempDir, `slack-voice-${Date.now()}-${filename}`);

    fs.writeFileSync(tempPath, audioBuffer);
    this.logger.debug('Saved audio to temp file', { path: tempPath, size: audioBuffer.length });

    return tempPath;
  }

  /**
   * Check if a response is too long for voice and needs summarization
   */
  isResponseTooLongForVoice(text: string): boolean {
    // Roughly 300 words or 2000 characters is about 2-3 minutes of speech
    const wordCount = text.split(/\s+/).length;
    return wordCount > 300 || text.length > 2000;
  }

  /**
   * Generate a prompt to ask Claude for a voice-friendly summary
   */
  getVoiceSummaryPrompt(originalResponse: string): string {
    return `Please summarize the following response in 2-3 sentences suitable for a voice message. Keep it conversational and natural-sounding, as it will be spoken aloud:

---
${originalResponse}
---

Provide only the summary, no additional commentary.`;
  }

  /**
   * Clean up temporary audio file
   */
  async cleanupTempFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug('Cleaned up temp audio file', { path: filePath });
      }
    } catch (error) {
      this.logger.warn('Failed to cleanup temp audio file', { path: filePath, error });
    }
  }
}
