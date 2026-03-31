/**
 * Alerting Skill
 *
 * Multi-channel alerting system with rate limiting, alert history,
 * muting, and configurable thresholds. Supports console, webhook,
 * and Telegram channels.
 */

import { createLogger } from "../observability/logger.js";
import type { Skill } from "../types.js";

const logger = createLogger("skills.alerting");

// ─── Types ──────────────────────────────────────────────────────

export type AlertLevel = "info" | "warning" | "critical";
export type ChannelType = "console" | "webhook" | "telegram";

export interface AlertRecord {
  id: string;
  level: AlertLevel;
  message: string;
  channel: ChannelType;
  sent_at: string;
  delivered: boolean;
  error?: string;
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export type ChannelConfig =
  | { type: "console" }
  | { type: "webhook"; config: WebhookConfig }
  | { type: "telegram"; config: TelegramConfig };

export interface MuteRule {
  pattern: RegExp;
  until: number; // epoch ms
}

export interface AlertThresholds {
  /** Minimum seconds between duplicate alerts */
  rateLimitSeconds: number;
  /** Maximum alerts per minute before auto-mute */
  maxAlertsPerMinute: number;
}

// ─── Default Configuration ──────────────────────────────────────

const DEFAULT_THRESHOLDS: AlertThresholds = {
  rateLimitSeconds: 60,
  maxAlertsPerMinute: 10,
};

// ─── Alerting Manager ───────────────────────────────────────────

export class AlertingManager {
  private channels: Map<ChannelType, ChannelConfig> = new Map();
  private history: AlertRecord[] = [];
  private muteRules: MuteRule[] = [];
  private recentAlerts: Map<string, number> = new Map(); // dedup key -> epoch ms
  private alertTimestamps: number[] = []; // for rate limiting
  private thresholds: AlertThresholds;

  constructor(thresholds?: Partial<AlertThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    // Console channel is always available
    this.channels.set("console", { type: "console" });
    logger.info("AlertingManager initialized");
  }

  /**
   * Configure an alert channel.
   */
  configureChannel(channelConfig: ChannelConfig): void {
    this.channels.set(channelConfig.type, channelConfig);
    logger.info("Alert channel configured", { type: channelConfig.type });
  }

  /**
   * Send an alert. Returns the alert record or null if suppressed.
   *
   * @param level - Alert severity level
   * @param message - Alert message content
   * @param channel - Target channel (defaults to console; critical alerts go to all channels)
   */
  async sendAlert(
    level: AlertLevel,
    message: string,
    channel?: ChannelType,
  ): Promise<AlertRecord | null> {
    // Check mute rules
    if (this.isMuted(message)) {
      logger.info("Alert muted", { level, message: message.slice(0, 80) });
      return null;
    }

    // Check rate limit for duplicate messages
    const dedupKey = `${level}:${message}`;
    const lastSent = this.recentAlerts.get(dedupKey);
    const now = Date.now();
    if (lastSent && (now - lastSent) < this.thresholds.rateLimitSeconds * 1000) {
      logger.info("Alert rate-limited (duplicate)", { level, message: message.slice(0, 80) });
      return null;
    }

    // Check global rate limit
    this.alertTimestamps = this.alertTimestamps.filter((t) => now - t < 60_000);
    if (this.alertTimestamps.length >= this.thresholds.maxAlertsPerMinute) {
      logger.warn("Alert rate-limited (global max per minute reached)");
      return null;
    }

    this.recentAlerts.set(dedupKey, now);
    this.alertTimestamps.push(now);

    // For critical alerts, broadcast to all configured channels
    const targetChannels: ChannelType[] =
      level === "critical"
        ? Array.from(this.channels.keys())
        : [channel ?? "console"];

    let lastRecord: AlertRecord | null = null;

    for (const ch of targetChannels) {
      const record = await this.dispatchAlert(level, message, ch);
      lastRecord = record;
    }

    return lastRecord;
  }

