import dotenv from "dotenv";
dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",

  port: Number(process.env.PORT || 5000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL!,

  redisHost: process.env.REDIS_HOST || "127.0.0.1",
  redisPort: Number(process.env.REDIS_PORT || 6379),
  redisPassword: process.env.REDIS_PASSWORD || undefined,

  elasticsearchUrl: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
  elasticsearchIndex: process.env.ELASTICSEARCH_INDEX || "emails",

  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 5),
  minEmailDelayMs: Number(process.env.MIN_EMAIL_DELAY_MS || 2000),
  maxEmailsPerHour: Number(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER || 100),

  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  slackChannelId: process.env.SLACK_CHANNEL_ID || "",
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || "",

  elasticsearchApiKey: process.env.ELASTICSEARCH_API_KEY || "",

  slackClientId: process.env.SLACK_CLIENT_ID || "",
  slackClientSecret: process.env.SLACK_CLIENT_SECRET || "",
  slackRedirectUri: process.env.SLACK_REDIRECT_URI || "",

  encryptionKey: process.env.ENCRYPTION_KEY || "",

  etherealHost: process.env.ETHEREAL_HOST || "smtp.ethereal.email",
  etherealPort: Number(process.env.ETHEREAL_PORT || 587)
};