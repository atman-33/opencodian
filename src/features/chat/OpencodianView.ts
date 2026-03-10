/**
 * Opencodian View - Main chat interface
 */

import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
  MarkdownRenderer,
  TFolder,
  Notice,
  Modal,
} from "obsidian";

import type OpencodianPlugin from "../../main";
import { VIEW_TYPE_OPENCODIAN, processProviders } from "../../core/types";
import type {
  MentionInfo,
  ProviderWithModels,
  ModelOption,
  ChatItem,
  Conversation,
} from "../../core/types";
import type { MentionContext } from "../../core/agent/OpenCodeService";
import type { SkillInfo } from "../../core/types";
import { FileMention } from "./FileMention";


/** Track active tool blocks during streaming */
interface ToolBlock {
  el: HTMLElement;
  headerEl: HTMLElement;
  contentEl: HTMLElement;
  isCollapsed: boolean;
}

export class OpencodianView extends ItemView {
  plugin: OpencodianPlugin;
  private mainContainerEl: HTMLElement;
  private historyBtnEl: HTMLElement;
  private historyDropdownEl: HTMLElement;
  private isHistoryOpen: boolean = false;
  private messagesEl: HTMLElement;
  private inputEl: HTMLElement;
  private sendButtonEl: HTMLElement;
  private isGenerating: boolean = false;
  private activeToolBlocks: Map<string, ToolBlock> = new Map();
  private currentThinkingBlock: ToolBlock | null = null;
  private welcomeMessageShown: boolean = false;
  private fileMention: FileMention | null = null;
  private currentConversation: Conversation | null = null;


  // Model selector state
  private modelSelectorEl: HTMLElement;
  private modelButtonEl: HTMLElement;
  private modelDropdownEl: HTMLElement;
  private isModelDropdownOpen: boolean = false;
  private providers: ProviderWithModels[] = [];
  private providersLoaded: boolean = false;
  private isLoadingProviders: boolean = false;
  private selectedProvider: ProviderWithModels | null = null;

  /** Inline edit state */
  private editingMessageId: string | null = null;
  private suppressAutoScroll: boolean = false;

  private createMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  constructor(leaf: WorkspaceLeaf, plugin: OpencodianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OPENCODIAN;
  }

