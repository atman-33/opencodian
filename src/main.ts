/**
 * Opencodian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 */

import { existsSync } from "fs";
import { Plugin } from "obsidian";

import { OpenCodeService } from "./core/agent";
import type { Conversation, ConversationMeta, OpencodianSettings } from "./core/types";
import { DEFAULT_SETTINGS, VIEW_TYPE_OPENCODIAN } from "./core/types";
import { SessionStorage } from "./core/storage";
import { OpencodianView } from "./features/chat/OpencodianView";
import { OpencodianSettingTab } from "./features/settings/OpencodianSettings";

/**
 * Main plugin class for Opencodian
 */
export default class OpencodianPlugin extends Plugin {
  settings: OpencodianSettings;
  agentService: OpenCodeService;
  sessionStorage: SessionStorage;
  private conversations: ConversationMeta[] = [];
  private activeConversationId: string | null = null;
  private activeConversation: Conversation | null = null;

  async onload() {
    await this.loadSettings();

    // Initialize OpenCode service
    this.agentService = new OpenCodeService();
    this.agentService.setApp(this.app);
    this.agentService.setDebugEnabled(this.settings.debugLogging);

    // Auto-detect opencode path if not set
    if (!this.settings.opencodePath) {
      console.log("[Opencodian] OpenCode path not set, attempting auto-detection...");
      const detectedPath = await this.agentService.detectOpencodePath();
      if (detectedPath) {
        this.settings.opencodePath = detectedPath;
        await this.saveSettings();
        console.log(`[Opencodian] Auto-detected opencode path: ${detectedPath}`);
      } else {
        console.warn("[Opencodian] Failed to auto-detect opencode path. Please set it manually in settings.");
      }
    } else {
      // Validate existing path - fix missing extension on Windows
      const platform = process.platform;
      let path = this.settings.opencodePath;
      if (platform === "win32" && !path.match(/\.(exe|cmd|bat|ps1)$/i)) {
        // Try adding .cmd extension
        const fixedPath = path + ".cmd";
        if (existsSync(fixedPath)) {
          console.log(`[Opencodian] Fixed path: ${path} -> ${fixedPath}`);
          path = fixedPath;
          this.settings.opencodePath = path;
          await this.saveSettings();
        }
      }
      console.log(`[Opencodian] Using configured opencode path: ${path}`);
    }

    this.agentService.setOpencodePath(this.settings.opencodePath);

    // Register view
    this.registerView(
      VIEW_TYPE_OPENCODIAN,
      (leaf) => new OpencodianView(leaf, this)
    );

    // Add ribbon icon
    this.addRibbonIcon("bot", "Open Opencodian", () => {
      this.activateView();
    });

    // Add command
    this.addCommand({
      id: "open-view",
      name: "Open chat view",
      callback: () => {
        this.activateView();
      },
    });

    // Add settings tab
    this.addSettingTab(new OpencodianSettingTab(this.app, this));

    // Create initial conversation if none exists
    if (this.conversations.length === 0) {
      await this.createConversation();
    }
  }

  onunload() {
    this.agentService.cleanup();
  }

