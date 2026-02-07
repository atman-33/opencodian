/**
 * OpenCode Service - Core integration with OpenCode via SDK
 *
 * Uses @opencode-ai/sdk to communicate with the OpenCode server.
 * Automatically starts the OpenCode server if not running.
 * Supports streaming responses, file context, and session management.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { App } from "obsidian";

import { spawn, exec } from "child_process";
import * as http from "http";
import * as readline from "readline";
import path from "path";
import { pathToFileURL } from "url";

import type { ChatMessage, ImageAttachment, StreamChunk, ConfigProvidersResponse } from "../types";
import {
  OpencodianError,
  UserCancellationError,
  ServerError,
  NetworkError
} from "../errors";

export interface MentionContext {
  path: string;
  name: string;
  isFolder: boolean;
  /** For folders: list of children paths */
  children?: string[];
}

export interface QueryOptions {
  model?: string;
  allowedTools?: string[];
  permissionMode?: "yolo" | "safe";
  /** File/folder paths mentioned with @ syntax */
  mentions?: string[];
  /** Rich mention context with folder contents */
  mentionContexts?: MentionContext[];
  /** Conversation id for debug logging */
  conversationId?: string;
  /** Timeout in milliseconds for the entire query (default: 120000 = 2 minutes) */
  timeout?: number;
}

type ToolAttachment = {
  url: string;
  filename?: string;
  mime?: string;
};

type BusEvent = {
  type: string;
  properties?: Record<string, unknown>;
};


type OpencodeClient = ReturnType<typeof createOpencodeClient>;

/** Debug turn data structure */
interface DebugTurn {
  timestamp: string;
  userPrompt: string;
  events: unknown[];
  meta?: Record<string, unknown>;
}


/**
 * Service for interacting with OpenCode
 */
export class OpenCodeService {
  private client: OpencodeClient | null = null;
  private sessionId: string | null = null;
  private sessionPermissionMode: "safe" | "yolo" = "yolo";
  private abortController: AbortController | null = null;
  private eventAbort: AbortController | null = null;
  private eventStarted: boolean = false;
  private eventListeners = new Set<(event: BusEvent) => void>();
  private serverUrl: string = "http://localhost:4096";
  private serverClose: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private opencodePath: string = "opencode";

  // Debug logging
  private app: App | null = null;
  private debugEnabled: boolean = true;
  private readonly DEBUG_SESSIONS_PATH = ".obsidian/plugins/opencodian/sessions-debug";


  constructor() {
    // Lazy initialization
  }

  /** Set Obsidian app reference for file operations */
  setApp(app: App): void {
    this.app = app;
  }

  /** Enable/disable debug logging */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /** Set OpenCode CLI path (for custom installations) */
  setOpencodePath(path: string): void {
    this.opencodePath = path || "opencode";
  }

