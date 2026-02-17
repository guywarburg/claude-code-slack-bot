import dotenv from 'dotenv';

dotenv.config();

export type VoiceResponseMode = 'voice' | 'text' | 'both';

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  voice: {
    enabled: process.env.VOICE_ENABLED === 'true',
    sttEndpoint: process.env.VOICE_STT_ENDPOINT || 'http://127.0.0.1:2022/v1',
    ttsEndpoint: process.env.VOICE_TTS_ENDPOINT || 'http://127.0.0.1:8880/v1',
    ttsVoice: process.env.VOICE_TTS_VOICE || 'af_sky',
    ttsModel: process.env.VOICE_TTS_MODEL || 'kokoro',
    responseMode: (process.env.VOICE_RESPONSE_MODE || 'voice') as VoiceResponseMode,
  },
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}