  /**
   * Dispatch an alert to a specific channel.
   */
  private async dispatchAlert(
    level: AlertLevel,
    message: string,
    channel: ChannelType,
  ): Promise<AlertRecord> {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: AlertRecord = {
      id,
      level,
      message,
      channel,
      sent_at: new Date().toISOString(),
      delivered: false,
    };

    try {
      switch (channel) {
        case "console":
          this.sendConsoleAlert(level, message);
          record.delivered = true;
          break;

        case "webhook": {
          const cfg = this.channels.get("webhook");
          if (cfg && cfg.type === "webhook") {
            await this.sendWebhookAlert(level, message, cfg.config);
            record.delivered = true;
          } else {
            record.error = "Webhook channel not configured";
          }
          break;
        }

        case "telegram": {
          const cfg = this.channels.get("telegram");
          if (cfg && cfg.type === "telegram") {
            await this.sendTelegramAlert(level, message, cfg.config);
            record.delivered = true;
          } else {
            record.error = "Telegram channel not configured";
          }
          break;
        }

        default:
          record.error = `Unknown channel: ${channel}`;
      }
    } catch (err: any) {
      record.error = err.message;
      logger.error("Alert delivery failed", { channel, error: err.message });
    }

    this.history.push(record);
    return record;
  }

  /**
   * Send alert to console (stderr for warnings/critical, stdout for info).
   */
  private sendConsoleAlert(level: AlertLevel, message: string): void {
    const prefix = `[ALERT:${level.toUpperCase()}]`;
    const formatted = `${prefix} ${new Date().toISOString()} ${message}`;

    if (level === "critical" || level === "warning") {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }

  /**
   * Send alert via webhook POST.
   */
  private async sendWebhookAlert(
    level: AlertLevel,
    message: string,
    config: WebhookConfig,
  ): Promise<void> {
    const payload = JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
    });

    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with ${response.status}: ${response.statusText}`);
    }
  }

  /**
   * Send alert via Telegram Bot API.
   */
  private async sendTelegramAlert(
    level: AlertLevel,
    message: string,
    config: TelegramConfig,
  ): Promise<void> {
    const emoji = level === "critical" ? "🚨" : level === "warning" ? "⚠️" : "ℹ️";
    const text = `${emoji} *${level.toUpperCase()}*\n${message}`;

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API error ${response.status}: ${body}`);
    }
  }

  /**
   * Get alert history, optionally filtered by a start time.
   */
  getAlertHistory(since?: string): AlertRecord[] {
    if (!since) return [...this.history];

    const sinceMs = new Date(since).getTime();
    return this.history.filter(
      (r) => new Date(r.sent_at).getTime() >= sinceMs,
    );
  }

  /**
   * Mute alerts matching a pattern for a given duration.
   *
   * @param pattern - String or regex pattern to match alert messages
   * @param durationMs - How long to mute, in milliseconds
   */
  muteAlert(pattern: string | RegExp, durationMs: number): void {
    const regex = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
    const until = Date.now() + durationMs;
    this.muteRules.push({ pattern: regex, until });
    logger.info("Alert muted", { pattern: regex.source, until: new Date(until).toISOString() });
  }

  /**
   * Check if a message is currently muted.
   */
  private isMuted(message: string): boolean {
    const now = Date.now();
    // Clean expired rules
    this.muteRules = this.muteRules.filter((r) => r.until > now);
    return this.muteRules.some((r) => r.pattern.test(message));
  }

  /**
   * Get summary of alert counts by level since a given time.
   */
  getAlertSummary(since?: string): Record<AlertLevel, number> {
    const records = this.getAlertHistory(since);
    const summary: Record<AlertLevel, number> = { info: 0, warning: 0, critical: 0 };
    for (const r of records) {
      summary[r.level]++;
    }
    return summary;
  }

  /**
   * Clear all mute rules.
   */
  clearMutes(): void {
    this.muteRules = [];
    logger.info("All mute rules cleared");
  }
}

// ─── Skill Export ───────────────────────────────────────────────

export const SKILL_METADATA: Skill = {
  name: "alerting",
  description: "Multi-channel alerting with rate limiting, muting, and history. Supports console, webhook, and Telegram.",
  autoActivate: true,
  instructions: [
    "Use the AlertingManager class to send and manage alerts.",
    "sendAlert(level, message, channel?) to dispatch an alert. Levels: info, warning, critical.",
    "Critical alerts are automatically broadcast to all configured channels.",
    "configureChannel({ type, config }) to set up webhook or Telegram channels.",
    "muteAlert(pattern, durationMs) to suppress matching alerts temporarily.",
    "getAlertHistory(since?) to retrieve past alerts.",
    "Built-in rate limiting prevents duplicate spam (default: 60s dedup, 10 alerts/min max).",
  ].join("\n"),
  source: "builtin",
  path: import.meta.url,
  enabled: true,
  installedAt: new Date().toISOString(),
};