  /** Opens the Opencodian sidebar view */
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_OPENCODIAN)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_OPENCODIAN,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /** Load settings from disk */
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    this.sessionStorage = new SessionStorage(this.app);

    await this.migrateLegacyConversations(data);

    this.conversations = await this.sessionStorage.listConversations();
    this.activeConversationId = this.settings.activeConversationId;

    const activeStillExists = this.activeConversationId
      ? this.conversations.some((c) => c.id === this.activeConversationId)
      : false;

    if (!activeStillExists) {
      this.activeConversationId = this.conversations[0]?.id ?? null;
      this.settings.activeConversationId = this.activeConversationId;
      await this.saveData(this.settings);
    }
  }

  /** Save settings to disk */
  async saveSettings() {
    this.settings.activeConversationId = this.activeConversationId;
    await this.saveData(this.settings);
  }

  /** Create a new conversation */
  async createConversation(): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      id: `conv-${now}-${Math.random().toString(36).substring(2, 11)}`,
      title: new Date(now).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      messages: [],
    };

    await this.sessionStorage.saveConversation(conversation);

    this.conversations = await this.sessionStorage.listConversations();
    this.activeConversationId = conversation.id;
    this.activeConversation = conversation;
    this.agentService.setSessionId(null);

    await this.saveSettings();
    return conversation;
  }

  async loadConversation(conversationId: string): Promise<Conversation | null> {
    const conversation = await this.sessionStorage.loadConversation(conversationId);
    if (!conversation) return null;

    this.activeConversation = conversation;
    this.activeConversationId = conversation.id;
    this.agentService.setSessionId(conversation.sessionId ?? null);
    return conversation;
  }

  /** Get the active conversation */
  getActiveConversation(): Conversation | null {
    if (!this.activeConversationId) return null;
    if (this.activeConversation?.id === this.activeConversationId) {
      return this.activeConversation;
    }
    return null;
  }

  /** Get all conversation metadata */
  getConversations(): ConversationMeta[] {
    return this.conversations;
  }

  /** Save the active conversation */
  async saveConversation(conversation: Conversation): Promise<void> {
    const now = Date.now();
    conversation.updatedAt = now;
    await this.sessionStorage.saveConversation(conversation);

    if (this.activeConversation?.id === conversation.id) {
      this.activeConversation = conversation;
    }

    this.conversations = await this.sessionStorage.listConversations();
  }

  async ensureConversationSession(conversation: Conversation): Promise<void> {
    if (conversation.sessionId) return;

    const sessionId = await this.agentService.ensureSessionId(
      this.settings.permissionMode,
    );
    conversation.sessionId = sessionId;
    await this.sessionStorage.saveConversation(conversation);

    if (this.activeConversation?.id === conversation.id) {
      this.activeConversation = conversation;
    }
  }

  /** Switch to a different conversation */
  async switchConversation(conversationId: string): Promise<void> {
    const exists = this.conversations.some((c) => c.id === conversationId);
    if (!exists) return;

    this.activeConversationId = conversationId;
    this.activeConversation = null;
    this.agentService.setSessionId(null);
    await this.saveSettings();
  }

  /** Delete a conversation */
  async deleteConversation(conversationId: string): Promise<void> {
    await this.sessionStorage.deleteConversation(conversationId);

    this.conversations = await this.sessionStorage.listConversations();

    if (this.activeConversationId === conversationId) {
      this.activeConversationId = this.conversations[0]?.id ?? null;
      this.activeConversation = null;

      if (!this.activeConversationId) {
        await this.createConversation();
        return;
      }

      this.agentService.setSessionId(null);
      await this.saveSettings();
      return;
    }

    await this.saveSettings();
  }

  /** Rename a conversation */
  async renameConversation(
    conversationId: string,
    newTitle: string,
  ): Promise<void> {
    const conversation = await this.sessionStorage.loadConversation(conversationId);
    if (!conversation) return;

    const nextTitle = newTitle.trim();
    conversation.title = nextTitle || conversation.title;
    conversation.updatedAt = Date.now();

    await this.sessionStorage.saveConversation(conversation);

    if (this.activeConversation?.id === conversation.id) {
      this.activeConversation = conversation;
    }

    this.conversations = await this.sessionStorage.listConversations();
  }

  /** Get the plugin view */
  getView(): OpencodianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENCODIAN);
    if (leaves.length > 0) {
      return leaves[0].view as OpencodianView;
    }
    return null;
  }

  private async migrateLegacyConversations(data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;

    const record = data as Record<string, unknown>;
    const legacy = record.conversations;
    if (!Array.isArray(legacy) || legacy.length === 0) return;

    const existing = await this.sessionStorage.listConversations();
    if (existing.length > 0) return;

    for (const item of legacy) {
      if (!item || typeof item !== "object") continue;

      const conv = item as Conversation;
      if (!conv.id || !conv.title || !Array.isArray(conv.messages)) continue;

      await this.sessionStorage.saveConversation(conv);
    }

    delete record.conversations;
    await this.saveData(Object.assign({}, record));
  }
}
