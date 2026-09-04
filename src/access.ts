export interface AccessConfig {
  readonly allowedOpenIds: readonly string[];
  /**
   * COREBYTE hardening: chat allowlist. Messages and card actions whose
   * chat_id is not in this list are silently dropped by the gateway before
   * any open_id check runs.
   */
  readonly allowedChatIds: readonly string[];
  readonly unauthorizedBehavior: "ignore" | "reject";
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; action: "ignore" | "reject" };

export class AccessControl {
  private readonly whitelist: Set<string>;
  private readonly chatWhitelist: Set<string>;
  private readonly unauthorizedBehavior: "ignore" | "reject";

  constructor(config: AccessConfig) {
    this.whitelist = new Set(config.allowedOpenIds);
    this.chatWhitelist = new Set(config.allowedChatIds);
    this.unauthorizedBehavior = config.unauthorizedBehavior;
  }

  /** True when `chatId` is a non-empty string present in the chat allowlist. */
  isChatAllowed(chatId: string | undefined): boolean {
    if (typeof chatId !== "string" || chatId.length === 0) return false;
    return this.chatWhitelist.has(chatId);
  }

  check(openId: string): AccessDecision {
    if (this.whitelist.has(openId)) return { allowed: true };
    return { allowed: false, action: this.unauthorizedBehavior };
  }
}
