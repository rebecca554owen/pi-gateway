/**
 * Slash command registry for pi-gateway.
 *
 * Centralized command definitions + dispatch. New commands just need
 * a single CommandDef entry — the registry drives:
 *   - Incoming message matching
 *   - Telegram bot menu (setMyCommands on startup)
 *   - /help output
 */

import type { PlatformMessage } from "./adapters/index.js";

/** RPC send signature injected at boot */
export type RpcSender = (
	command: string,
	data?: Record<string, unknown>,
) => Promise<unknown>;

/** Context passed into every command handler */
export interface CommandContext {
	message: PlatformMessage;
	rpcSend: RpcSender;
	isAdmin: boolean;
	sendReply: (text: string) => Promise<void>;
	logger: {
		info: (msg: string) => void;
		error: (msg: string, err?: unknown) => void;
	};
}

/** Handler receives parsed args + context */
export type CommandHandler = (
	args: string,
	ctx: CommandContext,
) => Promise<void>;

/** Role required to execute the command */
export type CommandRole = "any" | "admin";

/** Single command definition */
export interface CommandDef {
	name: string;
	aliases?: string[];
	description: string;
	role: CommandRole;
	/** Handler — if omitted, the command just shows help text */
	handler?: CommandHandler;
	/** Whether this command needs the pi RPC agent (default: true) */
	requiresAgent?: boolean;
}

// ── Registry ────────────────────────────────────────────────

const registry: CommandDef[] = [];

export function registerCommand(cmd: CommandDef): void {
	registry.push(cmd);
}

export function getCommands(): ReadonlyArray<CommandDef> {
	return registry;
}

/**
 * Match an incoming message against the registry.
 * Returns the matched CommandDef + extracted args, or null.
 */
export function matchCommand(
	text: string,
): { cmd: CommandDef; args: string } | null {
	const trimmed = text.trim();

	for (const cmd of registry) {
		// Check primary name
		const match = matchesName(trimmed, cmd.name);
		if (match !== null) return { cmd, args: match };

		// Check aliases
		if (cmd.aliases) {
			for (const alias of cmd.aliases) {
				const aliasMatch = matchesName(trimmed, alias);
				if (aliasMatch !== null)
					return { cmd, args: aliasMatch };
			}
		}
	}
	return null;
}

function matchesName(
	text: string,
	name: string,
): string | null {
	const prefix = "/" + name.toLowerCase();
	const lower = text.toLowerCase();

	if (lower === prefix) return ""; // exact match, no args
	if (lower.startsWith(prefix + " ") || lower.startsWith(prefix + "@")) {
		return text.slice(prefix.length + 1).trim();
	}
	return null;
}

/**
 * Generate the Telegram BotCommand[] array for setMyCommands.
 */
export function buildTelegramCommands(): Array<{
	command: string;
	description: string;
}> {
	return registry.map((cmd) => ({
		command: cmd.name,
		description: cmd.description.slice(0, 128), // Telegram cap (256 chars total, but 128 is safe)
	}));
}

/**
 * Build a /help text string.
 */
export function buildHelpText(): string {
	const lines = registry.map(
		(cmd) => {
			const names = cmd.aliases
				? `/${cmd.name} (${cmd.aliases.map((a) => `/${a}`).join(", ")})`
				: `/${cmd.name}`;
			return `${names} — ${cmd.description}`;
		},
	);
	return "Available commands:\n\n" + lines.join("\n");
}

// ── Built-in Command Handlers ──────────────────────────────