  /**
   * Auto-detect OpenCode CLI path using shell commands.
   * Tries common locations first, then runs system commands.
   */
  async detectOpencodePath(): Promise<string | null> {
    const platform = process.platform;

    console.log(`[OpenCodeService] Auto-detecting opencode on platform: ${platform}`);

    // Try common npm global paths first
    const commonPaths = platform === "win32" ? [
      `${process.env.APPDATA}\\npm\\opencode.cmd`,
      `${process.env.LOCALAPPDATA}\\Programs\\opencode\\opencode.exe`,
      `C:\\Users\\${process.env.USERNAME}\\AppData\\Roaming\\npm\\opencode.cmd`,
      `C:\\Program Files\\nodejs\\opencode.cmd`,
      `C:\\Program Files\\opencode\\opencode.exe`,
    ] : [
      `${process.env.HOME}/.npm-global/bin/opencode`,
      `${process.env.HOME}/.local/bin/opencode`,
      `/usr/local/bin/opencode`,
      `/usr/bin/opencode`,
      `/opt/homebrew/bin/opencode`,
    ];

    for (const testPath of commonPaths) {
      if (testPath && await this.fileExists(testPath)) {
        console.log(`[OpenCodeService] Found opencode at common path: ${testPath}`);
        return testPath;
      }
    }

    const commands: string[] = [];

    if (platform === "win32") {
      commands.push(
        "where opencode",
        "cmd /c where opencode"
      );
    } else {
      commands.push(
        "which opencode",
        "command -v opencode"
      );
    }

    for (const cmd of commands) {
      console.log(`[OpenCodeService] Trying detection command: ${cmd}`);
      try {
        const result = await new Promise<string>((resolve, reject) => {
          exec(cmd, { timeout: 5000 }, (error, stdout, _stderr) => {
            if (error) {
              console.log(`[OpenCodeService] Command failed: ${cmd} - ${error.message}`);
              reject(error);
            } else {
              resolve(stdout.trim());
            }
          });
        });

        if (result && result.length > 0 && !result.includes("not found") && !result.includes("Could not find")) {
          let detectedPath = result.split("\n")[0].trim();

          // On Windows, check for proper executable extension
          if (platform === "win32" && !detectedPath.match(/\.(exe|cmd|bat)$/i)) {
            const extensions = [".cmd", ".exe", ".bat"];
            for (const ext of extensions) {
              const testPath = detectedPath + ext;
              if (await this.fileExists(testPath)) {
                detectedPath = testPath;
                break;
              }
            }
          }

          console.log(`[OpenCodeService] Auto-detected opencode at: ${detectedPath}`);
          return detectedPath;
        }
      } catch {
        // Try next command
      }
    }

    console.log("[OpenCodeService] Could not auto-detect opencode path");
    return null;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const fs = await import("fs");
      fs.accessSync(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Save a turn to debug file */
  private async saveDebugTurn(conversationId: string, turn: DebugTurn): Promise<void> {
    if (!this.debugEnabled || !this.app) return;

    try {
      const vault = this.app.vault;
      const filePath = `${this.DEBUG_SESSIONS_PATH}/${conversationId}.jsonl`;
      const line = `${JSON.stringify(turn)}\n`;

      await this.ensureDebugFolder();
      if (await vault.adapter.exists(filePath)) {
        await vault.adapter.append(filePath, line);
      } else {
        await vault.adapter.write(filePath, line);
      }

      console.log(`[OpenCodeService] Debug turn saved to ${filePath}`);
    } catch (error) {
      console.error("[OpenCodeService] Failed to save debug turn:", error);
    }
  }

  private async ensureDebugFolder(): Promise<void> {
    if (!this.app) return;

    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.DEBUG_SESSIONS_PATH)) return;

      const parts = this.DEBUG_SESSIONS_PATH.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) {
          await adapter.mkdir(current);
        }
      }
    } catch (error) {
      console.error("[OpenCodeService] Failed to ensure debug folder:", error);
    }
  }


  /**
   * Create a client with Node.js http module to bypass CORS consistently
   */
  private createClient(baseUrl: string, directory?: string | null): OpencodeClient {
    // Ensure baseUrl doesn't have trailing slash
    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

    return createOpencodeClient({
      baseUrl: normalizedBaseUrl,
      directory: directory ?? undefined,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        // Handle different input types
        let url: string;
        let method: string;
        let headers: Record<string, string>;
        let body: string | undefined;

        if (input instanceof Request) {
          // Input is a Request object
          url = input.url;
          method = input.method;
          headers = {};
          input.headers.forEach((value, key) => {
            headers[key] = value;
          });
          body = init?.body as string | undefined;
          if (!body && input.body) {
            try {
              body = await input.text();
            } catch {
              /* ignore */
            }
          }
        } else {
          // Input is URL or string
          url = input.toString();
          method = init?.method || "GET";
          headers = (init?.headers as Record<string, string>) || {};
          body = init?.body as string | undefined;
        }

        // Ensure URL is absolute
        if (url.startsWith("/")) {
          url = normalizedBaseUrl + url;
        }

        // Simple log for everyday use
        console.log(`[OpenCodeService] Request: ${method} ${url}`);

        // Use Node.js http.request to bypass CORS and avoid requestUrl limitations
        return new Promise<Response>((resolve, reject) => {
          const urlObj = new URL(url);

          // Explicitly set Content-Length to prevent hanging requests
          const requestHeaders: Record<string, string> = { ...headers };
          if (body) {
            requestHeaders["Content-Length"] =
              Buffer.byteLength(body).toString();
          }

          const req = http.request(
            urlObj,
            {
              method,
            headers: requestHeaders,
            timeout: 10000, // 10s timeout
          },
            (res) => {
              console.log(
                `[OpenCodeService] Response received: ${res.statusCode}`
              );
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              res.on("end", () => {
                const buffer = Buffer.concat(chunks);
                const responseText = buffer.toString("utf-8");

                // Handle null body status codes (204, 205, 304)
                const statusCode = res.statusCode || 200;
                const isNullBodyStatus = statusCode === 204 || statusCode === 205 || statusCode === 304;

                // Construct a standard Response object
                const response = new Response(isNullBodyStatus ? null : responseText, {
                  status: statusCode,
                  statusText: res.statusMessage || "",
                  headers: res.headers as any,
                });

                resolve(response);
              });
            }
          );

          req.on("timeout", () => {
            req.destroy();
            reject(new Error(`Request timed out: ${method} ${url}`));
          });

          req.on("error", (err) => {
            console.error(`[OpenCodeService] Request failed:`, err);
            reject(err);
          });

          if (body) {
            req.write(body);
          }
          req.end();
        });
      },
    });
  }

  /**
   * Initialize the OpenCode client and server
   */
  private async init(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const vaultDirectory = this.getVaultBasePath();

    try {
      // Start our own server using a RANDOM port (port 0) so we can control cwd.
      console.log(
        "[OpenCodeService] Starting a new OpenCode server on a random port..."
      );
      const server = await this.startOpencodeServer({
        hostname: "127.0.0.1",
        port: 0,
        timeoutMs: 15000,
        cwd: vaultDirectory ?? undefined,
      });

      // Pass directory to SDK (query param) for SSE + APIs that expect it.
      this.client = this.createClient(server.url, vaultDirectory);
      this.serverUrl = server.url;
      this.serverClose = () => server.close();

      console.log(
        `[OpenCodeService] OpenCode server started successfully at ${server.url}`
      );
    } catch (error) {
      console.error("[OpenCodeService] Failed to start local server:", error);
      this.initPromise = null;
      throw error;
    }
  }

  private getVaultBasePath(): string | null {
    try {
      const adapter: any = this.app?.vault?.adapter;
      if (adapter && typeof adapter.getBasePath === "function") {
        const basePath = adapter.getBasePath();
        return typeof basePath === "string" && basePath.trim()
          ? basePath.trim()
          : null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private async startOpencodeServer(options: {
    hostname: string;
    port: number;
    timeoutMs: number;
    cwd?: string;
  }): Promise<{ url: string; close(): void }> {
    const args = [
      "serve",
      `--hostname=${options.hostname}`,
      `--port=${options.port}`,
    ];

    let opencodeCmd = this.opencodePath || "opencode";

    // Try auto-detect if using default command
    if (opencodeCmd === "opencode") {
      console.log("[OpenCodeService] Path not set, trying auto-detection...");
      const detected = await this.detectOpencodePath();
      if (detected) {
        opencodeCmd = detected;
        this.opencodePath = detected;
        console.log(`[OpenCodeService] Using auto-detected path: ${opencodeCmd}`);
      }
    }

    console.log(`[OpenCodeService] Spawning OpenCode CLI: ${opencodeCmd} ${args.join(" ")}`);

    const isCmdFile = process.platform === "win32" && opencodeCmd.match(/\.(cmd|bat|ps1)$/i);
    const proc = spawn(opencodeCmd, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
      },
      shell: isCmdFile ? true : false,
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for OpenCode server to start after ${options.timeoutMs}ms`
          )
        );
      }, options.timeoutMs);

      let output = "";

      const onData = (chunk: any) => {
        const text = chunk?.toString?.() ?? "";
        output += text;
        console.log(`[OpenCodeService] Server output: ${text.trim()}`);
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.startsWith("opencode server listening")) {
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (!match) continue;
            clearTimeout(timeoutId);
            resolve(match[1]);
            return;
          }
        }
      };

      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      proc.on("exit", (code) => {
        clearTimeout(timeoutId);
        let msg = `OpenCode server exited with code ${code}`;
        if (output.trim()) msg += `\nServer output: ${output}`;
        reject(new Error(msg));
      });

      proc.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });

    return {
      url,
      close() {
        proc.kill();
      },
    };
  }

  /**
   * Set the server URL (for manual connection)
   */
  setServerUrl(url: string): void {
    this.serverUrl = url;
    this.client = null;
    this.initPromise = null;
  }

  /**
   * Check if OpenCode is available (will start server if needed)
   */
  async isServerAvailable(): Promise<boolean> {
    try {
      await this.init();
      return this.client !== null;
    } catch {
      return false;
    }
  }

  /**
   * Create or get a session
   */
  private async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    await this.init();

    if (!this.client) {
      throw new Error("OpenCode client not initialized");
    }

    try {
      const session = await this.client.session.create({
        title: `Obsidian - ${new Date().toLocaleString()}`,
        permission: this.sessionPermissionMode === "safe"
          ? [
              {
                permission: "*",
                action: "ask",
                pattern: "*",
              },
            ]
          : [
              {
                permission: "*",
                action: "allow",
                pattern: "*",
              },
            ],
        directory: this.getVaultBasePath() ?? undefined,
      });

      if (session.data?.id) {
        this.sessionId = session.data.id;
        return this.sessionId;
      }
      throw new Error("Failed to create session");
    } catch (error) {
      throw new Error(
        `Failed to create session: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Subscribe to global events via SSE
   */
  private async streamEvents(abortSignal: AbortSignal): Promise<AsyncGenerator<BusEvent>> {
    const urlObj = new URL(`${this.serverUrl}/event`);
    const vaultDirectory = this.getVaultBasePath();
    if (vaultDirectory) {
      urlObj.searchParams.set("directory", vaultDirectory);
    }

    return (async function* () {
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          const req = http.request(
            urlObj,
            {
              method: "GET",
              headers: {
                Accept: "text/event-stream",
                "Cache-Control": "no-cache",
              },
            },
            (res) => {
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Event stream returned ${res.statusCode}`));
                return;
              }
              resolve(res);
            }
          );
          req.on("error", reject);
          abortSignal.addEventListener("abort", () => req.destroy());
          req.end();
        }
      );

      const rl = readline.createInterface({
        input: response,
        terminal: false,
      });

      let currentData = "";

      for await (const line of rl) {
        if (abortSignal.aborted) {
          break;
        }
        const trimmed = line.trim();
        if (!trimmed) {
          if (currentData) {
            try {
              const parsed = JSON.parse(currentData) as BusEvent;
              if (parsed && typeof parsed.type === "string") {
                yield parsed;
              }
            } catch {
              // Ignore parse errors
            }
            currentData = "";
          }
          continue;
        }

        if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        }
      }
      
    })();
  }

  /**
   * Send a query to OpenCode and stream the response
   */
  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    this.abortController = new AbortController();
    const previousPermissionMode = this.sessionPermissionMode;
    if (queryOptions?.permissionMode) {
      this.sessionPermissionMode = queryOptions.permissionMode;
    }
    let sessionId: string;
    try {
      sessionId = await this.ensureSession();
    } finally {
      this.sessionPermissionMode = previousPermissionMode;
    }
    const abortSignal = this.abortController.signal;
    
    let emittedAssistantContent = false;

    // Debug: collect all events for this turn
    const debugEvents: unknown[] = [];
    const debugStart = Date.now();
    const debugMeta: Record<string, unknown> = {
      serverUrl: this.serverUrl,
      sessionId,
    };
    let promptStatus: number | null = null;
    let promptError: string | null = null;
    const firstEventType: string | null = null;


    await this.ensureEventStream();
    const eventStream = this.createEventIterator(
      abortSignal,
      (event) => this.isSessionEvent(event, sessionId),
    );



    // Build request body
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; url: string; filename: string; mime: string }
    > = [];

    const vaultPath = this.getVaultBasePath();
    const ensureAbsolute = (input: string): string => {
      if (!vaultPath || path.isAbsolute(input)) {
        return input;
      }
      return path.join(vaultPath, input);
    };

    const normalizeForUrl = (input: string): string => {
      const normalized = ensureAbsolute(input);
      return path.normalize(normalized);
    };

    const addFilePart = (filePath: string, isFolder: boolean): void => {
      const resolvedPath = normalizeForUrl(filePath);
      const url = pathToFileURL(resolvedPath).toString();
      const filename = path.basename(resolvedPath) || resolvedPath;
      parts.push({
        type: "file",
        url,
        filename,
        mime: isFolder ? "application/x-directory" : "text/plain",
      });
    };

    if (queryOptions?.mentionContexts && queryOptions.mentionContexts.length > 0) {
      for (const ctx of queryOptions.mentionContexts) {
        addFilePart(ctx.path, ctx.isFolder);
      }
    } else if (queryOptions?.mentions && queryOptions.mentions.length > 0) {
      for (const mention of queryOptions.mentions) {
        addFilePart(mention, false);
      }
    }

    parts.push({ type: "text", text: prompt });


    let modelConfig = undefined;
    if (queryOptions?.model) {
      const [providerID, ...rest] = queryOptions.model.split("/");
      if (providerID && rest.length > 0) {
        modelConfig = { providerID, modelID: rest.join("/") };
      }
      if (!modelConfig) {
        modelConfig = { providerID: "default", modelID: queryOptions.model };
      }
    }

    debugMeta.model = modelConfig ?? null;
    debugMeta.conversationId = queryOptions?.conversationId ?? null;
    debugMeta.allowedTools = queryOptions?.allowedTools ?? [];
    debugMeta.mentionCount = queryOptions?.mentions?.length ?? 0;
    debugMeta.mentionContextCount = queryOptions?.mentionContexts?.length ?? 0;
    debugMeta.filePartCount = parts.filter((part) => part.type === "file").length;


    const promptPromise = (async () => {
      if (!this.client) {
        throw new Error("OpenCode client not initialized");
      }
      try {
        await this.client.session.promptAsync({
          sessionID: sessionId,
          directory: this.getVaultBasePath() ?? undefined,
          ...(modelConfig && { model: modelConfig }),
          tools: queryOptions?.allowedTools
            ? Object.fromEntries(queryOptions.allowedTools.map((tool) => [tool, true]))
            : undefined,
          parts: parts as any,
        });
        promptStatus = 204;
      } catch (error) {
        promptError = error instanceof Error ? error.message : String(error);
        if (this.abortController && !this.abortController.signal.aborted) {
          const reason =
            error instanceof Error ? error : new Error(promptError || "Unknown error");
          this.abortController.abort(reason);
        }
        throw error;
      }
    })();


    try {
      // If the prompt request itself fails, surface it in the error handler below.
      promptPromise.catch((err) => {
        console.error("[OpenCode] Prompt error:", err);
      });

       // Track seen tool calls to avoid duplicates
       const completedTools = new Set<string>();
       let isSessionIdle = false;

      for await (const event of eventStream) {
        // Check for abort signal with detailed logging
        if (abortSignal.aborted) {
          console.log("[OpenCodeService] Query aborted", { 
            hasReason: !!abortSignal.reason, 
            reasonType: abortSignal.reason?.constructor?.name 
          });
           // If we have a specific abort reason (like TimeoutError), throw it to be caught below
           if (abortSignal.reason instanceof Error) {
             throw abortSignal.reason;
           }
           // Otherwise it's a manual cancellation
           throw new UserCancellationError();
        }

        // Collect event for debug
        debugEvents.push(event);

        // Session idle means we're done
        if (event.type === "session.idle") {
          isSessionIdle = true;
          break;
        }

        if (event.type === "permission.asked") {
          const permission = event.properties as
            | {
                id: string;
                sessionID: string;
                permission: string;
                patterns: string[];
                always: string[];
                metadata?: Record<string, unknown>;
              }
            | undefined;
          if (!permission) {
            continue;
          }
          yield {
            type: "permission_request",
            request: permission,
          };
          continue;
        }

        if (event.type === "message.part.updated") {
          const eventProps = event.properties ?? {};
          const part = eventProps.part as Record<string, unknown> | undefined;
          const delta = eventProps.delta as string | undefined;
          if (!part) continue;

          // Handle streaming text deltas
          if (part.type === "text") {
            if (delta) {
              emittedAssistantContent = true;
              yield { type: "text", content: delta };
            } else if (part.text) {
              // Fallback: if no delta, try to diff or just yield full text if it's a new chunk
              // Since we don't track previous length per part here easily without a map,
              // let's trust delta is provided for streaming.
              // If not, we might be yielding full text repeatedly.
              // Let's add a debug log to verify structure
              // console.log("Text part update:", part.text.length, delta);
            }
          }
          // Handle reasoning (thinking)
          else if (part.type === "reasoning") {
            if (delta) {
              yield { type: "thinking", content: delta };
            }
          }
          // Handle tool use
          else if (part.type === "tool") {
            const state = (part.state ?? {}) as Record<string, unknown>;
            const toolUseId = part.id as string | undefined;
            if (!toolUseId) continue;

            const input = (state.input || {}) as Record<string, unknown>;
            const hasNonEmptyInput =
              !!input &&
              typeof input === "object" &&
              Object.keys(input).length > 0;
            const status = state.status as string | undefined;

            if (status === "running" || status === "pending") {
              // OpenCode sometimes emits an initial `pending` tool update with empty input `{}`.
              // Emitting it creates a duplicate UI block that never gets completed.
              if (status === "pending" && !hasNonEmptyInput) {
                continue;
              }
              emittedAssistantContent = true;
              yield {
                type: "tool_use",
                toolName: (part.tool as string) || "tool",
                input,
                toolUseId,
              };
            } else if (status === "completed" && !completedTools.has(toolUseId)) {
              completedTools.add(toolUseId);
              emittedAssistantContent = true;
              const output = state.output as unknown;
              let outputText = "";
              let attachments: ToolAttachment[] | undefined;
              if (typeof output === "string") {
                outputText = output;
              } else if (output && typeof output === "object") {
                const outputObject = output as {
                  text?: string;
                  attachments?: ToolAttachment[];
                };
                outputText = outputObject.text ?? "";
                attachments = outputObject.attachments;
              }
              yield {
                type: "tool_result",
                toolUseId,
                result: outputText,
                attachments,
              };
            } else if (status === "error" && !completedTools.has(toolUseId)) {
              completedTools.add(toolUseId);
              emittedAssistantContent = true;
              yield {
                type: "tool_result",
                toolUseId,
                result: `Error: ${state.error as string}`,
              };
            }
          }
        }


        if (event.type === "session.error") {
          emittedAssistantContent = true;
          const error = event.properties?.error as
            | { name?: string; data?: { message?: string } }
            | undefined;
          const errorMessage =
            error?.data?.message ||
            error?.name ||
            "Session error";
          yield {
            type: "error",
            content: errorMessage,
          };
        }


        if (event.type === "message.updated") {
          const info = event.properties?.info as Record<string, unknown> | undefined;
          if (info?.id && info?.role) {
            yield {
              type: "server_message",
              role: info.role as "user" | "assistant",
              messageId: info.id as string,
            };
          }
        }
      }


        if (!isSessionIdle) {
          const errorMsg = "Stream ended before session.idle";
          console.warn(`[OpenCodeService] ${errorMsg}`);
          debugEvents.push({ type: "warning", message: errorMsg });
        }


      await promptPromise;

      if (!emittedAssistantContent) {
        debugEvents.push({
          type: "warning",
          message: "No assistant content emitted before done",
        });
      }

      // Save debug turn
      await this.saveDebugTurn(queryOptions?.conversationId ?? sessionId, {
        timestamp: new Date().toISOString(),
        userPrompt: prompt,
        events: debugEvents,
        meta: {
          ...debugMeta,
          durationMs: Date.now() - debugStart,
          firstEventType,
          promptStatus,
          promptError,
          emittedAssistantContent,
          result: "ok",
        },
      });



      yield { type: "done" };


    } catch (error) {
      console.error("[OpenCodeService] Query error:", {
        errorType: error?.constructor?.name,
        message: error instanceof Error ? error.message : String(error),
        isUserCancellation: error instanceof UserCancellationError,
      });
      
      // Handle known error types
      if (error instanceof UserCancellationError) {
        console.log("[OpenCodeService] User cancelled - ending gracefully");
        yield { type: "done" }; // Graceful exit
        return;
      }


      let finalError: OpencodianError;
      
      if (error instanceof OpencodianError) {
        finalError = error;
      } else {
        // Map native errors to OpencodianErrors with user-friendly messages
        const msg = String(error);
        const errMsg = error instanceof Error ? error.message : msg;
        
        const msgLower = msg.toLowerCase();
        if (msgLower.includes("rate limit") || msgLower.includes("429")) {
          finalError = new ServerError(429, "Rate limit exceeded. Please try again later.");
        } else if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
          finalError = new NetworkError(new Error("Cannot connect to OpenCode server"));
        } else if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
          finalError = new NetworkError(new Error("Connection timed out"));
        } else if (msg.includes("aborted")) {
          finalError = new ServerError(499, "Request aborted");
        } else if (msg.includes("Network") || msg.includes("Connection closed")) {
          finalError = new NetworkError(new Error("Network connection lost"));
        } else {
           // Default to generic server/unknown error
           finalError = new ServerError(500, errMsg || "Unknown error");
        }
      }
      
      console.error("[OpenCodeService] Yielding error to UI:", finalError.message);
      
       if (!emittedAssistantContent) {
         debugEvents.push({
           type: "warning",
           message: "No assistant content emitted before error",
         });
       }

      // Save debug turn even on error
      await this.saveDebugTurn(queryOptions?.conversationId ?? sessionId, {
        timestamp: new Date().toISOString(),
        userPrompt: prompt,
        events: [...debugEvents, { type: "error", error: finalError.message }],
        meta: {
          ...debugMeta,
          durationMs: Date.now() - debugStart,
          firstEventType,
          promptStatus,
          promptError,
          emittedAssistantContent,
          result: "error",
          errorType: finalError.constructor.name,
        },
      });


      
      yield {
        type: "error",
        content: finalError.message,
      };
      yield { type: "done" };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Cancel the current query
   */
  async cancel(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort(new UserCancellationError());
    }
  }

  private emitEvent(event: BusEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private async ensureEventStream(): Promise<void> {
    await this.init();
    if (this.eventStarted) return;
    this.eventStarted = true;

    const abort = new AbortController();
    this.eventAbort = abort;
    const signal = abort.signal;

    (async () => {
      while (!signal.aborted) {
        const stream = this.streamEvents(signal).catch(() => null);
        const events = await stream;
        if (!events) {
          await this.sleep(250);
          continue;
        }

        for await (const event of events) {
          this.emitEvent(event);
        }

        if (!signal.aborted) {
          await this.sleep(250);
        }
      }
    })().catch((error) => {
      console.error("[OpenCodeService] Event stream error:", error);
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private createEventIterator(
    abortSignal: AbortSignal,
    filter?: (event: BusEvent) => boolean,
  ): AsyncGenerator<BusEvent> {
    const queue: BusEvent[] = [];
    let resolveNext: ((value: IteratorResult<BusEvent>) => void) | null = null;

    const onEvent = (event: BusEvent) => {
      if (filter && !filter(event)) return;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
        return;
      }
      queue.push(event);
    };

    this.eventListeners.add(onEvent);

    const waitForNext = () =>
      new Promise<IteratorResult<BusEvent>>((resolve) => {
        resolveNext = resolve;
      });

    const waitForAbort = () =>
      new Promise<IteratorResult<BusEvent>>((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => resolve({ value: undefined as unknown as BusEvent, done: true }),
          { once: true },
        );
      });

    return (async function* () {
      try {
        while (true) {
          if (abortSignal.aborted) return;
          if (queue.length > 0) {
            yield queue.shift() as BusEvent;
            continue;
          }

          const next = await Promise.race([waitForNext(), waitForAbort()]);
          if (next.done) return;
          yield next.value;
        }
      } finally {
        this.eventListeners.delete(onEvent);
      }
    }).call(this);
  }

  private isSessionEvent(event: BusEvent, sessionId: string): boolean {
    const props = event.properties ?? {};
    if (event.type === "session.updated") {
      const info = props.info as Record<string, unknown> | undefined;
      return info?.id === sessionId;
    }
    if (event.type === "message.updated") {
      const info = props.info as Record<string, unknown> | undefined;
      return info?.sessionID === sessionId;
    }
    if (event.type === "message.part.updated") {
      const part = props.part as Record<string, unknown> | undefined;
      return part?.sessionID === sessionId;
    }
    if (event.type === "permission.asked") {
      return props.sessionID === sessionId;
    }
    if (event.type === "session.status") {
      return props.sessionID === sessionId;
    }
    if (event.type === "session.idle") {
      return props.sessionID === sessionId;
    }
    if (event.type === "session.error") {
      return props.sessionID === sessionId;
    }
    return false;
  }

  async ensureSessionId(permissionMode?: "yolo" | "safe"): Promise<string> {
    if (permissionMode) {
      this.sessionPermissionMode = permissionMode;
    }
    return this.ensureSession();
  }

  async revertSessionMessage(messageId: string): Promise<void> {
    if (!this.client) {
      await this.init();
    }

    if (!this.client) {
      throw new Error("OpenCode client not initialized");
    }

    const sessionId = await this.ensureSession();
    await this.client.session.revert({
      sessionID: sessionId,
      directory: this.getVaultBasePath() ?? undefined,
      messageID: messageId,
    });
  }

  async replyToPermission(requestId: string, response: "once" | "always" | "reject"): Promise<void> {
    if (!this.client) {
      await this.init();
    }

    if (!this.client) {
      throw new Error("OpenCode client not initialized");
    }

    await this.client.permission.reply({
      requestID: requestId,
      reply: response,
      directory: this.getVaultBasePath() ?? undefined,
    });
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  resetSession(): void {
    this.sessionId = null;
  }


  cleanup(): void {
    this.cancel();
    this.resetSession();
    if (this.eventAbort) {
      this.eventAbort.abort();
      this.eventAbort = null;
    }
    this.eventStarted = false;
    if (this.serverClose) {
      this.serverClose();
      this.serverClose = null;
    }
    this.client = null;
    this.initPromise = null;
  }

  private log(message: string, ...args: any[]): void {
    console.log(`[OpenCodeService] ${message}`, ...args);
  }

  /**
   * Get user-configured providers and models from OpenCode server
   * Uses GET /config/providers endpoint (only returns connected/configured providers)
   */
  async getProviders(): Promise<ConfigProvidersResponse> {
    await this.init();

    if (!this.client) {
      throw new Error("OpenCode client not initialized");
    }

    return new Promise<ConfigProvidersResponse>((resolve, reject) => {
      const urlObj = new URL(`${this.serverUrl}/config/providers`);
      console.log(`[OpenCodeService] Fetching providers from: ${urlObj.toString()}`);

      const req = http.request(
        urlObj,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const responseText = buffer.toString("utf-8");
            console.log(`[OpenCodeService] Providers response (${res.statusCode}):`, responseText);

            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Failed to fetch providers: ${res.statusCode}`));
              return;
            }

            try {
              const data = JSON.parse(responseText) as ConfigProvidersResponse;
              console.log(`[OpenCodeService] Parsed providers:`, JSON.stringify(data, null, 2));
              resolve(data);
            } catch {
              reject(new Error("Failed to parse provider response"));
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out while fetching providers"));
      });

      req.on("error", (err) => {
        console.error("[OpenCodeService] Failed to fetch providers:", err);
        reject(err);
      });

      req.end();
    });
  }
}
