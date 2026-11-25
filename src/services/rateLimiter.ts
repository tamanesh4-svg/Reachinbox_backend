
import { redis } from "../config/redis";
import { env } from "../config/env";

export type SlotResult =
  | { allowed: true; nextSendAt: number }
  | { allowed: false; retryAt: number };

// Atomic reservation enforcing:
// 1. Global per-sender hourly limit.
// 2. Per-campaign hourly limit.
// 3. Minimum delay between emails from the same sender.
//
// Redis TIME is used to avoid clock differences between workers.

const script = `
local nowParts = redis.call('TIME')
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)

local hour = math.floor(now / 3600000)

local senderCountKey = KEYS[1] .. ':' .. hour
local campaignCountKey = KEYS[2] .. ':' .. hour
local paceKey = KEYS[3]

local senderCap = tonumber(ARGV[1])
local campaignCap = tonumber(ARGV[2])
local minGap = tonumber(ARGV[3])

local senderCount = tonumber(redis.call('GET', senderCountKey) or '0')
local campaignCount = tonumber(redis.call('GET', campaignCountKey) or '0')

-- Check global sender hourly limit.
if senderCount >= senderCap then
  return {0, (hour + 1) * 3600000}
end

-- Check campaign-specific hourly limit.
if campaignCount >= campaignCap then
  return {0, (hour + 1) * 3600000}
end

-- Check minimum delay between emails from this sender.
local last = tonumber(redis.call('GET', paceKey) or '0')
local nextAt = math.max(now, last + minGap)

if nextAt > now then
  return {0, nextAt}
end

-- Reserve both counters atomically.
redis.call('INCR', senderCountKey)
redis.call('EXPIRE', senderCountKey, 172800)

redis.call('INCR', campaignCountKey)
redis.call('EXPIRE', campaignCountKey, 172800)

redis.call('SET', paceKey, now, 'PX', 86400000)

return {1, now}
`;

export async function reserveSendSlot(
  senderId: string,
  campaignId: string,
  campaignHourlyLimit: number
): Promise<SlotResult> {
  const senderLimit = Number(env.maxEmailsPerHour);
  const campaignLimit = Number(campaignHourlyLimit);
  const minGap = Number(env.minEmailDelayMs);

  if (
    !Number.isInteger(senderLimit) ||
    senderLimit < 1 ||
    !Number.isInteger(campaignLimit) ||
    campaignLimit < 1 ||
    !Number.isFinite(minGap) ||
    minGap < 0
  ) {
    throw new Error("Invalid email rate-limit configuration.");
  }

  const result = await redis.eval(
    script,
    3,
    `rate:sender:${senderId}`,
    `rate:campaign:${campaignId}`,
    `pace:sender:${senderId}`,
    senderLimit,
    campaignLimit,
    minGap
  ) as [number, number];

  return result[0] === 1
    ? { allowed: true, nextSendAt: result[1] }
    : { allowed: false, retryAt: result[1] };
}