  getDisplayText(): string {
    return "Opencodian";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("opencodian-view");

    // Create main container
    this.mainContainerEl = container.createDiv({ cls: "opencodian-container" });

    // ========== HEADER ==========
    const headerEl = this.mainContainerEl.createDiv({
      cls: "opencodian-header",
    });

    // Left: Title
    const titleEl = headerEl.createDiv({ cls: "opencodian-title" });
    titleEl.setText("Opencodian");

    // Right: Action buttons
    const actionsEl = headerEl.createDiv({ cls: "opencodian-actions" });

    // History button (clock icon)
    this.historyBtnEl = actionsEl.createDiv({
      cls: "opencodian-action-btn",
      attr: { "aria-label": "History" },
    });
    setIcon(this.historyBtnEl, "clock");
    this.historyBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    // New chat button (plus icon)
    const newChatBtn = actionsEl.createDiv({
      cls: "opencodian-action-btn",
      attr: { "aria-label": "New Chat" },
    });
    setIcon(newChatBtn, "plus");
    newChatBtn.addEventListener("click", async () => {
      await this.plugin.createConversation();
      await this.refreshView();
    });

    // ========== HISTORY DROPDOWN ==========
    this.historyDropdownEl = this.mainContainerEl.createDiv({
      cls: "opencodian-history-dropdown",
    });
    this.historyDropdownEl.style.display = "none";

    // Dropdown list container
    this.historyDropdownEl.createDiv({ cls: "dropdown-list" });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (
        this.isHistoryOpen &&
        !this.historyDropdownEl.contains(e.target as Node)
      ) {
        this.toggleHistoryDropdown(false);
      }
    });

    // ========== MESSAGES AREA ==========
    this.messagesEl = this.mainContainerEl.createDiv({
      cls: "opencodian-messages",
    });

    // ========== INPUT AREA ==========
    const inputContainer = this.mainContainerEl.createDiv({
      cls: "opencodian-input-container",
    });

    const inputWrapper = inputContainer.createDiv({
      cls: "opencodian-input-wrapper",
    });

    this.inputEl = inputWrapper.createEl("div", {
      cls: "opencodian-input",
      attr: {
        contenteditable: "true",
        role: "textbox",
        "aria-multiline": "true",
        "data-placeholder": "@ files & folders, / commands & skills",
        "data-empty": "true",
      },
    });


    // Embedded Toolbar (Model Selector + Send Button)
    const toolbarEl = inputWrapper.createDiv({
      cls: "opencodian-input-toolbar",
    });

    // Left: Model Selector
    this.createModelSelector(toolbarEl);

    // Right: Send Button
    this.sendButtonEl = toolbarEl.createEl("button", {
      cls: "opencodian-send-button",
      attr: { "aria-label": "Send" },
    });
    setIcon(this.sendButtonEl, "arrow-up");

    // Initialize mention systems BEFORE keydown listener
    // so we can check their state
    this.fileMention = new FileMention(
      this.plugin.app,
      this.inputEl,
      inputWrapper,
    );


    // Event listeners
    this.sendButtonEl.addEventListener("click", () =>
      this.handleSendButtonClick(),
    );

    this.inputEl.addEventListener("keydown", (e) => {
      if (this.fileMention?.isSuggestionsOpen()) return;

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSendButtonClick();
      }
    });

    this.inputEl.addEventListener("input", () => {
      if (!this.inputEl) return;
      const text = (this.inputEl.textContent || "").replace(/\u200B/g, "");
      this.inputEl.setAttribute("data-empty", text.length > 0 ? "false" : "true");
    });


    // Initial render
    this.renderHistoryList();
    await this.loadConversation();
  }

  async onClose(): Promise<void> {
    // Cleanup
    if (this.fileMention) {
      this.fileMention.destroy();
      this.fileMention = null;
    }
  }


  // ========== HISTORY DROPDOWN METHODS ==========

  private toggleHistoryDropdown(forceState?: boolean): void {
    this.isHistoryOpen =
      forceState !== undefined ? forceState : !this.isHistoryOpen;
    this.historyDropdownEl.style.display = this.isHistoryOpen ? "flex" : "none";
    this.historyBtnEl.classList.toggle("active", this.isHistoryOpen);

    if (this.isHistoryOpen) {
      this.renderHistoryList();
    }
  }

  private renderHistoryList(): void {
    const listContainer = this.historyDropdownEl.querySelector(
      ".dropdown-list",
    ) as HTMLElement;
    if (!listContainer) return;

    listContainer.empty();

    const conversations = this.plugin.getConversations();
    const activeId = this.plugin.settings.activeConversationId;

    for (const conv of conversations) {
      const itemEl = listContainer.createDiv({
        cls: `conversation-item ${conv.id === activeId ? "active" : ""}`,
      });

      // Content
      const contentEl = itemEl.createDiv({ cls: "conversation-content" });

      contentEl.createDiv({
        text: conv.title || "New Chat",
        cls: "conversation-title",
      });

      // Secondary info (Date)
      const dateStr = this.formatDate(conv.updatedAt);
      contentEl.createDiv({ text: dateStr, cls: "conversation-subtitle" });

      // Actions (rename, delete)
      const actionsEl = itemEl.createDiv({ cls: "conversation-actions" });

      // Rename button
      const renameBtn = actionsEl.createDiv({
        cls: "conversation-action-btn",
        attr: { "aria-label": "Rename" },
      });
      setIcon(renameBtn, "pencil");
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showInlineRename(itemEl, conv.id, conv.title);
      });

      // Delete button
      const deleteBtn = actionsEl.createDiv({
        cls: "conversation-action-btn danger",
        attr: { "aria-label": "Delete" },
      });
      setIcon(deleteBtn, "trash-2");
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.showDeleteConfirm(conv.id);
      });

      // Click to switch (on entire item, excluding actions)
      itemEl.addEventListener("click", async (e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(".conversation-actions") ||
          target.closest(".conversation-action-btn")
        ) {
          return; // Ignore clicks on action buttons or their container
        }
        e.stopPropagation();
        await this.plugin.switchConversation(conv.id);
        this.toggleHistoryDropdown(false);
        await this.refreshView();
      });
    }
  }

  private showInlineRename(
    itemEl: HTMLElement,
    convId: string,
    currentTitle: string,
  ): void {
    const titleEl = itemEl.querySelector(".conversation-title") as HTMLElement;
    const actionsEl = itemEl.querySelector(
      ".conversation-actions",
    ) as HTMLElement;
    if (!titleEl) return;

    // Hide actions
    if (actionsEl) {
      actionsEl.style.display = "none";
    }

    // Create input element
    const input = document.createElement("input");
    input.type = "text";
    input.className = "conversation-rename-input";
    input.value = currentTitle;

    // Replace title with input
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newTitle = input.value.trim() || currentTitle;
      await this.plugin.renameConversation(convId, newTitle);
      this.renderHistoryList();
    };

    input.addEventListener("blur", finishRename);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        input.value = currentTitle;
        input.blur();
      }
    });

    // Prevent click from bubbling to item (which would switch conversation)
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private async showDeleteConfirm(convId: string): Promise<void> {
    if (confirm("Delete this conversation?")) {
      await this.plugin.deleteConversation(convId);
      this.renderHistoryList();
      await this.refreshView();
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  // ========== CONVERSATION METHODS ==========

  private async refreshView(): Promise<void> {
    this.renderHistoryList();
    await this.loadConversation();
  }

  private async loadConversation(
    scrollToBottom: boolean = true,
  ): Promise<void> {
    const meta = this.plugin
      .getConversations()
      .find((c) => c.id === this.plugin.settings.activeConversationId);

    const convId = meta?.id ?? this.plugin.settings.activeConversationId;
    const conv = convId ? await this.plugin.loadConversation(convId) : null;
    this.currentConversation = conv;

    this.messagesEl.empty();

    if (!conv || conv.messages.length === 0) {
      this.showWelcomeMessage();
      return;
    }

    for (let idx = 0; idx < conv.messages.length; idx++) {
      const msg = conv.messages[idx];

      if (msg.role === "assistant" && msg.error) {
        this.addErrorMessage(msg.error);
        continue;
      }

      // Old conversations are intentionally not supported.
      if (msg.role === "assistant" && (!msg.items || msg.items.length === 0)) {
        this.addErrorMessage(
          "This conversation was created by an older Opencodian version and cannot be displayed.",
        );
        continue;
      }

      if (msg.role === "user") {
        this.addMessage(
          msg.id,
          "user",
          msg.content ?? "",
          undefined,
          msg.mentions,
          msg.skills,
        );
        continue;
      }

      const msgEl = this.addMessage(msg.id, "assistant", "");
      const bubbleEl = msgEl.querySelector(
        ".message-bubble",
      ) as HTMLElement | null;
      if (!bubbleEl) continue;

      const itemsEl = bubbleEl.createDiv({ cls: "opencodian-items" });
      for (const item of msg.items ?? []) {
        this.appendTimelineItem(itemsEl, item);
      }
    }

    if (scrollToBottom) {
      this.scrollToBottom();
    }
  }

  /**
   * Handle send button click - either send message or cancel generation
   */
  private handleSendButtonClick(): void {
    if (this.isGenerating) {
      // Cancel the current generation
      this.plugin.agentService.cancel();
      this.setGeneratingState(false);
    } else {
      // Send the message
      this.handleSend();
    }
  }

  /**
   * Update the send button state
   */
  private setGeneratingState(generating: boolean): void {
    this.isGenerating = generating;

    if (generating) {
      this.sendButtonEl.classList.add("generating");
      this.sendButtonEl.setAttribute("aria-label", "Stop");
      this.sendButtonEl.empty();
      // Create loading spinner
      const spinnerEl = document.createElement("div");
      spinnerEl.className = "opencodian-spinner";
      this.sendButtonEl.appendChild(spinnerEl);
    } else {
      this.sendButtonEl.classList.remove("generating");
      this.sendButtonEl.setAttribute("aria-label", "Send");
      this.sendButtonEl.empty();
      setIcon(this.sendButtonEl, "arrow-up");
    }
  }

  private async handleSend(): Promise<void> {
    const fileMentions = this.fileMention ? this.fileMention.getMentions() : [];
    const text = this.fileMention
      ? this.fileMention.getText()
      : this.inputEl.textContent || "";

    const skills = this.fileMention ? this.fileMention.getSkills() : [];

    if (this.fileMention) this.fileMention.clear();
    if (!this.fileMention) {
      this.inputEl.textContent = "";
    }
    this.inputEl.setAttribute("data-empty", "true");

    const skillsInfo: SkillInfo[] = skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      scope: skill.scope,
    }));

    await this.sendUserMessage(text, fileMentions, skillsInfo);
  }


  private async sendUserMessage(
    rawText: string,
    mentionItems?: Array<{ path: string; name: string; isFolder: boolean }>,
    skills?: SkillInfo[],
  ): Promise<void> {
    const text = rawText.trim();
    if (!text) return;

    const mentionItemsFinal: Array<{
      path: string;
      name: string;
      isFolder: boolean;
    }> =
      mentionItems ??
      (this.fileMention ? this.fileMention.getMentionsAndClear() : []);

    this.inputEl.textContent = "";
    this.inputEl.setAttribute("data-empty", "true");


    // Convert to MentionInfo for storage
    const mentions: MentionInfo[] = mentionItemsFinal.map((m) => ({
      path: m.path,
      name: m.name,
      isFolder: m.isFolder,
    }));

    const skillsFinal = skills && skills.length > 0 ? skills : undefined;

    // Build rich MentionContext with folder children
    const mentionContexts: MentionContext[] = mentionItemsFinal.map((m) => {
      const ctx: MentionContext = {
        path: m.path,
        name: m.name,
        isFolder: m.isFolder,
      };

      // For folders, list their direct children
      if (m.isFolder) {
        const folder = this.plugin.app.vault.getAbstractFileByPath(m.path);
        if (folder instanceof TFolder) {
          ctx.children = folder.children.map((c) => c.name);
        }
      }

      return ctx;
    });

    // Set generating state
    this.setGeneratingState(true);

     // Clear welcome message if present
     this.clearWelcomeMessage();

     if (this.plugin.settings.activeConversationId) {
       await this.plugin.loadConversation(this.plugin.settings.activeConversationId);
     }


    // Save to conversation
    const convMeta = this.plugin
      .getConversations()
      .find((c) => c.id === this.plugin.settings.activeConversationId);

    const convId = convMeta?.id ?? this.plugin.settings.activeConversationId;
     const conv = convId ? await this.plugin.loadConversation(convId) : null;
     this.currentConversation = conv;
     if (conv) {
       await this.plugin.ensureConversationSession(conv);
     }
     const messageId = this.createMessageId();


    // Add user message to UI (with mentions/skills)
    this.addMessage(
      messageId,
      "user",
      text,
      undefined,
      mentions.length > 0 ? mentions : undefined,
      skillsFinal,
    );

    if (conv) {
      conv.messages.push({
        id: messageId,
        role: "user",
        type: "message",
        content: text,
        timestamp: Date.now(),
        mentions: mentions.length > 0 ? mentions : undefined,
        skills: skillsFinal,
      });

      // Auto-title: If this is the first user message and title is default/empty, update it
      // We check if message count is 1 (just added this one) or small enough to be start
      if (conv.messages.filter((m) => m.role === "user").length === 1) {
        const newTitle =
          text.length > 50 ? text.substring(0, 50) + "..." : text;
        conv.title = newTitle;
      }

      await this.plugin.saveConversation(conv);
    }

    // Create assistant message placeholder (timeline-based)
    const assistantMsgEl = this.addMessage(null, "assistant", "");
    const bubbleEl = assistantMsgEl.querySelector(
      ".message-bubble",
    ) as HTMLElement;

    // Replace the legacy single content container with a timeline container.
    const legacyContentEl = assistantMsgEl.querySelector(
      ".message-content",
    ) as HTMLElement | null;
    if (legacyContentEl) {
      legacyContentEl.remove();
    }

    const itemsEl = bubbleEl.createDiv({ cls: "opencodian-items" });

    // Placeholder shown until the first real assistant content/tool event arrives.
    const workingEl = document.createElement("div");
    workingEl.className = "opencodian-working";
    workingEl.textContent = "Working on it...";
    itemsEl.appendChild(workingEl);

    const slowNotices = {
      first: window.setTimeout(() => {
        if (!workingEl.parentElement) return;
        workingEl.textContent =
          "Still working... This might be due to rate limiting.";
      }, 15000),
      second: window.setTimeout(() => {
        if (!workingEl.parentElement) return;
        workingEl.textContent =
          "No response yet. If this persists, consider retrying.";
      }, 30000),
    };

    this.scrollToBottom();

    const clearWorking = () => {
      window.clearTimeout(slowNotices.first);
      window.clearTimeout(slowNotices.second);
      if (workingEl.parentElement) workingEl.remove();
    };

    // Reset streaming state
    this.activeToolBlocks.clear();

    // Track timeline state at outer scope so catch block can access
    const items: ChatItem[] = [];
    const toolItemsById = new Map<string, ChatItem>();
    let pendingServerUserId: string | null = null;
    let shouldPersistItems = true;

    // The currently active (last) text item & its DOM.
    let activeTextId: string | null = null;
    let activeTextEl: HTMLElement | null = null;


    try {
      const isTextItem = (
        v: ChatItem,
      ): v is Extract<ChatItem, { type: "text" }> => v.type === "text";

      const renderActiveMarkdown = async (): Promise<void> => {
        if (!activeTextId) return;
        if (!activeTextEl) return;

        const last = items[items.length - 1];
        if (!last || !isTextItem(last) || last.id !== activeTextId) return;

        await this.renderMarkdown(last.text, activeTextEl);
      };

      // Initial loading indicator?
      // contentEl.innerHTML = '<span class="loading-dots">...</span>';

        for await (const chunk of this.plugin.agentService.query(
          text,
          undefined,
          conv?.messages,

          {
            model: this.plugin.settings.model,
            permissionMode: this.plugin.settings.permissionMode,
            mentionContexts:
              mentionContexts.length > 0 ? mentionContexts : undefined,
            allowedTools: skillsFinal?.map((s) => s.name),
            conversationId: conv?.id ?? undefined,
          },

      )) {
        if (chunk.type === "server_message") {
          if (chunk.role === "user") {
            if (pendingServerUserId && pendingServerUserId !== chunk.messageId) {
              shouldPersistItems = false;
            }
            pendingServerUserId = chunk.messageId;
          }
          continue;
        }

        if (chunk.type === "text") {

          clearWorking();

          if (activeTextId && activeTextEl) {
            const last = items[items.length - 1];
            if (last && isTextItem(last) && last.id === activeTextId) {
              last.text += chunk.content;
              activeTextEl.textContent = last.text;
            }
          } else {
            const id = this.createMessageId();
            const item: Extract<ChatItem, { type: "text" }> = {
              type: "text",
              id,
              timestamp: Date.now(),
              text: chunk.content,
            };
            items.push(item);

            const el = itemsEl.createDiv({ cls: "message-content" });
            el.textContent = chunk.content;
            activeTextId = id;
            activeTextEl = el;
          }

          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "tool_use") {
          clearWorking();

          // Close out the current text item so later text starts a new block.
          activeTextId = null;
          activeTextEl = null;

          const existing = toolItemsById.get(chunk.toolUseId);
          if (!existing) {
            const item: Extract<ChatItem, { type: "tool" }> = {
              type: "tool",
              id: chunk.toolUseId,
              timestamp: Date.now(),
              toolUseId: chunk.toolUseId,
              toolName: chunk.toolName,
              input: this.sanitizeToolInput(chunk.input),
              status: "running",
            };
            items.push(item);
            toolItemsById.set(chunk.toolUseId, item);
            this.renderToolUseBlock(
              itemsEl,
              chunk.toolName,
              item.input,
              chunk.toolUseId,
            );
          } else if (existing.type === "tool") {
            existing.toolName = chunk.toolName;
            existing.input = this.sanitizeToolInput(chunk.input);
            existing.status = "running";
            this.renderToolUseBlock(
              itemsEl,
              chunk.toolName,
              existing.input,
              chunk.toolUseId,
            );
          }

          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "tool_result") {
          clearWorking();

          const existing = toolItemsById.get(chunk.toolUseId);
          if (existing && existing.type === "tool") {
            const attachmentInfo = chunk.attachments && chunk.attachments.length > 0
              ? `\n\nAttachments: ${chunk.attachments
                  .map((attachment) => attachment.filename || attachment.url)
                  .join(", ")}`
              : "";
            existing.result = `${chunk.result}${attachmentInfo}`.trim();
            existing.status = chunk.result.trim().startsWith("Error:")
              ? "error"
              : "done";
          }

          const attachmentInfo = chunk.attachments && chunk.attachments.length > 0
            ? `\n\nAttachments: ${chunk.attachments
                .map((attachment) => attachment.filename || attachment.url)
                .join(", ")}`
            : "";
          this.renderToolResultBlock(
            chunk.toolUseId,
            `${chunk.result}${attachmentInfo}`.trim(),
          );
          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "permission_request") {
          clearWorking();
          if (this.plugin.settings.permissionMode === "yolo") {
            await this.plugin.agentService.replyToPermission(
              chunk.request.id,
              "always",
            );
            continue;
          }
          const decision = await this.requestToolApproval(chunk.request);
          await this.plugin.agentService.replyToPermission(
            chunk.request.id,
            decision,
          );
          continue;
        }

        if (chunk.type === "thinking") {
          // Intentionally ignored.
          continue;
        }

        if (chunk.type === "error") {
          clearWorking();

          this.addErrorMessage(chunk.content);

          if (conv) {
            conv.messages.push({
              id: this.createMessageId(),
              role: "assistant",
              type: "message",
              error: chunk.content,
              timestamp: Date.now(),
            });
            await this.plugin.saveConversation(conv);
          }

          this.scrollToBottom();
          this.setGeneratingState(false);
          continue;
        }

        if (chunk.type === "done") {
          clearWorking();

          await renderActiveMarkdown();

          if (items.length === 0) {
            this.addErrorMessage("No response received. Please try again.");
          }

          if (conv) {
            if (pendingServerUserId) {
              const lastUser = [...conv.messages]
                .reverse()
                .find((m): m is Conversation["messages"][number] => m.role === "user");
              if (lastUser && !lastUser.serverId) {
                lastUser.serverId = pendingServerUserId;
              }
              pendingServerUserId = null;
            }

            if (!shouldPersistItems) {
              await this.plugin.saveConversation(conv);
              this.setGeneratingState(false);
              continue;
            }

            if (items.length === 0) {
              conv.messages.push({
                id: this.createMessageId(),
                role: "assistant",
                type: "message",
                error: "No response received. Please try again.",
                timestamp: Date.now(),
              });
              await this.plugin.saveConversation(conv);
              continue;
            }

            conv.messages.push({
              id: this.createMessageId(),
              role: "assistant",
              type: "message",
              items,
              timestamp: Date.now(),
            });
            await this.plugin.saveConversation(conv);
          }


          if (conv) {
            if (pendingServerUserId) {
              const lastUser = [...conv.messages]
                .reverse()
                .find((m): m is Conversation["messages"][number] => m.role === "user");
              if (lastUser && !lastUser.serverId) {
                lastUser.serverId = pendingServerUserId;
              }
              pendingServerUserId = null;
            }

            if (items.length === 0) {
              conv.messages.push({
                id: this.createMessageId(),
                role: "assistant",
                type: "message",
                error: "No response received. Please try again.",
                timestamp: Date.now(),
              });
              await this.plugin.saveConversation(conv);
              continue;
            }

            conv.messages.push({
              id: this.createMessageId(),
              role: "assistant",
              type: "message",
              items,
              timestamp: Date.now(),
            });
            await this.plugin.saveConversation(conv);
          }


          this.setGeneratingState(false);
          continue;
        }
      }
    } catch (error) {
      clearWorking();

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(
        "[OpencodianView] Error during message generation:",
        errorMsg,
      );

      this.addErrorMessage(errorMsg);

      if (conv) {
        conv.messages.push({
          id: this.createMessageId(),
          role: "assistant",
          type: "message",
          error: errorMsg,
          timestamp: Date.now(),
        });
        await this.plugin.saveConversation(conv);
      }

      this.scrollToBottom();
      this.setGeneratingState(false);
    } finally {
      // Ensure generating state is always reset, even if error handling fails
      if (this.isGenerating) {
        console.warn(
          "[OpencodianView] Generating state still active in finally block - forcing reset",
        );
        this.setGeneratingState(false);
      }
    }
  }

  private formatToolName(toolName: string): string {
    const t = (toolName || "").trim();
    if (!t) return toolName;
    const lower = t.toLowerCase();
    return lower[0].toUpperCase() + lower.slice(1);
  }

  private scrollToBottom(force: boolean = false): void {
    if (this.suppressAutoScroll && !force) return;
    this.messagesEl.scrollTo({
      top: this.messagesEl.scrollHeight,
      behavior: "smooth",
    });
  }

  private getMessageIndex(messageId: string): number {
    const conv = this.currentConversation;
    if (!conv) return -1;
    return conv.messages.findIndex((m) => m.id === messageId);
  }

  private async editAndResend(messageId: string, text: string): Promise<void> {
    await this.pruneAndSend(messageId, text);
  }

  private async regenerateFrom(messageId: string): Promise<void> {
    const conv = this.currentConversation;
    if (!conv) return;

    const idx = this.getMessageIndex(messageId);
    if (idx < 0) return;

    const msg = conv.messages[idx];
    if (!msg || msg.role !== "user") return;

    await this.pruneAndSend(messageId, msg.content ?? "");
  }

  private async pruneAndSend(messageId: string, text: string): Promise<void> {
    if (this.isGenerating) {
      this.plugin.agentService.cancel();
      this.setGeneratingState(false);
    }

     const conv = this.currentConversation;
     if (!conv) return;

     await this.plugin.ensureConversationSession(conv);

     const resolvedIdx = this.getMessageIndex(messageId);

    if (resolvedIdx < 0 || resolvedIdx >= conv.messages.length) return;

    const original = conv.messages[resolvedIdx];
    if (original.role !== "user") return;

    if (original.serverId) {
      try {
        await this.plugin.agentService.revertSessionMessage(original.serverId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[OpencodianView] Failed to revert server message:", message);
        new Notice("Failed to revert server message. Please try again.");
        return;
      }
    } else {
      this.plugin.agentService.setSessionId(null);
      conv.sessionId = null;
      await this.plugin.saveConversation(conv);
      await this.plugin.ensureConversationSession(conv);
    }


    const messages = conv.messages.slice(0, resolvedIdx);

    const nextUser = {
      id: original.id,
      role: "user" as const,
      type: "message" as const,
      content: text,
      timestamp: Date.now(),
      mentions: original.mentions,
      skills: original.skills,
    };

    conv.messages = [...messages, nextUser];
    conv.updatedAt = Date.now();
    await this.plugin.saveConversation(conv);

    this.currentConversation = conv;

    // Hard refresh: ensure old branch disappears immediately.
    this.activeToolBlocks.clear();
    this.currentThinkingBlock = null;
    await this.loadConversation();

    this.setGeneratingState(true);

    const assistantMsgEl = this.addMessage(null, "assistant", "");
    const bubbleEl = assistantMsgEl.querySelector(
      ".message-bubble",
    ) as HTMLElement;

    const legacyContentEl = assistantMsgEl.querySelector(
      ".message-content",
    ) as HTMLElement | null;
    if (legacyContentEl) {
      legacyContentEl.remove();
    }

    const itemsEl = bubbleEl.createDiv({ cls: "opencodian-items" });

    const workingEl = document.createElement("div");
    workingEl.className = "opencodian-working";
    workingEl.textContent = "Working on it...";
    itemsEl.appendChild(workingEl);
    this.scrollToBottom();

    const clearWorking = () => {
      if (workingEl.parentElement) workingEl.remove();
    };

    const items: ChatItem[] = [];
    let pendingServerUserId: string | null = null;
    let shouldPersistItems = true;

    let activeTextId: string | null = null;
    let activeTextEl: HTMLElement | null = null;


    try {
      const isTextItem = (
        v: ChatItem,
      ): v is Extract<ChatItem, { type: "text" }> => v.type === "text";

      const toolItemsById = new Map<
        string,
        Extract<ChatItem, { type: "tool" }>
      >();

      const renderActiveMarkdown = async (): Promise<void> => {
        if (!activeTextId) return;
        if (!activeTextEl) return;

        const last = items[items.length - 1];
        if (!last || !isTextItem(last) || last.id !== activeTextId) return;

        await this.renderMarkdown(last.text, activeTextEl);
      };

        for await (const chunk of this.plugin.agentService.query(
          text,
          undefined,
          conv.messages,
          {
            model: this.plugin.settings.model,
            permissionMode: this.plugin.settings.permissionMode,
            conversationId: conv.id,
          },

        )) {
        if (chunk.type === "server_message") {
          if (chunk.role === "user") {
            if (pendingServerUserId && pendingServerUserId !== chunk.messageId) {
              shouldPersistItems = false;
            }
            pendingServerUserId = chunk.messageId;
          }
          continue;
        }

        if (chunk.type === "text") {

          clearWorking();

          if (activeTextId && activeTextEl) {
            const last = items[items.length - 1];
            if (last && isTextItem(last) && last.id === activeTextId) {
              last.text += chunk.content;
              activeTextEl.textContent = last.text;
            }
          } else {
            const id = this.createMessageId();
            const item: Extract<ChatItem, { type: "text" }> = {
              type: "text",
              id,
              timestamp: Date.now(),
              text: chunk.content,
            };
            items.push(item);

            const el = itemsEl.createDiv({ cls: "message-content" });
            el.textContent = chunk.content;
            activeTextId = id;
            activeTextEl = el;
          }

          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "tool_use") {
          clearWorking();

          // Close out the current text item so later text starts a new block.
          activeTextId = null;
          activeTextEl = null;

          const existing = toolItemsById.get(chunk.toolUseId);
          const input = this.sanitizeToolInput(chunk.input);

          if (!existing) {
            const item: Extract<ChatItem, { type: "tool" }> = {
              type: "tool",
              id: chunk.toolUseId,
              timestamp: Date.now(),
              toolUseId: chunk.toolUseId,
              toolName: chunk.toolName,
              input,
              status: "running",
            };
            items.push(item);
            toolItemsById.set(chunk.toolUseId, item);
          } else {
            existing.toolName = chunk.toolName;
            existing.input = input;
            existing.status = "running";
          }

          this.renderToolUseBlock(
            itemsEl,
            chunk.toolName,
            input,
            chunk.toolUseId,
          );
          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "tool_result") {
          clearWorking();

          const existing = toolItemsById.get(chunk.toolUseId);
          if (existing) {
            const attachmentInfo = chunk.attachments && chunk.attachments.length > 0
              ? `\n\nAttachments: ${chunk.attachments
                  .map((attachment) => attachment.filename || attachment.url)
                  .join(", ")}`
              : "";
            existing.result = `${chunk.result}${attachmentInfo}`.trim();
            existing.status = chunk.result.trim().startsWith("Error:")
              ? "error"
              : "done";
          }

          const attachmentInfo = chunk.attachments && chunk.attachments.length > 0
            ? `\n\nAttachments: ${chunk.attachments
                .map((attachment) => attachment.filename || attachment.url)
                .join(", ")}`
            : "";
          this.renderToolResultBlock(
            chunk.toolUseId,
            `${chunk.result}${attachmentInfo}`.trim(),
          );
          this.scrollToBottom();
          continue;
        }

        if (chunk.type === "permission_request") {
          clearWorking();
          if (this.plugin.settings.permissionMode === "yolo") {
            await this.plugin.agentService.replyToPermission(
              chunk.request.id,
              "always",
            );
            continue;
          }
          const decision = await this.requestToolApproval(chunk.request);
          await this.plugin.agentService.replyToPermission(
            chunk.request.id,
            decision,
          );
          continue;
        }

        if (chunk.type === "thinking") {
          continue;
        }

        if (chunk.type === "error") {
          clearWorking();
          this.addErrorMessage(chunk.content);

          conv.messages.push({
            id: this.createMessageId(),
            role: "assistant",
            type: "message",
            error: chunk.content,
            timestamp: Date.now(),
          });

          await this.plugin.saveConversation(conv);

          this.scrollToBottom();
          this.setGeneratingState(false);
          continue;
        }

        if (chunk.type === "done") {
          clearWorking();

          await renderActiveMarkdown();

          if (pendingServerUserId) {
            const lastUser = [...conv.messages]
              .reverse()
              .find((m): m is Conversation["messages"][number] => m.role === "user");
            if (lastUser && !lastUser.serverId) {
              lastUser.serverId = pendingServerUserId;
            }
            pendingServerUserId = null;
          }

          if (!shouldPersistItems) {
            await this.plugin.saveConversation(conv);
            this.scrollToBottom();
            this.setGeneratingState(false);
            continue;
          }

          if (items.length === 0) {
            const msg = "No response received. Please try again.";
            this.addErrorMessage(msg);

            conv.messages.push({
              id: this.createMessageId(),
              role: "assistant",
              type: "message",
              error: msg,
              timestamp: Date.now(),
            });

            await this.plugin.saveConversation(conv);

            this.scrollToBottom();
            this.setGeneratingState(false);
            continue;
          }

          conv.messages.push({
            id: this.createMessageId(),
            role: "assistant",
            type: "message",
            items,
            timestamp: Date.now(),
          });

          await this.plugin.saveConversation(conv);

          this.scrollToBottom();
          this.setGeneratingState(false);
          continue;
        }

      }
    } catch (error) {
      clearWorking();

      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.addErrorMessage(errorMsg);

      conv.messages.push({
        id: this.createMessageId(),
        role: "assistant",
        type: "message",
        error: errorMsg,
        timestamp: Date.now(),
      });

      await this.plugin.saveConversation(conv);

      this.scrollToBottom();
      this.setGeneratingState(false);
    } finally {
      if (this.isGenerating) {
        this.setGeneratingState(false);
      }
    }
  }

  /**
   * Append error message to content area with left-border style.
   * This is the unified error display method - all errors flow through here.
   */
  private appendError(contentEl: HTMLElement, message: string): void {
    this.appendErrorBlock(contentEl, message);
  }

  private appendErrorBlock(
    contentEl: HTMLElement,
    message: string,
  ): HTMLElement {
    const errorEl = document.createElement("div");
    errorEl.className = "opencodian-error-message";
    errorEl.textContent = message;
    contentEl.appendChild(errorEl);
    return errorEl;
  }

  private mergeErrors(
    existing: string[] | undefined,
    incoming: string[],
  ): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const e of existing || []) {
      const text = e.trim();
      if (!text) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      merged.push(text);
    }

    for (const e of incoming) {
      const text = e.trim();
      if (!text) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      merged.push(text);
    }

    // Bound size to avoid unbounded growth during flaky connections.
    const MAX_ERRORS = 10;
    return merged.slice(-MAX_ERRORS);
  }

  /**
   * Adjust textarea height based on content (auto-resize)
   */
  private adjustInputHeight(): void {
    const minHeight = 60;
    const maxHeight = 200;

    // Reset height to auto to get the actual scrollHeight
    this.inputEl.style.height = "auto";

    // Calculate new height within bounds
    const scrollHeight = this.inputEl.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

    this.inputEl.style.height = `${newHeight}px`;
  }

  // ========== UI HELPERS ==========

  private addErrorMessage(message: string): HTMLElement {
    const msgEl = this.messagesEl.createDiv({
      cls: "message message-assistant",
    });

    const roleEl = msgEl.createDiv({ cls: "message-role" });
    roleEl.textContent = "OpenCode";

    const bubbleEl = msgEl.createDiv({ cls: "message-bubble" });
    const contentEl = bubbleEl.createDiv({ cls: "message-content" });
    this.appendErrorBlock(contentEl, message);

    this.scrollToBottom();
    return msgEl;
  }

  private addMessage(
    messageId: string | null,
    role: "user" | "assistant",
    content: string,
    _toolCalls?: unknown,
    mentions?: MentionInfo[],
    skills?: SkillInfo[],
  ): HTMLElement {
    const msgEl = this.messagesEl.createDiv({
      cls: `message message-${role}`,
      attr: messageId ? { "data-message-id": messageId } : undefined,
    });

    const roleEl = msgEl.createDiv({ cls: "message-role" });
    roleEl.textContent = role === "user" ? "You" : "OpenCode";

    const bubbleEl = msgEl.createDiv({ cls: "message-bubble" });

    const hotzoneEl =
      role === "user"
        ? bubbleEl.createDiv({ cls: "opencodian-message-hotzone" })
        : bubbleEl;

    const contentEl = hotzoneEl.createDiv({ cls: "message-content" });
    // Assistant messages use a timeline container instead of this contentEl; callers may remove it.

    if (role === "user" && messageId) {
      this.addUserMessageActions(hotzoneEl, messageId, content);
    }

    // Historical tool rendering removed: assistant messages are timeline-based.

    if (content) {
      if (role === "assistant") {
        // Render assistant responses as markdown.
        void this.renderMarkdown(content, contentEl);
      } else {
        // For user messages: render content with inline mention/skill chips
        if (
          (mentions && mentions.length > 0) ||
          (skills && skills.length > 0)
        ) {
          this.renderContentWithInlineChips(
            contentEl,
            content,
            mentions,
            skills,
          );
        } else {
          contentEl.textContent = content;
        }
      }
    }

    this.scrollToBottom();

    return msgEl;
  }

  /**
   * Render user message content with inline mention and skill chips.
   * Replaces mention/skill names in text with chips.
   */
  private renderContentWithInlineChips(
    containerEl: HTMLElement,
    content: string,
    mentions?: MentionInfo[],
    skills?: SkillInfo[],
  ): void {
    // Build combined list of tokens to replace
    type TokenInfo =
      | { type: "file"; name: string; data: MentionInfo }
      | { type: "skill"; name: string; data: SkillInfo };

    const tokens: TokenInfo[] = [];

    if (mentions) {
      for (const m of mentions) {
        if (!m.name.trim()) continue;
        tokens.push({ type: "file", name: m.name, data: m });
      }
    }

    if (skills) {
      for (const s of skills) {
        if (!s.name.trim()) continue;
        tokens.push({ type: "skill", name: s.name, data: s });
      }
    }

    if (tokens.length === 0) {
      containerEl.textContent = content;
      return;
    }

    // Sort by name length descending to match longer names first
    tokens.sort((a, b) => b.name.length - a.name.length);

    const escapeRegExp = (value: string): string =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Build regex pattern to match any token name
    const escapedNames = tokens.map((t) => escapeRegExp(t.name));

    const pattern = new RegExp(`(${escapedNames.join("|")})`, "g");

    // Split content by token names
    const parts = content.split(pattern);

    // Track which tokens have been used (each only once, by unique key)
    const usedTokens = new Set<string>();

    const getTokenKey = (t: TokenInfo): string => {
      if (t.type === "file") return `file:${t.data.path}`;
      return `skill:${t.data.path}`;
    };

    const normalize = (value: string): string =>
      value.replace(/\s+/g, " ").trim();
    const normalizedContent = normalize(content);

    for (const part of parts) {
      if (!part) continue;

      // Check if this part matches a token name
      const token = tokens.find((t) => {
        if (usedTokens.has(getTokenKey(t))) return false;
        if (t.name === part) return true;

        // If the stored message text normalizes whitespace differently,
        // still try to match tokens in a resilient way.
        const normalizedName = normalize(t.name);
        if (!normalizedName) return false;
        if (normalize(part) === normalizedName) return true;
        if (
          normalizedContent.includes(normalizedName) &&
          part.includes(normalizedName)
        ) {
          return true;
        }

        return false;
      });

      if (token) {
        usedTokens.add(getTokenKey(token));

        if (token.type === "file") {
          // File mention chip (clickable)
          const mention = token.data;
          const chipEl = containerEl.createSpan({
            cls: "opencodian-inline-mention-chip opencodian-message-inline-chip",
          });
          chipEl.title = mention.path;
          chipEl.style.cursor = "pointer";

          chipEl.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openMentionedFile(mention.path, mention.isFolder);
          });

          const clickArea = chipEl.createSpan({
            cls: "opencodian-inline-mention-chip-click",
          });

          const iconEl = clickArea.createSpan({
            cls: "opencodian-inline-mention-chip-icon",
          });
          setIcon(iconEl, mention.isFolder ? "folder" : "file-text");

          const nameEl = clickArea.createSpan({
            cls: "opencodian-inline-mention-chip-name",
          });
          nameEl.textContent = mention.name;
        } else {
          // Skill chip (not clickable)
          const skill = token.data;
          const chipEl = containerEl.createSpan({
            cls: "opencodian-inline-skill-chip opencodian-message-inline-chip opencodian-skill-chip-static",
          });
          chipEl.title = skill.name;

          const clickArea = chipEl.createSpan({
            cls: "opencodian-inline-skill-chip-click",
          });

          const iconEl = clickArea.createSpan({
            cls: "opencodian-inline-skill-chip-icon",
          });
          setIcon(iconEl, "wand");

          const nameEl = clickArea.createSpan({
            cls: "opencodian-inline-skill-chip-name",
          });
          nameEl.textContent = skill.name;
        }
      } else {
        // Regular text
        containerEl.appendChild(document.createTextNode(part));
      }
    }
  }

  /**
   * Render user message content with inline mention chips.
   * Replaces mention names in text with clickable chips.
   */
  private renderContentWithInlineMentions(
    containerEl: HTMLElement,
    content: string,
    mentions: MentionInfo[],
  ): void {
    // Create a map of mention names to their info for quick lookup
    // Sort by name length descending to match longer names first
    const sortedMentions = [...mentions].sort(
      (a, b) => b.name.length - a.name.length,
    );

    // Build regex pattern to match any mention name
    const escapedNames = sortedMentions.map((m) =>
      m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );

    if (escapedNames.length === 0) {
      containerEl.textContent = content;
      return;
    }

    const pattern = new RegExp(`(${escapedNames.join("|")})`, "g");

    // Split content by mention names
    const parts = content.split(pattern);

    // Track which mentions have been used (each only once)
    const usedMentions = new Set<string>();

    for (const part of parts) {
      if (!part) continue;

      // Check if this part is a mention name
      const mention = sortedMentions.find(
        (m) => m.name === part && !usedMentions.has(m.path),
      );

      if (mention) {
        // Mark as used
        usedMentions.add(mention.path);

        // Create inline chip (same style as input chips)
        const chipEl = containerEl.createSpan({
          cls: "opencodian-inline-mention-chip opencodian-message-inline-chip",
        });
        chipEl.title = mention.path;
        chipEl.style.cursor = "pointer";

        // Make chip clickable to open file
        chipEl.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openMentionedFile(mention.path, mention.isFolder);
        });

        const clickArea = chipEl.createSpan({
          cls: "opencodian-inline-mention-chip-click",
        });

        const iconEl = clickArea.createSpan({
          cls: "opencodian-inline-mention-chip-icon",
        });
        setIcon(iconEl, mention.isFolder ? "folder" : "file-text");

        const nameEl = clickArea.createSpan({
          cls: "opencodian-inline-mention-chip-name",
        });
        nameEl.textContent = mention.name;
      } else {
        // Regular text
        containerEl.appendChild(document.createTextNode(part));
      }
    }
  }

  private appendTimelineItem(parentEl: HTMLElement, item: ChatItem): void {
    if (item.type === "text") {
      const el = parentEl.createDiv({ cls: "message-content" });
      void this.renderMarkdown(item.text, el);
      return;
    }

    if (item.type === "tool") {
      this.renderToolUseBlock(
        parentEl,
        item.toolName,
        item.input,
        item.toolUseId,
      );
      if (item.result != null) {
        this.renderToolResultBlock(item.toolUseId, item.result);
      }
    }
  }

  private getToolInputSummary(
    toolName: string,
    input: Record<string, unknown>,
  ): string | undefined {
    const t = (toolName || "").toLowerCase();
    const getStr = (k: string) => {
      const v = (input as any)?.[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };

    if (t === "bash") return getStr("command") || getStr("cmd");
    if (t === "read")
      return (
        getStr("filePath") ||
        getStr("file_path") ||
        getStr("path") ||
        getStr("file")
      );
    if (t === "grep") return getStr("pattern") || getStr("query");
    if (t === "glob") {
      const p = (input as any)?.patterns;
      if (Array.isArray(p) && p.length > 0) return p.join(", ");
      return getStr("pattern");
    }
    if (t === "websearch") return getStr("query");
    if (t === "webfetch" || t === "fetchurl") return getStr("url");
    if (t === "skill") return getStr("name");

    return undefined;
  }

  private sanitizeToolInput(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const maxString = 500;
    const maxArray = 50;
    const maxDepth = 4;

    const sanitize = (value: unknown, depth: number): unknown => {
      if (depth > maxDepth) return "[truncated]";
      if (value == null) return value;
      if (typeof value === "string") {
        if (value.length <= maxString) return value;
        return value.slice(0, maxString) + "...";
      }
      if (typeof value === "number" || typeof value === "boolean") return value;
      if (Array.isArray(value)) {
        const sliced = value.slice(0, maxArray);
        const mapped = sliced.map((v) => sanitize(v, depth + 1));
        if (value.length > maxArray) mapped.push("...");
        return mapped;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = sanitize(v, depth + 1);
        }
        return out;
      }
      return String(value);
    };

    return (sanitize(input, 0) as Record<string, unknown>) ?? {};
  }

  private async renderMarkdown(
    content: string,
    container: HTMLElement,
  ): Promise<void> {
    container.addClass("opencodian-markdown");
    container.empty();
    try {
      await MarkdownRenderer.render(
        this.plugin.app,
        content,
        container,
        "",
        this,
      );
      this.enrichCodeBlocks(container);
      this.enrichInternalLinks(container);
    } catch {
      // Fallback to plain text
      container.removeClass("opencodian-markdown");
      container.textContent = content;
    }
  }

  private enrichCodeBlocks(container: HTMLElement): void {
    const codeBlocks = container.findAll("pre");
    for (const pre of codeBlocks) {
      // Remove Obsidian's default copy button if present (it's injected by MarkdownRenderer)
      const defaultBtn = pre.querySelector(".copy-code-button");
      if (defaultBtn) defaultBtn.remove();

      // Check if copy button already exists (avoid duplicates)
      if (pre.querySelector(".opencodian-code-copy-btn")) continue;

      // Create ghost copy button
      const copyBtn = pre.createDiv({
        cls: "opencodian-code-copy-btn",
        attr: { "aria-label": "Copy code" },
      });
      setIcon(copyBtn, "copy");

      copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const code =
          pre.querySelector("code")?.textContent || pre.textContent || "";
        void navigator.clipboard.writeText(code);

        // Success feedback
        setIcon(copyBtn, "check");
        copyBtn.addClass("success");

        setTimeout(() => {
          setIcon(copyBtn, "copy");
          copyBtn.removeClass("success");
        }, 2000);

        new Notice("Code copied to clipboard");
      });
    }
  }

  private enrichInternalLinks(container: HTMLElement): void {
    const internalLinks = container.querySelectorAll("a.internal-link");
    for (const linkEl of Array.from(internalLinks)) {
      const href = linkEl.getAttribute("data-href");
      if (!href) continue;

      linkEl.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.app.workspace.openLinkText(href, "", e.ctrlKey || e.metaKey);
      });

      linkEl.addEventListener("auxclick", (e: MouseEvent) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          this.plugin.app.workspace.openLinkText(href, "", true);
        }
      });
    }
  }

  private addSystemMessage(content: string): void {
    const msgEl = this.messagesEl.createDiv({ cls: "message message-system" });
    msgEl.textContent = content;
  }

  private async requestToolApproval(request: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata?: Record<string, unknown>;
  }): Promise<"once" | "always" | "reject"> {
    const label = request.permission || "tool";
    const patterns = request.patterns && request.patterns.length > 0
      ? request.patterns.join(", ")
      : "*";
    const alwaysLabel = request.always && request.always.length > 0
      ? request.always.join(", ")
      : patterns;

    return new Promise((resolve) => {
      const modal = new Modal(this.plugin.app);
      modal.setTitle("Permission required");

      const info = modal.contentEl.createDiv({ cls: "opencodian-permission-info" });
      info.createDiv({
        text: `Tool: ${label}`,
        cls: "opencodian-permission-tool",
      });
      info.createDiv({
        text: `Patterns: ${patterns}`,
        cls: "opencodian-permission-patterns",
      });

      const buttons = modal.contentEl.createDiv({ cls: "opencodian-permission-actions" });
      const allowOnce = buttons.createEl("button", {
        text: "Allow once",
        cls: "opencodian-permission-btn opencodian-permission-allow",
      });
      const allowAlways = buttons.createEl("button", {
        text: `Always allow: ${alwaysLabel}`,
        cls: "opencodian-permission-btn opencodian-permission-allow-always",
      });
      const reject = buttons.createEl("button", {
        text: "Reject",
        cls: "opencodian-permission-btn opencodian-permission-reject",
      });

      const resolveOnce = (decision: "once" | "always" | "reject") => {
        resolve(decision);
        modal.close();
      };

      allowOnce.addEventListener("click", () => resolveOnce("once"));
      allowAlways.addEventListener("click", () => resolveOnce("always"));
      reject.addEventListener("click", () => resolveOnce("reject"));

      modal.onClose = () => {
        resolve("reject");
      };

      modal.open();
    });
  }

  private addUserMessageActions(
    hotzoneEl: HTMLElement,
    messageId: string,
    content: string,
  ): void {
    if (this.editingMessageId === messageId) return;

    const actionsEl = hotzoneEl.createDiv({
      cls: "opencodian-message-actions",
    });

    const copyBtn = actionsEl.createDiv({
      cls: "opencodian-message-action-btn",
      attr: { "aria-label": "Copy" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard.writeText(content);
      new Notice("Copied to clipboard");
    });

    const editBtn = actionsEl.createDiv({
      cls: "opencodian-message-action-btn",
      attr: { "aria-label": "Edit" },
    });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.startInlineEdit(messageId, content);
    });

    const regenBtn = actionsEl.createDiv({
      cls: "opencodian-message-action-btn",
      attr: { "aria-label": "Regenerate" },
    });
    setIcon(regenBtn, "rotate-ccw");
    regenBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.regenerateFrom(messageId);
    });
  }

  private async startInlineEdit(
    messageId: string,
    content: string,
  ): Promise<void> {
    this.editingMessageId = messageId;

    // Capture scroll position BEFORE loadConversation changes the DOM
    const currentScroll = this.messagesEl.scrollTop;

    // Suppress auto-scroll during the initial load to maintain position
    this.suppressAutoScroll = true;
    await this.loadConversation(false);
    this.messagesEl.scrollTo({ top: currentScroll, behavior: "auto" });
    this.suppressAutoScroll = false;

    const msgEl = this.messagesEl.querySelector(
      `.message-user[data-message-id="${messageId}"]`,
    ) as HTMLElement | null;
    if (!msgEl) {
      this.editingMessageId = null;
      return;
    }

    const hotzoneEl = msgEl.querySelector(
      ".opencodian-message-hotzone",
    ) as HTMLElement | null;
    if (!hotzoneEl) {
      this.editingMessageId = null;
      return;
    }

    hotzoneEl.empty();

    const editorEl = hotzoneEl.createDiv({ cls: "opencodian-inline-editor" });
    const inputEl = editorEl.createEl("textarea");
    inputEl.value = content;

    // Actions now live outside the editor box, mimicking the original message actions bar
    const actionsEl = hotzoneEl.createDiv({
      cls: "opencodian-inline-editor-actions",
    });

    const cancelEl = actionsEl.createDiv({
      cls: "opencodian-inline-editor-btn",
      attr: { "aria-label": "Cancel" },
    });
    setIcon(cancelEl, "x");

    const sendEl = actionsEl.createDiv({
      cls: "opencodian-inline-editor-btn primary",
      attr: { "aria-label": "Send" },
    });
    setIcon(sendEl, "arrow-up");

    const adjustHeight = (): void => {
      inputEl.style.height = "auto";
      const minHeight = 24;
      const maxHeight = 200;
      inputEl.style.height = `${Math.min(Math.max(inputEl.scrollHeight, minHeight), maxHeight)}px`;
    };

    adjustHeight();
    inputEl.addEventListener("input", adjustHeight);

    const cancel = async (): Promise<void> => {
      if (this.editingMessageId !== messageId) return;
      this.editingMessageId = null;
      this.suppressAutoScroll = true;
      await this.loadConversation(false);
      this.messagesEl.scrollTo({ top: currentScroll, behavior: "auto" });
      this.suppressAutoScroll = false;
      this.inputEl.setAttribute("data-empty", "true");
    };


    const send = async (): Promise<void> => {
      const text = inputEl.value.trim();
      if (!text) return;
      if (this.editingMessageId !== messageId) return;
      this.editingMessageId = null;
      await this.editAndResend(messageId, text);
    };

    cancelEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void cancel();
    });

    sendEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void send();
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancel();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    });

    window.setTimeout(() => {
      inputEl.focus();
      inputEl.selectionStart = inputEl.value.length;
      inputEl.selectionEnd = inputEl.value.length;
    }, 0);
  }

  private showWelcomeMessage(): void {
    const welcomeEl = this.messagesEl.createDiv({ cls: "opencodian-welcome" });
    welcomeEl.createDiv({
      text: "Opencodian",
      cls: "opencodian-welcome-line",
    });
  }


  private clearWelcomeMessage(): void {
    const welcomeEl = this.messagesEl.querySelector(".opencodian-welcome");
    if (welcomeEl) {
      welcomeEl.remove();
    }
  }

  /**
   * Open a mentioned file or folder in Obsidian
   */
  private openMentionedFile(path: string, _isFolder: boolean): void {
    if (this.fileMention) {
      this.fileMention.openFile(path);
    }
  }

  // ========== TOOL & THINKING BLOCKS ==========

  /**
   * Render tool invocation block
   */
  private renderThinkingBlock(_content: string): void {
    // Intentionally ignored: thinking/reasoning is not displayed or persisted.
  }

  /**
   * Render tool use block during streaming
   */
  private renderToolUseBlock(
    bubbleEl: HTMLElement,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): void {
    if (toolName === "todowrite") {
      this.renderTodoWriteToolBlock(bubbleEl, input, toolUseId);
      return;
    }

    // If we already rendered this tool invocation (same id), update it instead of creating a new block.
    // OpenCode can emit multiple updates for the same tool part (e.g. pending -> running), and
    // creating a second block leaves the first stuck in "Running..." forever.
    const existing = this.activeToolBlocks.get(toolUseId);
    if (existing) {
      const labelEl = existing.headerEl.querySelector(
        ".tool-label",
      ) as HTMLElement | null;
      if (labelEl) {
        const summary = this.getToolInputSummary(toolName, input);
        const name = this.formatToolName(toolName);
        labelEl.textContent = summary ? `${name}: ${summary}` : name;
      }

      const iconEl = existing.headerEl.querySelector(
        ".tool-icon",
      ) as HTMLElement | null;
      if (iconEl) setIcon(iconEl, this.getToolIcon(toolName));

      const statusEl = existing.headerEl.querySelector(
        ".tool-status",
      ) as HTMLElement | null;
      if (statusEl) {
        statusEl.textContent = "Running...";
        statusEl.className = "tool-status running";
      }

      const inputCode = existing.contentEl.querySelector(
        "pre.tool-code:not(.tool-result-code)",
      ) as HTMLElement | null;
      if (inputCode) {
        inputCode.textContent = JSON.stringify(input, null, 2);
      }

      return;
    }

    // Create tool block
    const blockEl = document.createElement("div");
    blockEl.className = "tool-block";
    blockEl.setAttribute("data-tool-id", toolUseId);

    // Header
    const headerEl = document.createElement("div");
    headerEl.className = "tool-header";

    const iconEl = document.createElement("span");
    iconEl.className = "tool-icon";
    setIcon(iconEl, this.getToolIcon(toolName));

    const labelEl = document.createElement("span");
    labelEl.className = "tool-label";
    {
      const name = this.formatToolName(toolName);
      const summary = this.getToolInputSummary(toolName, input);
      labelEl.textContent = summary ? `${name}: ${summary}` : name;
    }

    const statusEl = document.createElement("span");
    statusEl.className = "tool-status running";
    statusEl.textContent = "Running...";

    const chevronEl = document.createElement("span");
    chevronEl.className = "tool-chevron";
    setIcon(chevronEl, "chevron-down");

    headerEl.appendChild(iconEl);
    headerEl.appendChild(labelEl);
    headerEl.appendChild(statusEl);
    headerEl.appendChild(chevronEl);

    // Content area (input params)
    const contentEl = document.createElement("div");
    contentEl.className = "tool-content";

    // Input section
    const inputSection = document.createElement("div");
    inputSection.className = "tool-section";

    const inputLabel = document.createElement("div");
    inputLabel.className = "tool-section-label";
    inputLabel.textContent = "Input";

    const inputCode = document.createElement("pre");
    inputCode.className = "tool-code";
    inputCode.textContent = JSON.stringify(input, null, 2);

    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputCode);
    contentEl.appendChild(inputSection);

    // Result section (placeholder)
    const resultSection = document.createElement("div");
    resultSection.className = "tool-section tool-result-section";
    resultSection.style.display = "none";

    const resultLabel = document.createElement("div");
    resultLabel.className = "tool-section-label";
    resultLabel.textContent = "Result";

    const resultCode = document.createElement("pre");
    resultCode.className = "tool-code tool-result-code";

    resultSection.appendChild(resultLabel);
    resultSection.appendChild(resultCode);
    contentEl.appendChild(resultSection);

    blockEl.appendChild(headerEl);
    blockEl.appendChild(contentEl);

    bubbleEl.appendChild(blockEl);

    // Toggle handler
    headerEl.addEventListener("click", () => {
      const isCollapsed = blockEl.classList.toggle("collapsed");
      setIcon(chevronEl, isCollapsed ? "chevron-right" : "chevron-down");
      const block = this.activeToolBlocks.get(toolUseId);
      if (block) {
        block.isCollapsed = isCollapsed;
      }
    });

    this.activeToolBlocks.set(toolUseId, {
      el: blockEl,
      headerEl,
      contentEl,
      isCollapsed: false,
    });
  }

  private renderTodoWriteToolBlock(
    bubbleEl: HTMLElement,
    input: Record<string, unknown>,
    toolUseId: string,
  ): void {
    const todos = this.parseTodoWriteTodos(input);

    const existing = this.activeToolBlocks.get(toolUseId);
    if (existing) {
      const listEl = existing.contentEl.querySelector(
        ".opencodian-todo-list",
      ) as HTMLElement | null;
      if (listEl) {
        this.renderTodoListItems(listEl, todos);
      }

      const progressEl = existing.headerEl.querySelector(
        ".opencodian-todo-progress",
      ) as HTMLElement | null;
      if (progressEl) {
        progressEl.textContent = this.getTodoProgressText(todos);
      }

      const statusEl = existing.headerEl.querySelector(
        ".tool-status",
      ) as HTMLElement | null;
      if (statusEl) {
        statusEl.textContent = "Running...";
        statusEl.className = "tool-status running";
      }

      return;
    }

    const blockEl = document.createElement("div");
    blockEl.className = "tool-block opencodian-todo-tool";
    blockEl.setAttribute("data-tool-id", toolUseId);

    const headerEl = document.createElement("div");
    headerEl.className = "tool-header";

    const iconEl = document.createElement("span");
    iconEl.className = "tool-icon";
    setIcon(iconEl, "list-todo");

    const labelEl = document.createElement("span");
    labelEl.className = "tool-label";
    labelEl.textContent = "Task Plan";

    const progressEl = document.createElement("span");
    progressEl.className = "opencodian-todo-progress";
    progressEl.textContent = this.getTodoProgressText(todos);

    const statusEl = document.createElement("span");
    statusEl.className = "tool-status running";
    statusEl.textContent = "Running...";

    const chevronEl = document.createElement("span");
    chevronEl.className = "tool-chevron";
    setIcon(chevronEl, "chevron-down");

    headerEl.appendChild(iconEl);
    headerEl.appendChild(labelEl);
    headerEl.appendChild(progressEl);
    headerEl.appendChild(statusEl);
    headerEl.appendChild(chevronEl);

    const contentEl = document.createElement("div");
    contentEl.className = "tool-content opencodian-todo-content";

    const listEl = document.createElement("div");
    listEl.className = "opencodian-todo-list";
    this.renderTodoListItems(listEl, todos);
    contentEl.appendChild(listEl);

    // Note: We intentionally do NOT create a result section for todowrite
    // because the todo list itself is the visual representation of the state.
    // The generic renderToolResultBlock will look for .tool-result-section
    // and fail to find it, which is exactly what we want (no raw JSON dump).

    blockEl.appendChild(headerEl);
    blockEl.appendChild(contentEl);

    bubbleEl.appendChild(blockEl);

    headerEl.addEventListener("click", () => {
      const isCollapsed = blockEl.classList.toggle("collapsed");
      setIcon(chevronEl, isCollapsed ? "chevron-right" : "chevron-down");
      const block = this.activeToolBlocks.get(toolUseId);
      if (block) {
        block.isCollapsed = isCollapsed;
      }
    });

    this.activeToolBlocks.set(toolUseId, {
      el: blockEl,
      headerEl,
      contentEl,
      isCollapsed: false,
    });
  }

  private parseTodoWriteTodos(
    input: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const raw = input.todos;
    if (!Array.isArray(raw)) return [];

    const todos: Array<Record<string, unknown>> = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      todos.push(item as Record<string, unknown>);
    }

    return todos;
  }

  private getTodoProgressText(todos: Array<Record<string, unknown>>): string {
    if (todos.length === 0) return "";

    let completed = 0;
    for (const todo of todos) {
      if (todo.status === "completed") {
        completed += 1;
      }
    }

    return `${completed}/${todos.length}`;
  }

  private renderTodoListItems(
    listEl: HTMLElement,
    todos: Array<Record<string, unknown>>,
  ): void {
    listEl.empty();

    for (const todo of todos) {
      const rowEl = listEl.createDiv({ cls: "opencodian-todo-item" });

      const statusEl = rowEl.createDiv({ cls: "opencodian-todo-status" });
      const status = typeof todo.status === "string" ? todo.status : "pending";
      if (status === "completed") {
        statusEl.addClass("is-completed");
        statusEl.setText("✓");
      }

      if (status === "in_progress") {
        statusEl.addClass("is-in-progress");
        statusEl.setText("•");
      }

      if (status !== "completed" && status !== "in_progress") {
        statusEl.addClass("is-pending");
        statusEl.setText("○");
      }

      const textEl = rowEl.createDiv({ cls: "opencodian-todo-text" });
      const content = typeof todo.content === "string" ? todo.content : "";
      textEl.setText(content);

      if (status === "completed") {
        rowEl.addClass("is-completed");
      }

      if (status === "in_progress") {
        rowEl.addClass("is-in-progress");
      }
    }
  }

  /**
   * Update tool block with result
   */
  private renderToolResultBlock(toolUseId: string, result: string): void {
    const block = this.activeToolBlocks.get(toolUseId);
    if (!block) return;

    // Update status
    const statusEl = block.headerEl.querySelector(".tool-status");
    if (statusEl) {
      statusEl.textContent = "Done";
      statusEl.className = "tool-status done";
    }

    // Show result
    const resultSection = block.contentEl.querySelector(
      ".tool-result-section",
    ) as HTMLElement;
    const resultCode = block.contentEl.querySelector(
      ".tool-result-code",
    ) as HTMLElement;

    if (resultSection && resultCode) {
      resultSection.style.display = "block";
      // Truncate very long results
      const displayResult =
        result.length > 2000
          ? result.substring(0, 2000) + "\n... (truncated)"
          : result;
      resultCode.textContent = displayResult;
    }

    // Auto-collapse after completion
    if (!block.isCollapsed) {
      block.headerEl.click();
    }
  }

  /**
   * Get appropriate icon for tool type
   */
  private getToolIcon(toolName: string): string {
    const iconMap: Record<string, string> = {
      read: "file-text",
      Read: "file-text",
      write: "file-plus",
      Write: "file-plus",
      edit: "file-edit",
      Edit: "file-edit",
      bash: "terminal",
      Bash: "terminal",
      glob: "folder-search",
      Glob: "folder-search",
      grep: "search",
      Grep: "search",
      task: "list-todo",
      Task: "list-todo",
      webfetch: "globe",
      WebFetch: "globe",
      skill: "book-open",
      Skill: "book-open",
    };
    return iconMap[toolName] || "wrench";
  }

  // ========== MODEL SELECTOR ==========

  /**
   * Create model selector UI
   */
  private createModelSelector(parentEl: HTMLElement): void {
    this.modelSelectorEl = parentEl.createDiv({
      cls: "opencodian-model-selector",
    });

    // Model button
    this.modelButtonEl = this.modelSelectorEl.createDiv({
      cls: "opencodian-model-btn",
    });

    this.updateModelDisplay();

    this.modelButtonEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleModelDropdown();
    });

    // Dropdown
    this.modelDropdownEl = this.modelSelectorEl.createDiv({
      cls: "opencodian-model-dropdown",
    });
    this.modelDropdownEl.style.display = "none";

    // Close on outside click
    document.addEventListener("click", (e) => {
      if (
        this.isModelDropdownOpen &&
        !this.modelSelectorEl.contains(e.target as Node)
      ) {
        this.toggleModelDropdown(false);
      }
    });
  }

  /**
   * Update model button display
   */
  private updateModelDisplay(labelOverride?: string): void {
    const currentModel = this.plugin.settings.model;
    // Use override if provided, otherwise try to find from loaded providers
    const label = labelOverride || this.findModelLabel(currentModel);

    this.modelButtonEl.empty();

    const iconEl = this.modelButtonEl.createSpan({ cls: "model-icon" });
    setIcon(iconEl, "cpu");

    const labelEl = this.modelButtonEl.createSpan({ cls: "model-label" });
    labelEl.textContent = label;

    const chevronEl = this.modelButtonEl.createSpan({ cls: "model-chevron" });
    setIcon(chevronEl, "chevron-down");
  }

  /**
   * Find model label from loaded providers or extract from model ID
   */
  private findModelLabel(modelId: string): string {
    // Search in loaded providers
    for (const provider of this.providers) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) return model.label;
    }

    // Fallback: extract model name from ID (provider/model-name -> model-name)
    const parts = modelId.split("/");
    if (parts.length === 2) {
      return parts[1];
    }
    return modelId;
  }

  /**
   * Toggle model dropdown
   */
  private toggleModelDropdown(forceState?: boolean): void {
    this.isModelDropdownOpen =
      forceState !== undefined ? forceState : !this.isModelDropdownOpen;
    this.modelDropdownEl.style.display = this.isModelDropdownOpen
      ? "flex"
      : "none";

    if (this.isModelDropdownOpen) {
      // Reset to provider list when opening
      this.selectedProvider = null;
      this.renderDropdownContent();

      // Load providers if not loaded yet
      if (!this.providersLoaded && !this.isLoadingProviders) {
        this.loadProviders();
      }
    }
  }

  /**
   * Load providers from OpenCode server
   */
  private async loadProviders(): Promise<void> {
    if (this.isLoadingProviders) return;

    this.isLoadingProviders = true;
    this.renderDropdownContent();

    try {
      const response = await this.plugin.agentService.getProviders();
      const processed = processProviders(response);
      this.providers = processed.providers;
      this.providersLoaded = true;

      if (this.plugin.settings.debugLogging) {
        const summary = processed.summaries.map((item) => ({
          providerId: item.providerId,
          providerName: item.providerName,
          rawModelCount: item.rawModelCount,
          processedModelCount: item.processedModelCount,
          filteredOutModelIds: item.filteredOutModelIds,
          hasClaudeSonnet46: item.rawModelIds.some((id) => id.includes("sonnet-4.6")),
          hasGpt54: item.rawModelIds.some((id) => id.includes("gpt-5.4")),
        }));

        console.log("[OpencodianView] Provider processing summary:", summary);
      }
    } catch (error) {
      console.error("[OpencodianView] Failed to load providers:", error);
      // On error, show empty state - user needs to configure providers
      this.providers = [];
    } finally {
      this.isLoadingProviders = false;
      this.renderDropdownContent();
    }
  }

  /**
   * Render dropdown content based on current state
   */
  private renderDropdownContent(): void {
    this.modelDropdownEl.empty();

    if (this.isLoadingProviders) {
      this.renderLoadingState();
      return;
    }

    if (this.selectedProvider) {
      this.renderModelList(this.selectedProvider);
    } else {
      this.renderProviderList();
    }
  }

  /**
   * Render loading state
   */
  private renderLoadingState(): void {
    const loadingEl = this.modelDropdownEl.createDiv({
      cls: "opencodian-dropdown-loading",
    });
    loadingEl.textContent = "Loading...";
  }

  /**
   * Render provider list (level 1)
   */
  private renderProviderList(): void {
    // Check if no providers available
    if (this.providers.length === 0) {
      const emptyEl = this.modelDropdownEl.createDiv({
        cls: "opencodian-dropdown-empty",
      });
      emptyEl.textContent = "No providers configured";
      return;
    }

    // --- RECENT MODELS SECTION ---
    const recentIds = this.plugin.settings.recentModels || [];
    const recentModels: ModelOption[] = [];

    // Find full model objects for recent IDs
    if (recentIds.length > 0) {
      for (const id of recentIds) {
        // Skip if already found (dedupe in case setting has duplicates)
        if (recentModels.some((m) => m.id === id)) continue;

        for (const provider of this.providers) {
          const found = provider.models.find((m) => m.id === id);
          if (found) {
            recentModels.push(found);
            break;
          }
        }
      }
    }

    if (recentModels.length > 0) {
      const currentModel = this.plugin.settings.model;

      for (const model of recentModels) {
        const optionEl = this.modelDropdownEl.createDiv({
          cls: `opencodian-dropdown-item opencodian-model-item ${
            model.id === currentModel ? "active" : ""
          }`,
        });

        // Use standard model styling but remove left padding since it's level 1
        optionEl.style.paddingLeft = "12px";

        const labelEl = optionEl.createSpan({ cls: "dropdown-item-label" });
        labelEl.textContent = model.label;

        // Add provider hint
        const providerHint = optionEl.createSpan({
          cls: "dropdown-item-count",
        });
        providerHint.textContent = model.providerID;
        providerHint.style.fontSize = "10px";
        providerHint.style.marginLeft = "auto";
        providerHint.style.marginRight = "0";

        // Free badge
        if (model.isFree && model.providerID === "opencode") {
          const freeEl = optionEl.createSpan({
            cls: "dropdown-item-badge free",
          });
          freeEl.textContent = "Free";
        }

        optionEl.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.selectModel(model.id, model.label);
        });
      }

      this.modelDropdownEl.createDiv({ cls: "opencodian-dropdown-separator" });
    }

    // --- PROVIDERS SECTION ---
    for (const provider of this.providers) {
      // Skip providers with no models
      if (provider.models.length === 0) continue;

      const optionEl = this.modelDropdownEl.createDiv({
        cls: "opencodian-dropdown-item opencodian-provider-item",
      });

      // Provider icon
      const iconEl = optionEl.createSpan({ cls: "dropdown-item-icon" });
      setIcon(iconEl, provider.isConnected ? "check-circle" : "circle");

      // Provider name
      const labelEl = optionEl.createSpan({ cls: "dropdown-item-label" });
      labelEl.textContent = provider.name;

      // Model count badge
      const countEl = optionEl.createSpan({ cls: "dropdown-item-count" });
      countEl.textContent = `${provider.models.length}`;

      // Chevron
      const chevronEl = optionEl.createSpan({ cls: "dropdown-item-chevron" });
      setIcon(chevronEl, "chevron-right");

      optionEl.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedProvider = provider;
        this.renderDropdownContent();
      });
    }
  }

  /**
   * Render model list for selected provider (level 2)
   */
  private renderModelList(provider: ProviderWithModels): void {
    // Back button
    const backEl = this.modelDropdownEl.createDiv({
      cls: "opencodian-dropdown-back",
    });

    const backIconEl = backEl.createSpan({ cls: "dropdown-back-icon" });
    setIcon(backIconEl, "arrow-left");

    const backLabelEl = backEl.createSpan({ cls: "dropdown-back-label" });
    backLabelEl.textContent = provider.name;

    backEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedProvider = null;
      this.renderDropdownContent();
    });

    // Separator
    this.modelDropdownEl.createDiv({ cls: "opencodian-dropdown-separator" });

    // Model list
    const currentModel = this.plugin.settings.model;

    for (const model of provider.models) {
      const optionEl = this.modelDropdownEl.createDiv({
        cls: `opencodian-dropdown-item opencodian-model-item ${
          model.id === currentModel ? "active" : ""
        }`,
      });

      // Model name
      const labelEl = optionEl.createSpan({ cls: "dropdown-item-label" });
      labelEl.textContent = model.label;

      // Free badge - only for opencode provider
      if (provider.id === "opencode" && model.isFree) {
        const freeEl = optionEl.createSpan({ cls: "dropdown-item-badge free" });
        freeEl.textContent = "Free";
      }

      optionEl.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.selectModel(model.id, model.label);
      });
    }
  }

  /**
   * Select a model
   */
  private async selectModel(
    modelId: string,
    modelLabel: string,
  ): Promise<void> {
    this.plugin.settings.model = modelId;

    // Update recent models
    const recent = this.plugin.settings.recentModels || [];
    const newRecent = [modelId, ...recent.filter((id) => id !== modelId)].slice(
      0,
      5,
    );
    this.plugin.settings.recentModels = newRecent;

    await this.plugin.saveSettings();

    this.updateModelDisplay(modelLabel);
    this.toggleModelDropdown(false);
  }
}