export function registerBuiltinCommands(): void {
	registerCommand({
		name: "help",
		requiresAgent: false,
		aliases: ["commands"],
		description: "Show available commands",
		role: "any",
		handler: async (_args, ctx) => {
			await ctx.sendReply(buildHelpText());
		},
	});

	registerCommand({
		name: "model",
		description: "List or switch AI models",
		role: "any",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			// /model (no args) or /model list
			if (!trimmed || trimmed === "list") {
				await handleModelList(ctx);
				return;
			}

			// /model provider/id
			if (!ctx.isAdmin) {
				await ctx.sendReply(
					"Only admins can switch models. Use `/model` to see available models.",
				);
				return;
			}

			const slashIdx = trimmed.indexOf("/");
			if (slashIdx === -1) {
				await ctx.sendReply(
					"Usage: `/model provider/modelId`\n`/model` to see available models.",
				);
				return;
			}

			const provider = trimmed.slice(0, slashIdx);
			const modelId = trimmed.slice(slashIdx + 1);
			if (!provider || !modelId) {
				await ctx.sendReply("Invalid format. Use `provider/modelId`.");
				return;
			}

			try {
				const result = (await ctx.rpcSend("set_model", {
					provider,
					modelId,
				})) as {
					success: boolean;
					error?: string;
					data?: { name: string };
				};
				if (result.success) {
					const name = result.data?.name || `${provider}/${modelId}`;
					await ctx.sendReply(`✅ Model changed to ${name}`);
					ctx.logger.info(
						`Admin switched model to ${provider}/${modelId}`,
					);
				} else {
					await ctx.sendReply(
						`❌ Failed: ${result.error || "unknown"}`,
					);
				}
			} catch (err) {
				ctx.logger.error("Model switch failed", err);
				await ctx.sendReply("❌ Failed to switch model.");
			}
		},
	});

	registerCommand({
		name: "restart",
		description: "Restart the AI agent",
		role: "admin",
		handler: async (_args, ctx) => {
			await ctx.sendReply("Restarting agent... (handled externally)");
		},
	});

	registerCommand({
		name: "status",
		description: "Show gateway and agent status",
		role: "any",
		handler: async (_args, ctx) => {
			try {
				const state = (await ctx.rpcSend("get_state")) as any;
				if (state?.success && state?.data) {
					const s = state.data;
					await ctx.sendReply(
						`Model: ${s.model || "?"}\n` +
							`Streaming: ${s.isStreaming ? "yes" : "no"}\n` +
							`Thinking: ${s.thinkingLevel || "?"}\n` +
							`Messages: ${s.messageCount}\n` +
							`Session: ${s.sessionName || s.sessionId || "?"}`,
					);
				} else {
					await ctx.sendReply("Agent status unavailable.");
				}
			} catch {
				await ctx.sendReply("Failed to get agent status.");
			}
		},
	});

	registerCommand({
		name: "new",
		aliases: ["reset"],
		description: "Start a new session",
		role: "any",
		handler: async (_args, ctx) => {
			try {
				const result = (await ctx.rpcSend("new_session")) as {
					success: boolean;
					cancelled?: boolean;
				};
				if (result?.success) {
					await ctx.sendReply("✅ New session started.");
				} else {
					await ctx.sendReply("New session started.");
				}
			} catch {
				await ctx.sendReply("New session started.");
			}
		},
	});

	registerCommand({
		name: "thinking",
		aliases: ["reasoning"],
		description: "Set or cycle thinking level (off/low/medium/high)",
		role: "any",
		handler: async (args, ctx) => {
			const level = args.trim().toLowerCase();
			try {
				if (!level) {
					// Cycle thinking level
					const result = (await ctx.rpcSend(
						"cycle_thinking_level",
					)) as {
						success: boolean;
						data?: { level: string };
					};
					if (result?.success && result.data) {
						await ctx.sendReply(
							`Thinking level: ${result.data.level}`,
						);
					}
					return;
				}

				const result = (await ctx.rpcSend("set_thinking_level", {
					level,
				})) as { success: boolean; error?: string };
				if (result?.success) {
					await ctx.sendReply(`✅ Thinking level: ${level}`);
				} else {
					await ctx.sendReply(
						`❌ ${result?.error || "Invalid level. Use: off, low, medium, high"}`,
					);
				}
			} catch {
				await ctx.sendReply("Failed to change thinking level.");
			}
		},
	});

	registerCommand({
		name: "cycle",
		aliases: ["next"],
		description: "Cycle to next available model",
		role: "admin",
		handler: async (_args, ctx) => {
			try {
				const result = (await ctx.rpcSend("cycle_model")) as {
					success: boolean;
					data?: { name: string; provider: string; id: string } | null;
				};
				if (result?.success && result.data) {
					await ctx.sendReply(
						`✅ Switched to ${result.data.provider}/${result.data.id}`,
					);
				} else {
					await ctx.sendReply("No more models to cycle.");
				}
			} catch {
				await ctx.sendReply("Failed to cycle model.");
			}
		},
	});

	registerCommand({
		name: "abort",
		description: "Abort the current agent response",
		role: "any",
		handler: async (_args, ctx) => {
			try {
				await ctx.rpcSend("abort");
				await ctx.sendReply("⏹ Aborted.");
			} catch {
				await ctx.sendReply("Failed to abort.");
			}
		},
	});

	registerCommand({
		name: "compact",
		description: "Compact conversation context",
		role: "any",
		handler: async (_args, ctx) => {
			try {
				const result = (await ctx.rpcSend("compact")) as {
					success: boolean;
					data?: { compacted: boolean };
				};
				if (result?.success && result.data?.compacted) {
					await ctx.sendReply("✅ Context compacted.");
				} else {
					await ctx.sendReply("Compaction not needed.");
				}
			} catch {
				await ctx.sendReply("Failed to compact.");
			}
		},
	});

	registerCommand({
		name: "stats",
		description: "Show session token/message stats",
		role: "any",
		handler: async (_args, ctx) => {
			try {
				const result = (await ctx.rpcSend("get_session_stats")) as {
					success: boolean;
					data?: {
						messageCount: number;
						tokenCount: number;
						contextWindowSize: number;
						toolCallCount: number;
					};
				};
				if (result?.success && result.data) {
					const s = result.data;
					await ctx.sendReply(
						`Messages: ${s.messageCount}\n` +
							`Tokens: ${s.tokenCount}\n` +
							`Context window: ${s.contextWindowSize}\n` +
							`Tool calls: ${s.toolCallCount}`,
					);
				} else {
					await ctx.sendReply("Stats unavailable.");
				}
			} catch {
				await ctx.sendReply("Failed to get stats.");
			}
		},
	});
}

// ── Model list helper (inline keyboard) ──────────────────

async function handleModelList(ctx: CommandContext): Promise<void> {
	try {
		const result = (await ctx.rpcSend("get_available_models")) as {
			success: boolean;
			data?: {
				models: Array<{
					provider: string;
					id: string;
					name: string;
				}>;
			};
		};
		if (!result.success || !result.data?.models?.length) {
			await ctx.sendReply("No models available.");
			return;
		}

		const list = result.data.models
			.map(
				(m) =>
					`${m.name || m.id} (<code>${m.provider}/${m.id}</code>)`,
			)
			.join("\n");

		await ctx.sendReply(
			`Available models:\n${list}\n\nUse <code>/model provider/id</code> to switch.`,
		);
	} catch (err) {
		ctx.logger.error("Failed to list models", err);
		await ctx.sendReply("Failed to list models.");
	}
}
