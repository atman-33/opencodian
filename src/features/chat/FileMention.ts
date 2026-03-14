/**
 * FileMention - unified @ mention system for files, skills, and agents
 *
 * IMPORTANT: This implementation targets a `contenteditable` input element.
 * It inserts inline, clickable chips directly into the text flow.
 */

import { TFolder, TFile, setIcon, type App } from "obsidian";
import * as path from "path";

import type { AgentInfo } from "../../core/types";
import { ProjectSkillDirs, PseudoGlobalSkillDir } from "../../core/agent/SkillPolicy";
import type { SkillItem } from "./SkillMention";

/** Represents a mentionable file or folder */
export interface MentionItem {
  path: string;
  name: string;
  isFolder: boolean;
}

interface SlashSuggestionItem {
  label: string;
  value: string;
  source: "claude-skill" | "opencode-command" | "opencode-skill";
  detail: string;
  insertText?: string;
  skillItem?: SkillItem;
}

type UnifiedMentionItem =
  | { type: "file"; item: MentionItem }
  | { type: "skill"; item: SkillItem }
  | { type: "agent"; item: AgentInfo }
  | { type: "slash"; item: SlashSuggestionItem }
  | {
      type: "category";
      item: {
        category: "files" | "skills" | "agents";
        name: string;
      };
    };

type MentionCategory = "root" | "files" | "skills" | "agents";

type SuggestionTriggerType = "mention" | "slash";

export class FileMention {
  private app: App;
  private inputEl: HTMLElement;
  private containerEl: HTMLElement;
  private suggestionsEl: HTMLElement | null = null;

  private handlePasteBound: (e: ClipboardEvent) => void;
  private handleDropBound: (e: DragEvent) => void;
  private handleBeforeInputBound: (e: InputEvent) => void;

  private fileItems: MentionItem[] = [];
  private skillItems: SkillItem[] = [];
  private agentItems: AgentInfo[] = [];
  private slashItems: SlashSuggestionItem[] = [];
  private filteredItems: UnifiedMentionItem[] = [];
  private selectedIndex: number = 0;
  private mentionRange: Range | null = null;
  private isOpen: boolean = false;
  private mentionQueryId: number = 0;
  private mentionCategory: MentionCategory = "root";
  private activeTriggerType: SuggestionTriggerType | null = null;

  private mentions: MentionItem[] = [];
  private skillMentions: SkillItem[] = [];
  private agentMentions: AgentInfo[] = [];
  private activeFileMention: MentionItem | null = null;
  private skipNativePaste: boolean = false;
  private loadAgents?: () => Promise<AgentInfo[]>;



  constructor(
    app: App,
    inputEl: HTMLElement,
    containerEl: HTMLElement,
    loadAgents?: () => Promise<AgentInfo[]>,
  ) {
    this.app = app;
    this.inputEl = inputEl;
    this.containerEl = containerEl;
    this.loadAgents = loadAgents;

    this.handlePasteBound = this.handlePaste.bind(this);
    this.handleDropBound = this.handleDrop.bind(this);
    this.handleBeforeInputBound = this.handleBeforeInput.bind(this);

    this.init();
  }

  private init(): void {
    void this.loadItems();


    this.inputEl.addEventListener("input", this.handleInput.bind(this));
    this.inputEl.addEventListener("keydown", this.handleKeyDown.bind(this));
    this.inputEl.addEventListener("blur", this.handleBlur.bind(this));
    this.inputEl.addEventListener("paste", this.handlePasteBound);
    this.inputEl.addEventListener("drop", this.handleDropBound);
    this.inputEl.addEventListener("beforeinput", this.handleBeforeInputBound);

    this.createSuggestionsEl();
  }

  /** Load files, folders, skills, and agents */
  private async loadItems(): Promise<void> {
    const items: MentionItem[] = [];
    const seenFolders = new Set<string>();

    const allFiles = this.app.vault.getFiles();

    for (const file of allFiles) {
      if (this.isHiddenPath(file.path)) continue;

      const parts = file.path.split("/");
      let folderPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        folderPath = folderPath ? `${folderPath}/${parts[i]}` : parts[i];
        if (!seenFolders.has(folderPath) && !this.isHiddenPath(folderPath)) {
          seenFolders.add(folderPath);
          items.push({
            path: folderPath,
            name: parts[i],
            isFolder: true,
          });
        }
      }

      items.push({
        path: file.path,
        name: file.name,
        isFolder: false,
      });
    }

