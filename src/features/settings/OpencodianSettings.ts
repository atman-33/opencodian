/**
 * Settings tab for Opencodian
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type OpencodianPlugin from "../../main";

export class OpencodianSettingTab extends PluginSettingTab {
  plugin: OpencodianPlugin;

  constructor(app: App, plugin: OpencodianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("opencodian-settings");

    containerEl.createEl("h2", { text: "Opencodian Settings" });

    // ========== Customization Section ==========
    new Setting(containerEl).setName("Customization").setHeading();

    // User name
    new Setting(containerEl)
      .setName("What should OpenCode call you?")
      .setDesc(
        "Your name for personalized greetings (leave empty for generic greetings)"
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your name")
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          })
      );

    // System prompt
    new Setting(containerEl)
      .setName("Custom system prompt")
      .setDesc("Additional instructions appended to the default system prompt")
      .addTextArea((text) => {
        text
          .setPlaceholder("You are a helpful assistant...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
      });

    // Excluded tags
    new Setting(containerEl)
      .setName("Excluded tags")
      .setDesc(
        "Notes with these tags will not auto-load as context (one per line, without #)"
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("private\ndraft\ntemplate")
          .setValue(this.plugin.settings.excludedTags.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ""))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    // ========== Safety Section ==========
    new Setting(containerEl).setName("Safety").setHeading();

    // Permission mode
    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("YOLO: no approval prompts. Safe: approve each action.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("yolo", "YOLO (Allow all)")
          .addOption("safe", "Safe (Approve each)")
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (value: "yolo" | "safe") => {
            this.plugin.settings.permissionMode = value;
            await this.plugin.saveSettings();
          })
      );

    // ========== Environment Section ==========
    new Setting(containerEl).setName("Environment").setHeading();

    // Environment variables
    new Setting(containerEl)
      .setName("Environment variables")
      .setDesc(
        "Custom environment variables for OpenCode (KEY=VALUE format, one per line)"
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("OPENAI_API_KEY=your-key\nANTHROPIC_API_KEY=your-key")
          .setValue(this.plugin.settings.environmentVariables)
          .onChange(async (value) => {
            this.plugin.settings.environmentVariables = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass("opencodian-settings-env-textarea");
      });

    // ========== Advanced Section ==========
    new Setting(containerEl).setName("Advanced").setHeading();

    // Debug logging
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Enable verbose logs in the developer console (simulating backend logs)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            this.plugin.agentService.setDebugEnabled(value);
            await this.plugin.saveSettings();
          })
      );

    // OpenCode path
    new Setting(containerEl)
      .setName("OpenCode CLI path")
      .setDesc("Full path to OpenCode CLI. Auto-detected if left empty. Only set manually if auto-detection fails.")
      .addText((text) => {
        text
          .setPlaceholder("Auto-detected")
          .setValue(this.plugin.settings.opencodePath)
          .onChange(async (value) => {
            this.plugin.settings.opencodePath = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "100%";
      });
  }
}
