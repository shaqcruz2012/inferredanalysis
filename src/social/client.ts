/**
 * Social Client Factory
 *
 * Creates a social client based on available credentials.
 * Priority: Telegram (simplest, free) > Twitter/X > signed relay fallback.
 *
 * Env vars checked:
 *   TELEGRAM_BOT_TOKEN → Telegram adapter
 *   TWITTER_BEARER_TOKEN + TWITTER_API_KEY → Twitter adapter
 */

import type { PrivateKeyAccount } from "viem";
import type { SocialClientInterface } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { validateRelayUrl } from "./validation.js";
import { signSendPayload, signPollPayload, MESSAGE_LIMITS } from "./signing.js";
const logger = createLogger("social");

export function createSocialClient(
  _relayUrl: string,
  _account: PrivateKeyAccount,
  _db?: import("better-sqlite3").Database,
): SocialClientInterface {
  // Validate the relay URL upfront (throws on HTTP or invalid)
  validateRelayUrl(_relayUrl);

  // Try Telegram first
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    logger.info("Social relay: Telegram bot enabled");
    let client: SocialClientInterface | null = null;
    const getClient = async (): Promise<SocialClientInterface> => {
      if (!client) {
        const { createTelegramClient } = await import("./telegram.js");
        client = createTelegramClient(telegramToken);
      }
      return client;
    };
    return {
      send: async (to: string, content: string, replyTo?: string) =>
        (await getClient()).send(to, content, replyTo),
      poll: async (cursor?: string, limit?: number) =>
        (await getClient()).poll(cursor, limit),
      unreadCount: async () => (await getClient()).unreadCount(),
    };
  }

  // Try Twitter/X
  const twitterBearer = process.env.TWITTER_BEARER_TOKEN;
  const twitterApiKey = process.env.TWITTER_API_KEY;
  if (twitterBearer && twitterApiKey) {
    const twitterUsername = process.env.TWITTER_USERNAME;
    if (!twitterUsername) {
      logger.warn("TWITTER_USERNAME not set — skipping Twitter adapter despite having API keys");
    } else {
      logger.info("Social relay: Twitter/X enabled");
      let client: SocialClientInterface | null = null;
      const getClient = async (): Promise<SocialClientInterface> => {
        if (!client) {
          const { createTwitterClient } = await import("./twitter.js");
          client = createTwitterClient({
            bearerToken: twitterBearer,
            apiKey: twitterApiKey,
            apiSecret: process.env.TWITTER_API_SECRET || "",
            accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
            accessSecret: process.env.TWITTER_ACCESS_SECRET || "",
            username: twitterUsername,
          });
        }
        return client;
      };
      return {
        send: async (to: string, content: string, replyTo?: string) =>
          (await getClient()).send(to, content, replyTo),
        poll: async (cursor?: string, limit?: number) =>
          (await getClient()).poll(cursor, limit),
        unreadCount: async () => (await getClient()).unreadCount(),
      };
    }
  }

  // Fallback to signed relay client
  logger.info("Social relay: using signed relay client");

  // Rate limiting state
  const sendTimestamps: number[] = [];

  function checkRateLimit(): void {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    // Remove timestamps older than one hour
    while (sendTimestamps.length > 0 && sendTimestamps[0] < oneHourAgo) {
      sendTimestamps.shift();
    }
    if (sendTimestamps.length >= MESSAGE_LIMITS.maxOutboundPerHour) {
      throw new Error("Rate limit exceeded: too many messages in the last hour");
    }
  }

  return {
    send: async (to: string, content: string, replyTo?: string) => {
      checkRateLimit();
      sendTimestamps.push(Date.now());

      const payload = await signSendPayload(_account, to, content, replyTo);

      const response = await fetch(`${_relayUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Send failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    poll: async (cursor?: string, limit?: number) => {
      const pollPayload = await signPollPayload(_account);

      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (limit != null) params.set("limit", String(limit));
      params.set("address", pollPayload.address);
      params.set("signature", pollPayload.signature);
      params.set("timestamp", pollPayload.timestamp);

      const response = await fetch(`${_relayUrl}/poll?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Poll failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    unreadCount: async () => {
      const pollPayload = await signPollPayload(_account);

      const params = new URLSearchParams();
      params.set("address", pollPayload.address);
      params.set("signature", pollPayload.signature);
      params.set("timestamp", pollPayload.timestamp);

      const response = await fetch(`${_relayUrl}/unread?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Unread count failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.count ?? 0;
    },
  };
}