    items.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.path.localeCompare(b.path);
    });

    this.fileItems = items;
    this.skillItems = await this.loadSkillItems();
    this.agentItems = await this.loadAgentItems();
    this.slashItems = await this.loadSlashItems();
  }

  private async loadAgentItems(): Promise<AgentInfo[]> {
    if (!this.loadAgents) return [];

    try {
      const agents = await this.loadAgents();
      const available = agents.filter(
        (agent) => agent.mode === "subagent" && agent.hidden !== true,
      );
      available.sort((a, b) => a.name.localeCompare(b.name));
      return available;
    } catch {
      return [];
    }
  }

  private isHiddenPath(path: string): boolean {
    const segments = path.split("/");
    for (const seg of segments) {
      if (seg.startsWith(".")) return true;
    }
    return false;
  }

  private async loadSkillItems(): Promise<SkillItem[]> {
    const skills: SkillItem[] = [];

    const [projectSkills, globalSkills] = await Promise.all([
      this.readProjectSkills(),
      this.readGlobalSkills(),
    ]);

    for (const item of projectSkills) skills.push(item);
    for (const item of globalSkills) {
      if (!skills.find((skill) => skill.name === item.name)) {
        skills.push(item);
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  }

  private async loadSlashItems(): Promise<SlashSuggestionItem[]> {
    const [claudeSkills, opencodeCommands, opencodeSkills] = await Promise.all([
      this.readSlashSkillFolders(".claude/skills", "claude-skill"),
      this.readSlashCommands(),
      this.readSlashSkillFolders(".opencode/skills", "opencode-skill"),
    ]);

    const items = [
      ...claudeSkills,
      ...opencodeCommands,
      ...opencodeSkills,
    ];
    const unique = new Map<string, SlashSuggestionItem>();

    for (const item of items) {
      if (!unique.has(item.value)) {
        unique.set(item.value, item);
      }
    }

    return Array.from(unique.values()).sort((a, b) =>
      a.value.localeCompare(b.value),
    );
  }

  private getGlobalSkillsDir(): string | null {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    return path.join(home, ".claude", "skills");
  }
  private async readProjectSkills(): Promise<SkillItem[]> {
    const skillsDirs = ProjectSkillDirs;
    const adapter: any = this.app.vault.adapter as any;
    const out: SkillItem[] = [];

    try {
      await Promise.all(
        skillsDirs.map(async (skillsDir) => {
          if (!(await adapter.exists(skillsDir))) {
            return;
          }

          const listing = (await adapter.list(skillsDir)) as {
            files: string[];
            folders: string[];
          };

          await Promise.all(
            listing.folders.map(async (folder: string) => {
              const skillFile = `${folder}/SKILL.md`;
              const content = await this.safeReadVaultFile(skillFile);
              if (!content) return;

              const parsed = this.parseFrontmatter(content);
              const name = parsed.name || folder.split("/").pop() || folder;
              const description = parsed.description || "";

              out.push({ name, description, path: skillFile, scope: "project" });
            }),
          );
        }),
      );

      return out;
    } catch {
      return [];
    }
  }

  private async safeReadVaultFile(filePath: string): Promise<string | null> {
    const adapter: any = this.app.vault.adapter as any;

    try {
      if (!(await adapter.exists(filePath))) {
        return null;
      }

      const content = await adapter.read(filePath);
      return typeof content === "string" ? content : null;
    } catch {
      return null;
    }
  }

  private getVaultAdapter(): {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
  } {
    return this.app.vault.adapter as {
      exists(path: string): Promise<boolean>;
      list(path: string): Promise<{ files: string[]; folders: string[] }>;
    };
  }

  private getSlashSourceLabel(source: SlashSuggestionItem["source"]): string {
    switch (source) {
      case "claude-skill":
        return ".claude/skills";
      case "opencode-command":
        return ".opencode/command";
      case "opencode-skill":
        return ".opencode/skills";
    }
  }

  private async readSlashSkillFolders(
    dir: string,
    source: SlashSuggestionItem["source"],
  ): Promise<SlashSuggestionItem[]> {
    const adapter = this.getVaultAdapter();

    try {
      if (!(await adapter.exists(dir))) {
        return [];
      }

      const listing = await adapter.list(dir);
      return listing.folders
        .map((folder) => folder.split("/").pop() || folder)
        .filter((name) => name.length > 0 && !name.startsWith("."))
        .map((name) => ({
          label: `/${name}`,
          value: `/${name}`,
          source,
          detail: this.getSlashSourceLabel(source),
          skillItem: {
            name,
            description: "",
            path: `${dir}/${name}/SKILL.md`,
            scope: source === "claude-skill" ? "project" : "global",
          },
        }));
    } catch {
      return [];
    }
  }

  private async readSlashCommands(): Promise<SlashSuggestionItem[]> {
    const dir = ".opencode/command";
    const adapter = this.getVaultAdapter();

    try {
      if (!(await adapter.exists(dir))) {
        return [];
      }

      const listing = await adapter.list(dir);
      return listing.files
        .filter((file) => file.endsWith(".md"))
        .filter((file) => {
          const name = file.split("/").pop() || file;
          return !name.startsWith(".");
        })
        .map((file) => {
          const name = (file.split("/").pop() || file).replace(/\.md$/i, "");
          return {
          label: `/${name}`,
          value: `/${name}`,
          source: "opencode-command" as const,
          detail: this.getSlashSourceLabel("opencode-command"),
          insertText: `Follow instructions in ${file}. `,
        };
        })
        .filter((item) => item.value.length > 1);
    } catch {
      return [];
    }
  }

  private async readGlobalSkills(): Promise<SkillItem[]> {
    const skillsDir = PseudoGlobalSkillDir;
    const adapter: any = this.app.vault.adapter as any;

    try {
      if (!(await adapter.exists(skillsDir))) {
        return [];
      }

      const listing = (await adapter.list(skillsDir)) as {
        files: string[];
        folders: string[];
      };

      const out: SkillItem[] = [];
      await Promise.all(
        listing.folders.map(async (folder: string) => {
          const skillFile = `${folder}/SKILL.md`;
          const content = await this.safeReadVaultFile(skillFile);
          if (!content) return;

          const parsed = this.parseFrontmatter(content);
          const skillName = parsed.name || folder.split("/").pop() || folder;
          const description = parsed.description || "";

          out.push({
            name: skillName,
            description,
            path: skillFile,
            scope: "global",
          });
        }),
      );

      return out;
    } catch {
      return [];
    }
  }

  private parseFrontmatter(content: string): Record<string, string> {
    const lines = content.split(/\r?\n/);
    if (lines.length < 3) return {};
    if (lines[0].trim() !== "---") return {};

    const out: Record<string, string> = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") {
        break;
      }

      const idx = line.indexOf(":");
      if (idx === -1) continue;

      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key) continue;

      const cleaned = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      out[key] = cleaned;
    }

    return out;
  }

  /** Create the suggestions dropdown */
  private createSuggestionsEl(): void {
    this.suggestionsEl = document.createElement("div");
    this.suggestionsEl.className = "opencodian-mention-suggestions";
    this.suggestionsEl.style.display = "none";
    this.containerEl.appendChild(this.suggestionsEl);
  }

  private handlePaste(e: ClipboardEvent): void {
    if (e.defaultPrevented) return;

    this.skipNativePaste = true;
    e.preventDefault();
    e.stopImmediatePropagation();

    const text = e.clipboardData?.getData("text/plain") ?? "";
    this.insertPlainTextAtCursor(text);
  }

  private handleDrop(e: DragEvent): void {
    if (e.defaultPrevented) return;

    this.skipNativePaste = true;
    e.preventDefault();
    e.stopImmediatePropagation();

    const text = e.dataTransfer?.getData("text/plain") ?? "";
    this.insertPlainTextAtCursor(text);
  }

  private handleBeforeInput(e: InputEvent): void {
    if (e.defaultPrevented) return;

    if (e.inputType === "deleteContentBackward") {
      if (this.deleteMentionAdjacentToCaret("backward")) {
        e.preventDefault();
      }
      return;
    }

    if (e.inputType === "deleteContentForward") {
      if (this.deleteMentionAdjacentToCaret("forward")) {
        e.preventDefault();
      }
      return;
    }

    if (e.inputType !== "insertFromPaste" && e.inputType !== "insertFromDrop") {
      return;
    }

    if (this.skipNativePaste) {
      this.skipNativePaste = false;
      e.preventDefault();
      return;
    }

    e.preventDefault();

    const data = e.dataTransfer;
    if (data) {
      const text = data.getData("text/plain") ?? "";
      this.insertPlainTextAtCursor(text);
      return;
    }

    const clipboard = (e as unknown as { clipboardData?: DataTransfer })
      .clipboardData;
    const text = clipboard?.getData("text/plain") ?? "";
    this.insertPlainTextAtCursor(text);
  }



  private insertPlainTextAtCursor(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n");
    const range = this.getSelectionRangeInInput();

    if (!range) {
      this.inputEl.appendChild(document.createTextNode(normalized));
      this.moveCaretToEnd();
      this.dispatchInputEvent();
      return;
    }

    range.deleteContents();
    const node = document.createTextNode(normalized);
    range.insertNode(node);

    range.setStartAfter(node);
    range.collapse(true);

    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
    this.dispatchInputEvent();
  }

  private dispatchInputEvent(): void {
    const event = new Event("input", { bubbles: true });
    this.inputEl.dispatchEvent(event);
  }

  private moveCaretToEnd(): void {
    const range = document.createRange();
    range.selectNodeContents(this.inputEl);
    range.collapse(false);

    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private getSelectionRangeInInput(): Range | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!this.inputEl.contains(range.startContainer)) return null;

    return range;
  }

  private getTextBeforeCursor(maxChars: number = 200): string {
    const range = this.getSelectionRangeInInput();
    if (!range) return "";

    const sel = window.getSelection();
    if (!sel) return "";

    const scan = range.cloneRange();
    scan.collapse(true);
    scan.setStart(this.inputEl, 0);

    const text = scan.toString();
    if (text.length <= maxChars) return text;

    return text.slice(-maxChars);
  }

  /** Find the @query trigger right before cursor */
  private findMentionTrigger(
    beforeCursor: string,
  ): { query: string; type: SuggestionTriggerType } | null {
    let triggerIndex = -1;
    let triggerType: SuggestionTriggerType | null = null;

    for (let i = beforeCursor.length - 1; i >= 0; i--) {
      const ch = beforeCursor[i];
      if (ch === "@" || ch === "/") {
        if (i === 0 || /\s/.test(beforeCursor[i - 1])) {
          triggerIndex = i;
          triggerType = ch === "@" ? "mention" : "slash";
          break;
        }
      }

      if (/\s/.test(ch) && i !== beforeCursor.length - 1) {
        break;
      }
    }

    if (triggerIndex === -1 || !triggerType) return null;

    const query = beforeCursor.slice(triggerIndex + 1);
    if (query.includes("\n")) return null;

    this.mentionRange = this.computeMentionRange(
      triggerIndex,
      beforeCursor.length,
    );
    if (!this.mentionRange) return null;

    return { query, type: triggerType };
  }

  private computeMentionRange(
    atIndex: number,
    cursorIndex: number,
  ): Range | null {
    const range = this.getSelectionRangeInInput();
    if (!range) return null;

    const full = range.cloneRange();
    full.collapse(true);
    full.setStart(this.inputEl, 0);

    const text = full.toString();
    const skip = Math.max(text.length - cursorIndex, 0);

    const startOffsetInText = text.length - cursorIndex + atIndex;
    const endOffsetInText = text.length - skip;

    return this.rangeFromTextOffsets(startOffsetInText, endOffsetInText);
  }

  private rangeFromTextOffsets(start: number, end: number): Range | null {
    const walker = document.createTreeWalker(
      this.inputEl,
      NodeFilter.SHOW_TEXT,
      null,
    );

    let node = walker.nextNode() as Text | null;
    let offset = 0;

    const makePoint = (
      absolute: number,
    ): { node: Text; offset: number } | null => {
      let current = node;
      let currentOffset = offset;

      while (current) {
        const len = current.data.length;
        if (absolute <= currentOffset + len) {
          return {
            node: current,
            offset: Math.max(0, absolute - currentOffset),
          };
        }
        currentOffset += len;
        current = walker.nextNode() as Text | null;
      }
      return null;
    };

    node = walker.currentNode as Text | null;
    offset = 0;

    // Reset walker state
    walker.currentNode = this.inputEl;
    node = walker.nextNode() as Text | null;
    offset = 0;

    const startPoint = makePoint(start);

    // Reset walker again because makePoint consumed it
    walker.currentNode = this.inputEl;
    node = walker.nextNode() as Text | null;
    offset = 0;

    const endPoint = makePoint(end);

    if (!startPoint || !endPoint) return null;

    const r = document.createRange();
    r.setStart(startPoint.node, startPoint.offset);
    r.setEnd(endPoint.node, endPoint.offset);
    return r;
  }

  /** Zero Width Space - used to ensure cursor can be placed before/after chips */
  private static readonly ZWS = "\u200B";

  /** Handle input changes - detect @ trigger */
  private handleInput(): void {
    // Ensure chips always have ZWS before them for cursor positioning
    this.ensureChipZWS();

    // Remove active mention chip if editor is empty besides it.
    if (this.activeFileMention) {
      const text = this.getPlainText().trim();
      if (!text) {
        // Keep active mention as a chip even if there's no text.
      }
    }

    const beforeCursor = this.getTextBeforeCursor();
    const mentionMatch = this.findMentionTrigger(beforeCursor);

    if (mentionMatch) {
      void this.refreshSuggestions(mentionMatch.type, mentionMatch.query);
      return;
    }

    this.hide();
  }

  private async refreshSuggestions(
    type: SuggestionTriggerType,
    query: string,
  ): Promise<void> {
    const requestId = this.mentionQueryId + 1;
    this.mentionQueryId = requestId;
    this.activeTriggerType = type;

    await this.loadItems();
    if (requestId !== this.mentionQueryId) return;

    this.filterItems(type, query);
    this.show();
  }


  /**
   * Ensure every chip has a ZWS before it for cursor positioning.
   * This prevents the bug where deleting all text before a chip
   * causes it to jump lines and become unreachable.
   */
  private ensureChipZWS(): void {
    const chips = this.inputEl.querySelectorAll(
      ".opencodian-inline-mention-chip, .opencodian-inline-skill-chip, .opencodian-inline-agent-chip",
    );

    for (const chip of Array.from(chips)) {
      const prev = chip.previousSibling;

      // Check if previous sibling is a text node ending with ZWS
      if (!prev || prev.nodeType !== Node.TEXT_NODE) {
        // No text node before chip - insert ZWS
        const zws = document.createTextNode(FileMention.ZWS);
        chip.parentNode?.insertBefore(zws, chip);
      } else {
        const textNode = prev as Text;
        // If text node is empty or doesn't end with our ZWS, add one
        if (textNode.data.length === 0) {
          textNode.data = FileMention.ZWS;
        }
      }
    }
  }


  private filterItems(type: SuggestionTriggerType, query: string): void {
    const lowerQuery = query.toLowerCase();

    if (type === "slash") {
      let filteredSlash = this.slashItems;

      if (query) {
        filteredSlash = filteredSlash.filter((item) => {
          const label = item.label.toLowerCase();
          const value = item.value.toLowerCase();
          const detail = item.detail.toLowerCase();
          return (
            label.includes(lowerQuery) ||
            value.includes(lowerQuery) ||
            detail.includes(lowerQuery)
          );
        });
      }

      this.filteredItems = filteredSlash.map((item) => ({
        type: "slash",
        item,
      }));
      this.selectedIndex = 0;
      this.renderSuggestions();
      return;
    }

    const mentionedPaths = new Set(this.mentions.map((m) => m.path));

    const availableFiles = this.fileItems.filter(
      (item) => !mentionedPaths.has(item.path),
    );

    const mentionedSkills = new Set(this.skillMentions.map((m) => m.path));
    const availableSkills = this.skillItems.filter(
      (item) => !mentionedSkills.has(item.path),
    );

    const mentionedAgents = new Set(this.agentMentions.map((m) => m.name));
    const availableAgents = this.agentItems.filter(
      (item) => !mentionedAgents.has(item.name),
    );

    if (!query) {
      if (this.mentionCategory === "root") {
        this.filteredItems = [
          {
            type: "category",
            item: { category: "files", name: "files" },
          },
          {
            type: "category",
            item: { category: "skills", name: "skills" },
          },
          {
            type: "category",
            item: { category: "agents", name: "agents" },
          },
        ];
        this.selectedIndex = 0;
        this.renderSuggestions();
        return;
      }

      if (this.mentionCategory === "files") {
        const topLevelFiles = availableFiles.filter(
          (item) => !item.path.includes("/"),
        );
        this.filteredItems = topLevelFiles.map((item) => ({
          type: "file",
          item,
        }));
        this.selectedIndex = 0;
        this.renderSuggestions();
        return;
      }

      if (this.mentionCategory === "agents") {
        this.filteredItems = availableAgents.map((item) => ({
          type: "agent",
          item,
        }));
        this.selectedIndex = 0;
        this.renderSuggestions();
        return;
      }

      this.filteredItems = availableSkills.map((item) => ({
        type: "skill",
        item,
      }));
      this.selectedIndex = 0;
      this.renderSuggestions();
      return;
    }

    const filteredFiles = availableFiles.filter((item) => {
      const lowerPath = item.path.toLowerCase();
      const lowerName = item.name.toLowerCase();
      return lowerPath.includes(lowerQuery) || lowerName.includes(lowerQuery);
    });

    const filteredSkills = availableSkills.filter((item) => {
      const name = item.name.toLowerCase();
      const description = item.description.toLowerCase();
      return name.includes(lowerQuery) || description.includes(lowerQuery);
    });

    const filteredAgents = availableAgents.filter((item) => {
      const name = item.name.toLowerCase();
      const description = (item.description ?? "").toLowerCase();
      return name.includes(lowerQuery) || description.includes(lowerQuery);
    });
    const fileMatches: UnifiedMentionItem[] = filteredFiles.map((item) => ({
      type: "file",
      item,
    }));
    const skillMatches: UnifiedMentionItem[] = filteredSkills.map((item) => ({
      type: "skill",
      item,
    }));
    const agentMatches: UnifiedMentionItem[] = filteredAgents.map((item) => ({
      type: "agent",
      item,
    }));

    if (query) {
      const maxItems = 20;
      const maxSkills = Math.min(skillMatches.length, 6);
      const maxAgents = Math.min(agentMatches.length, 6);
      const maxFiles = Math.max(maxItems - maxSkills - maxAgents, 0);
      this.filteredItems = [
        ...fileMatches.slice(0, maxFiles),
        ...skillMatches.slice(0, maxSkills),
        ...agentMatches.slice(0, maxAgents),
      ];
    } else {
      this.filteredItems = [...fileMatches, ...skillMatches, ...agentMatches];
    }

    this.selectedIndex = 0;
    this.renderSuggestions();
  }

  /** Render suggestions list */
  private renderSuggestions(): void {
    if (!this.suggestionsEl) return;
    this.suggestionsEl.innerHTML = "";

    if (this.filteredItems.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "opencodian-mention-empty";
      emptyEl.textContent = "No matches found";
      this.suggestionsEl.appendChild(emptyEl);
      return;
    }

    for (let i = 0; i < this.filteredItems.length; i++) {
      const option = this.filteredItems[i];
      const itemEl = document.createElement("div");
      itemEl.className = "opencodian-mention-item";
      if (i === this.selectedIndex) {
        itemEl.classList.add("selected");
      }

      const iconEl = document.createElement("span");
      iconEl.className = "opencodian-mention-icon";
      if (option.type === "category") {
        if (option.item.category === "files") {
          setIcon(iconEl, "folder");
        } else if (option.item.category === "skills") {
          setIcon(iconEl, "wand");
        } else {
          setIcon(iconEl, "bot");
        }
      }

      if (option.type === "file") {
        setIcon(iconEl, option.item.isFolder ? "folder" : "file-text");
      }

      if (option.type === "skill") {
        setIcon(iconEl, "wand");
      }

      if (option.type === "agent") {
        setIcon(iconEl, "bot");
      }
      if (option.type === "slash") {
        setIcon(iconEl, "terminal-square");
      }
      itemEl.appendChild(iconEl);

      const bodyEl = document.createElement("div");
      bodyEl.className = "opencodian-mention-body";

      const pathEl = document.createElement("span");
      pathEl.className = "opencodian-mention-path";
      if (option.type === "category") {
        pathEl.textContent = option.item.name;
      }

      if (option.type === "file") {
        pathEl.textContent = option.item.path;
      }

      if (option.type === "skill") {
        pathEl.textContent = option.item.name;
      }

      if (option.type === "agent") {
        pathEl.textContent = option.item.name;
      }

      if (option.type === "slash") {
        pathEl.textContent = option.item.label;
      }

      bodyEl.appendChild(pathEl);

      if (option.type !== "file") {
        const metaEl = document.createElement("span");
        metaEl.className = "opencodian-mention-meta";
        metaEl.textContent =
          option.type === "skill"
            ? option.item.scope
            : option.type === "agent"
              ? (option.item.description ?? option.item.mode)
              : option.type === "category"
                ? ""
                : option.item.detail;
        if (metaEl.textContent) {
          bodyEl.appendChild(metaEl);
        }
      }

      if (option.type === "agent") {
        const modeEl = document.createElement("span");
        modeEl.className = "opencodian-mention-scope";
        modeEl.textContent = option.item.mode;
        itemEl.appendChild(modeEl);
      }

      if (option.type === "category") {
        const arrowEl = document.createElement("span");
        arrowEl.className = "opencodian-mention-arrow";
        arrowEl.textContent = "›";
        itemEl.appendChild(arrowEl);
      }

      itemEl.appendChild(bodyEl);

      itemEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectItem(option);
      });

      itemEl.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.updateSelection();
      });

      this.suggestionsEl.appendChild(itemEl);
    }
  }

  /** Update visual selection */
  private updateSelection(): void {
    if (!this.suggestionsEl) return;
    const items = this.suggestionsEl.querySelectorAll(
      ".opencodian-mention-item",
    );
    items.forEach((el, i) => {
      el.classList.toggle("selected", i === this.selectedIndex);
    });

    const selectedEl = items[this.selectedIndex] as HTMLElement | undefined;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }

  /** Handle keyboard navigation */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen) return;

    const len = this.filteredItems.length;
    if (len === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = (this.selectedIndex + 1) % len;
        this.updateSelection();
        break;

      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.selectedIndex = (this.selectedIndex - 1 + len) % len;
        this.updateSelection();
        break;

      case "Enter":
        e.preventDefault();
        e.stopImmediatePropagation();
        this.selectItem(this.filteredItems[this.selectedIndex]);
        break;

      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;

      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        this.selectItem(this.filteredItems[this.selectedIndex]);
        break;
    }
  }

  private handleBlur(): void {
    setTimeout(() => this.hide(), 150);
  }

  private createInlineChip(item: MentionItem, isActive: boolean): HTMLElement {
    const chipEl = document.createElement("span");
    chipEl.className = "opencodian-inline-mention-chip";
    if (isActive) {
      chipEl.classList.add("opencodian-inline-mention-chip-active");
    }

    chipEl.setAttribute("contenteditable", "false");
    chipEl.setAttribute("data-mention-path", item.path);
    chipEl.setAttribute("data-mention-name", item.name);
    chipEl.setAttribute("data-mention-folder", item.isFolder ? "1" : "0");
    chipEl.title = item.path;

    const clickArea = document.createElement("span");
    clickArea.className = "opencodian-inline-mention-chip-click";
    clickArea.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openFile(item.path);
    });

    const iconEl = document.createElement("span");
    iconEl.className = "opencodian-inline-mention-chip-icon";
    setIcon(iconEl, item.isFolder ? "folder" : "file-text");
    clickArea.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "opencodian-inline-mention-chip-name";
    nameEl.textContent = item.name;
    clickArea.appendChild(nameEl);

    chipEl.appendChild(clickArea);

    const removeEl = document.createElement("span");
    removeEl.className = "opencodian-inline-mention-chip-remove";
    setIcon(removeEl, "x");
    removeEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeMention(item);
      this.removeChipWithAdjacentZws(chipEl);
    });
    chipEl.appendChild(removeEl);

    return chipEl;
  }

  private createSkillChip(item: SkillItem): HTMLElement {
    const chipEl = document.createElement("span");
    chipEl.className = "opencodian-inline-skill-chip";

    chipEl.setAttribute("contenteditable", "false");
    chipEl.setAttribute("data-skill-name", item.name);
    chipEl.setAttribute("data-skill-path", item.path);
    chipEl.setAttribute("data-skill-scope", item.scope);
    chipEl.title = item.description || item.name;

    const clickArea = document.createElement("span");
    clickArea.className = "opencodian-inline-skill-chip-click";

    const iconEl = document.createElement("span");
    iconEl.className = "opencodian-inline-skill-chip-icon";
    setIcon(iconEl, "wand");
    clickArea.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "opencodian-inline-skill-chip-name";
    nameEl.textContent = item.name;
    clickArea.appendChild(nameEl);

    chipEl.appendChild(clickArea);

    const removeEl = document.createElement("span");
    removeEl.className = "opencodian-inline-skill-chip-remove";
    setIcon(removeEl, "x");
    removeEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeSkillMention(item);
      this.removeChipWithAdjacentZws(chipEl);
    });
    chipEl.appendChild(removeEl);

    return chipEl;
  }

  private createAgentChip(item: AgentInfo): HTMLElement {
    const chipEl = document.createElement("span");
    chipEl.className = "opencodian-inline-agent-chip opencodian-inline-skill-chip";

    chipEl.setAttribute("contenteditable", "false");
    chipEl.setAttribute("data-agent-name", item.name);
    chipEl.setAttribute("data-agent-mode", item.mode);
    chipEl.setAttribute("data-agent-hidden", item.hidden ? "1" : "0");
    chipEl.title = item.description || item.name;

    const clickArea = document.createElement("span");
    clickArea.className = "opencodian-inline-skill-chip-click";

    const iconEl = document.createElement("span");
    iconEl.className = "opencodian-inline-skill-chip-icon";
    setIcon(iconEl, "bot");
    clickArea.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "opencodian-inline-skill-chip-name";
    nameEl.textContent = item.name;
    clickArea.appendChild(nameEl);

    chipEl.appendChild(clickArea);

    const removeEl = document.createElement("span");
    removeEl.className = "opencodian-inline-skill-chip-remove";
    setIcon(removeEl, "x");
    removeEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.removeAgentMention(item);
      this.removeChipWithAdjacentZws(chipEl);
    });
    chipEl.appendChild(removeEl);

    return chipEl;
  }


  private insertNodeAtCursor(node: Node): void {
    const range = this.getSelectionRangeInInput();
    if (!range) {
      this.inputEl.appendChild(node);
      return;
    }

    range.insertNode(node);

    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);

    const sel = window.getSelection();
    if (!sel) return;

    sel.removeAllRanges();
    sel.addRange(after);
  }

  private removeChipWithAdjacentZws(chipEl: HTMLElement): void {
    const prev = chipEl.previousSibling;
    const next = chipEl.nextSibling;

    const removeZwsNode = (node: Node | null): void => {
      if (!node) return;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node as Text;
      if (text.data !== FileMention.ZWS) return;
      text.remove();
    };

    const setCaretAfter = (node: Node): void => {
      const range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    };

    const focusAfter = next;
    chipEl.remove();

    removeZwsNode(prev);
    removeZwsNode(next);

    if (focusAfter && focusAfter.parentNode) {
      setCaretAfter(focusAfter);
      return;
    }

    const parent = this.inputEl;
    if (parent.lastChild) {
      setCaretAfter(parent.lastChild);
      return;
    }

    parent.focus();
  }

  private deleteMentionAdjacentToCaret(
    direction: "backward" | "forward",
  ): boolean {
    const range = this.getSelectionRangeInInput();
    if (!range) return false;
    if (!range.collapsed) return false;

    const point = {
      node: range.startContainer,
      offset: range.startOffset,
    };

    const findChip = (
      node: Node | null,
    ): HTMLElement | null => {
      if (!node) return null;
      if (!(node instanceof HTMLElement)) return null;
      if (node.classList.contains("opencodian-inline-mention-chip")) return node;
      if (node.classList.contains("opencodian-inline-skill-chip")) return node;
      return null;
    };

    const isZwsText = (n: Node | null): n is Text => {
      if (!n) return false;
      if (n.nodeType !== Node.TEXT_NODE) return false;
      return (n as Text).data === FileMention.ZWS;
    };

    const chipFromCaretNode = (): HTMLElement | null => {
      if (point.node.nodeType !== Node.TEXT_NODE) return null;
      if (!isZwsText(point.node)) return null;
      if (direction === "backward") {
        return findChip(point.node.previousSibling);
      }
      return findChip(point.node.nextSibling);
    };

    const adjacentSibling = (
      dir: "backward" | "forward",
    ): Node | null => {
      if (point.node.nodeType === Node.TEXT_NODE) {
        const text = point.node as Text;
        if (dir === "backward") {
          if (point.offset !== 0) return null;
          return text.previousSibling;
        }
        if (point.offset !== text.data.length) return null;
        return text.nextSibling;
      }

      // Element container: selection offset is child index.
      const el = point.node as Element;
      const idx = point.offset;
      if (dir === "backward") {
        return idx > 0 ? el.childNodes[idx - 1] : null;
      }
      return idx < el.childNodes.length ? el.childNodes[idx] : null;
    };

    // Many browsers place caret “inside” a ZWS text node around chips.
    // Treat deleting adjacent ZWS+chip as deleting the chip itself.
    const deleteChip = (chip: HTMLElement): boolean => {
      if (!this.inputEl.contains(chip)) return false;

      if (chip.classList.contains("opencodian-inline-mention-chip")) {
        const p = chip.getAttribute("data-mention-path") || "";
        if (p) {
          this.mentions = this.mentions.filter((m) => m.path !== p);
          if (this.activeFileMention && this.activeFileMention.path === p) {
            this.activeFileMention = null;
          }
        }
      }

      if (chip.classList.contains("opencodian-inline-skill-chip")) {
        const p = chip.getAttribute("data-skill-path") || "";
        if (p) {
          this.skillMentions = this.skillMentions.filter((m) => m.path !== p);
        }
      }

      if (chip.classList.contains("opencodian-inline-agent-chip")) {
        const name = chip.getAttribute("data-agent-name") || "";
        if (name) {
          this.agentMentions = this.agentMentions.filter((m) => m.name !== name);
        }
      }

      this.removeChipWithAdjacentZws(chip);
      return true;
    };

    const directChip = chipFromCaretNode();
    if (directChip) {
      return deleteChip(directChip);
    }

    const sibling = adjacentSibling(direction);

    const getChipFromNode = (n: Node | null): HTMLElement | null => {
      const direct = findChip(n);
      if (direct) return direct;

      if (isZwsText(n)) {
        if (direction === "backward") {
          return findChip(n.previousSibling);
        }
        return findChip(n.nextSibling);
      }

      return null;
    };

    const chip = getChipFromNode(sibling);
    if (!chip) return false;

    return deleteChip(chip);
  }

  private insertTextAtCursor(text: string): void {
    const node = document.createTextNode(text);
    this.insertNodeAtCursor(node);
  }

  /** Select an item - insert chip and remove @query */
  private selectItem(item: UnifiedMentionItem): void {
    if (item.type === "category") {
      this.mentionCategory = item.item.category;
      this.filterItems("mention", "");
      this.show();
      return;
    }

    if (item.type === "file") {
      this.insertFileMention(item.item);
      return;
    }

    if (item.type === "agent") {
      this.insertAgentMention(item.item);
      return;
    }

    if (item.type === "slash") {
      this.insertSlashSuggestion(item.item);
      return;
    }

    this.insertSkillMention(item.item);
  }

  private insertSlashSuggestion(item: SlashSuggestionItem): void {
    if (item.skillItem) {
      this.insertSkillMention(item.skillItem);
      return;
    }

    const text = item.insertText || `${item.value} `;

    if (this.mentionRange) {
      this.mentionRange.deleteContents();

      const node = document.createTextNode(text);
      this.mentionRange.insertNode(node);

      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);

      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(after);
      }

      this.mentionRange = null;
      this.dispatchInputEvent();
    } else {
      this.insertPlainTextAtCursor(text);
    }

    this.hide();
    this.inputEl.focus();
  }

  private insertFileMention(item: MentionItem): void {
    if (!this.mentions.find((m) => m.path === item.path)) {
      this.mentions.push(item);
    }

    if (this.mentionRange) {
      this.mentionRange.deleteContents();

      const chipEl = this.createInlineChip(item, false);

      const zwsBefore = document.createTextNode(FileMention.ZWS);
      this.mentionRange.insertNode(zwsBefore);
      zwsBefore.after(chipEl);

      const space = document.createTextNode(" ");
      chipEl.after(space);

      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);

      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(after);
      }

      this.mentionRange = null;
    } else {
      this.insertTextAtCursor(FileMention.ZWS);
      this.insertNodeAtCursor(this.createInlineChip(item, false));
      this.insertTextAtCursor(" ");
    }

    this.hide();
    this.inputEl.focus();
  }

  private insertSkillMention(item: SkillItem): void {
    if (!this.skillMentions.find((m) => m.path === item.path)) {
      this.skillMentions.push(item);
    }

    if (this.mentionRange) {
      this.mentionRange.deleteContents();

      const chipEl = this.createSkillChip(item);

      const zwsBefore = document.createTextNode(FileMention.ZWS);
      this.mentionRange.insertNode(zwsBefore);
      zwsBefore.after(chipEl);

      const space = document.createTextNode(" ");
      chipEl.after(space);

      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);

      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(after);
      }

      this.mentionRange = null;
    } else {
      this.insertTextAtCursor(FileMention.ZWS);
      this.insertNodeAtCursor(this.createSkillChip(item));
      this.insertTextAtCursor(" ");
    }

    this.hide();
    this.inputEl.focus();
  }

  private insertAgentMention(item: AgentInfo): void {
    if (!this.agentMentions.find((m) => m.name === item.name)) {
      this.agentMentions.push(item);
    }

    if (this.mentionRange) {
      this.mentionRange.deleteContents();

      const chipEl = this.createAgentChip(item);

      const zwsBefore = document.createTextNode(FileMention.ZWS);
      this.mentionRange.insertNode(zwsBefore);
      zwsBefore.after(chipEl);

      const space = document.createTextNode(" ");
      chipEl.after(space);

      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);

      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(after);
      }

      this.mentionRange = null;
    } else {
      this.insertTextAtCursor(FileMention.ZWS);
      this.insertNodeAtCursor(this.createAgentChip(item));
      this.insertTextAtCursor(" ");
    }

    this.hide();
    this.inputEl.focus();
  }


  private show(): void {
    if (!this.suggestionsEl) return;
    this.isOpen = true;
    this.suggestionsEl.style.display = "block";
  }

  private hide(): void {
    if (!this.suggestionsEl) return;
    this.isOpen = false;
    this.suggestionsEl.style.display = "none";
    this.mentionRange = null;
    this.mentionCategory = "root";
  }

  /** Open a file in Obsidian */
  openFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;

    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        leaf.openFile(file);
      }
      return;
    }

    if (file instanceof TFolder) {
      const fileExplorer =
        this.app.workspace.getLeavesOfType("file-explorer")[0];
      if (fileExplorer) {
        this.app.workspace.revealLeaf(fileExplorer);
        const explorerView = fileExplorer.view as any;
        if (explorerView?.revealInFolder) {
          explorerView.revealInFolder(file);
        }
      }
    }
  }

  private removeMention(item: MentionItem): void {
    this.mentions = this.mentions.filter((m) => m.path !== item.path);

    // If active file chip removed, disable it.
    if (this.activeFileMention && this.activeFileMention.path === item.path) {
      this.activeFileMention = null;
    }
  }

  private removeSkillMention(item: SkillItem): void {
    this.skillMentions = this.skillMentions.filter((m) => m.path !== item.path);
  }

  private removeAgentMention(item: AgentInfo): void {
    this.agentMentions = this.agentMentions.filter((m) => m.name !== item.name);
  }


  /** Get current mention paths */
  getMentionPaths(): string[] {
    return this.getMentionsFromDom().map((m) => m.path);
  }

  private getMentionsFromDom(): MentionItem[] {
    const els = this.inputEl.querySelectorAll(
      ".opencodian-inline-mention-chip[data-mention-path]",
    );

    const out: MentionItem[] = [];
    for (const el of Array.from(els)) {
      const path = el.getAttribute("data-mention-path") || "";
      const name = el.getAttribute("data-mention-name") || "";
      const isFolder = el.getAttribute("data-mention-folder") === "1";
      if (!path) continue;
      out.push({ path, name, isFolder });
    }
    return out;
  }

  private getSkillMentionsFromDom(): SkillItem[] {
    const els = this.inputEl.querySelectorAll(
      ".opencodian-inline-skill-chip[data-skill-path]",
    );

    const out: SkillItem[] = [];
    for (const el of Array.from(els)) {
      const skillPath = el.getAttribute("data-skill-path") || "";
      const name = el.getAttribute("data-skill-name") || "";
      const scope =
        el.getAttribute("data-skill-scope") === "global" ? "global" : "project";
      if (!skillPath || !name) continue;
      out.push({ name, description: "", path: skillPath, scope });
    }
    return out;
  }

  private getAgentMentionsFromDom(): AgentInfo[] {
    const els = this.inputEl.querySelectorAll(
      ".opencodian-inline-agent-chip[data-agent-name]",
    );

    const out: AgentInfo[] = [];
    for (const el of Array.from(els)) {
      const name = el.getAttribute("data-agent-name") || "";
      const modeAttr = el.getAttribute("data-agent-mode") || "subagent";
      const hidden = el.getAttribute("data-agent-hidden") === "1";
      const mode =
        modeAttr === "primary" || modeAttr === "all" ? modeAttr : "subagent";
      if (!name) continue;
      out.push({ name, mode, hidden });
    }
    return out;
  }

  getMentions(): MentionItem[] {
    return this.getMentionsFromDom();
  }


  getText(): string {
    return this.getPlainTextWithAllNames();
  }

  getSkills(): SkillItem[] {
    return this.getSkillMentionsFromDom();
  }

  getAgents(): AgentInfo[] {
    return this.getAgentMentionsFromDom();
  }

  getTextWithSkills(): string {
    return this.getPlainTextWithAllNames();
  }


  clear(): void {
    this.clearMentions();
    this.clearInput();
  }

  /**
   * Extract plain text & mentions then clear input.
   * Chips become their `name` in the returned text.
   */
  getTextAndMentionsAndClear(): { text: string; mentions: MentionItem[] } {
    const mentions = this.getMentionsFromDom();
    const text = this.getPlainTextWithAllNames();

    this.clearMentions();
    this.clearInput();

    return { text, mentions };
  }

  getTextAndSkillsAndClear(): { text: string; skills: SkillItem[] } {
    const skills = this.getSkillMentionsFromDom();
    const text = this.getPlainTextWithAllNames();

    this.clearMentions();
    this.clearInput();

    return { text, skills };
  }


  private clearInput(): void {
    this.inputEl.innerHTML = "";
  }

  private getPlainText(): string {
    // Remove ZWS characters that are only used for cursor positioning
    return (this.inputEl.textContent || "").replace(/\u200B/g, "");
  }

  private getPlainTextWithMentionNames(): string {
    return this.getPlainTextWithAllNames();
  }

  private getPlainTextWithAllNames(): string {
    const clone = this.inputEl.cloneNode(true) as HTMLElement;

    const fileChips = clone.querySelectorAll(
      ".opencodian-inline-mention-chip[data-mention-name]",
    );
    for (const chip of Array.from(fileChips)) {
      const name = chip.getAttribute("data-mention-name") || "";
      chip.replaceWith(document.createTextNode(name));
    }

    const skillChips = clone.querySelectorAll(
      ".opencodian-inline-skill-chip[data-skill-name]",
    );
    for (const chip of Array.from(skillChips)) {
      const name = chip.getAttribute("data-skill-name") || "";
      chip.replaceWith(document.createTextNode(name));
    }

    const agentChips = clone.querySelectorAll(
      ".opencodian-inline-agent-chip[data-agent-name]",
    );
    for (const chip of Array.from(agentChips)) {
      const name = chip.getAttribute("data-agent-name") || "";
      chip.replaceWith(document.createTextNode(name));
    }

    return (clone.textContent || "").replace(/\u200B/g, "").trim();
  }


  /** Clear all mentions (both manual and active file) */
  clearMentions(): void {
    this.mentions = [];
    this.skillMentions = [];
    this.agentMentions = [];
    this.activeFileMention = null;

    const chips = this.inputEl.querySelectorAll(
      ".opencodian-inline-mention-chip, .opencodian-inline-skill-chip, .opencodian-inline-agent-chip",
    );
    chips.forEach((el) => el.remove());
  }


  /** Check if suggestions dropdown is open */
  isSuggestionsOpen(): boolean {
    return this.isOpen;
  }

  refresh(): void {
    void this.loadItems();
  }

  /** Add a mention programmatically */
  addMention(path: string): boolean {
    if (this.mentions.find((m) => m.path === path)) {
      return false;
    }

    const item = this.fileItems.find((fileItem) => fileItem.path === path);
    if (!item) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return false;

      this.mentions.push({
        path: path,
        name: file.name,
        isFolder: file instanceof TFolder,
      });
    } else {
      this.mentions.push(item);
    }

    return true;
  }


  /** Set the active file mention (insert or update a pinned chip) */
  setActiveFileMention(path: string | null): void {
    const existing = this.inputEl.querySelector(
      ".opencodian-inline-mention-chip-active[data-mention-path]",
    ) as HTMLElement | null;

    if (!path) {
      this.activeFileMention = null;
      if (existing) existing.remove();
      return;
    }

    if (this.activeFileMention && this.activeFileMention.path === path) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      this.activeFileMention = null;
      if (existing) existing.remove();
      return;
    }

    const item: MentionItem = {
      path: path,
      name: file.name,
      isFolder: file instanceof TFolder,
    };
    this.activeFileMention = item;

    if (existing) existing.remove();

    const chipEl = this.createInlineChip(item, true);
    this.inputEl.insertBefore(chipEl, this.inputEl.firstChild);
    this.inputEl.insertBefore(document.createTextNode(" "), chipEl.nextSibling);
  }

  /** Get all mentions (active file + manual) and clear them */
  getMentionsAndClear(): MentionItem[] {
    const result = this.getMentionsFromDom();
    this.clearMentions();
    return result;
  }

  destroy(): void {
    this.inputEl.removeEventListener("paste", this.handlePasteBound);
    this.inputEl.removeEventListener("drop", this.handleDropBound);
    this.inputEl.removeEventListener(
      "beforeinput",
      this.handleBeforeInputBound,
    );

    if (this.suggestionsEl) {
      this.suggestionsEl.remove();
    }
  }
}
