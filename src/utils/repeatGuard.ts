/**
 * RepeatGuard — 防止弱模型循环调用同一工具烧 token
 *
 * 策略：
 *   1. 只读工具（read_file, list_dir, grep, read_image）：
 *      - 缓存结果，重复调用直接返回缓存 + 注入警告
 *      - 超过 maxRepeats 次后强制拦截，要求模型换个思路
 *
 *   2. 写操作工具（write_file, edit_file, bash, sandbox, worktree, create_pr）：
 *      - 不缓存结果（副作用不可复用），但追踪重复次数
 *      - 超过 maxRepeats 次后拦截
 *
 *   3. subagent：不做去重（每次子任务上下文不同）
 */

// ─── Configuration ──────────────────────────────────────────────────

/** 只读工具：结果可缓存 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep",
  "read_image",
]);

/** 不做去重的工具 */
const SKIP_DEDUP_TOOLS = new Set(["subagent"]);

/** 同一调用允许的最大重复次数（含首次） */
const MAX_REPEATS = parseInt(process.env.DEDUP_MAX_REPEATS || "3", 10);

/** 缓存过期时间（毫秒），默认 3 分钟 */
const CACHE_TTL_MS = parseInt(process.env.DEDUP_CACHE_TTL_MS || "180000", 10);

/** 历史窗口大小：仅保留最近 N 条调用记录 */
const HISTORY_WINDOW = parseInt(process.env.DEDUP_HISTORY_WINDOW || "64", 10);

// ─── Types ──────────────────────────────────────────────────────────

interface CallRecord {
  /** 工具名 + 参数的确定性 key */
  key: string;
  /** 工具名 */
  toolName: string;
  /** 简短的可读参数摘要（用于日志和警告消息） */
  argsSummary: string;
  /** 首次调用时间戳 */
  firstSeen: number;
  /** 最近一次调用时间戳 */
  lastSeen: number;
  /** 累计调用次数 */
  callCount: number;
  /** 缓存的结果（仅只读工具） */
  cachedResult?: string;
}

export interface RepeatCheckResult {
  /** 是否允许执行 */
  allowed: boolean;
  /** 当前是第几次调用 */
  callCount: number;
  /** 缓存的结果（仅只读工具有） */
  cachedResult?: string;
  /** 拦截/警告原因 */
  reason?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * 将参数对象转为确定性的字符串 key。
 * 对 key 排序以确保 {a:1,b:2} 和 {b:2,a:1} 产生相同结果。
 */
function argsToKey(args: Record<string, any>): string {
  const sortedKeys = Object.keys(args).sort();
  const parts = sortedKeys.map((k) => {
    const v = args[k];
    // 对嵌套对象递归排序
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return `${k}:${argsToKey(v)}`;
    }
    return `${k}:${JSON.stringify(v)}`;
  });
  return parts.join("|");
}

/**
 * 生成参数的简短可读摘要，用于日志和警告。
 */
function makeArgsSummary(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    case "read_file":
    case "read_image":
      return args.path || args.image_path || "";
    case "list_dir":
      return args.path || "";
    case "grep":
      return `${args.file_path || ""}:${args.keyword || ""}`;
    case "write_file":
      return args.path || "";
    case "edit_file":
      return `${args.file_path || ""} "${(args.old_string || "").slice(0, 30)}..."`;
    case "bash":
      return (args.command || "").slice(0, 60);
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

// ─── RepeatGuard class ──────────────────────────────────────────────

export class RepeatGuard {
  private history = new Map<string, CallRecord>();
  /** 保持插入顺序，方便淘汰最旧记录 */
  private order: string[] = [];

  /**
   * 检查一次工具调用是否允许执行。
   * 必须在工具实际执行之前调用。
   */
  check(toolName: string, args: Record<string, any>): RepeatCheckResult {
    // 不做去重的工具直接放行
    if (SKIP_DEDUP_TOOLS.has(toolName)) {
      return { allowed: true, callCount: 1 };
    }

    const key = `${toolName}::${argsToKey(args)}`;
    const now = Date.now();
    const isReadOnly = READ_ONLY_TOOLS.has(toolName);
    const record = this.history.get(key);

    // ── 首次调用 ──
    if (!record || now - record.lastSeen > CACHE_TTL_MS) {
      // 过期了也视为首次
      return { allowed: true, callCount: 1 };
    }

    const callCount = record.callCount + 1;
    const argsSummary = record.argsSummary;

    // ── 超过最大重复次数 ──
    if (callCount > MAX_REPEATS) {
      const reason = isReadOnly
        ? `🚫 Repeat guard: you have called ${toolName}(${argsSummary}) ${record.callCount} times already with the same arguments. ` +
          `This suggests you are stuck in a loop. Please:\n` +
          `  1. Re-read the previous tool result carefully — the information is already in context.\n` +
          `  2. Try a different approach or different arguments.\n` +
          `  3. If you are verifying a change, use a different tool (e.g. grep instead of read_file).\n` +
          `  4. If you believe this is correct, summarize what you know and ask the user for guidance.`
        : `🚫 Repeat guard: you have called ${toolName}(${argsSummary}) ${record.callCount} times already. ` +
          `Repeated mutations on the same target usually indicate a loop. ` +
          `Please re-examine the situation and try a different approach.`;

      // 即使拦截，也返回缓存结果供模型参考（避免模型再次尝试）
      return {
        allowed: false,
        callCount,
        cachedResult: record.cachedResult,
        reason,
      };
    }

    // ── 未超限但重复 ──
    if (isReadOnly && record.cachedResult !== undefined) {
      // 只读工具：返回缓存 + 警告
      const warning =
        `⚠️ Repeat guard: ${toolName}(${argsSummary}) was already called ${record.callCount} time(s). ` +
        `Returning cached result. Please review the previous output carefully before calling again.`;
      return {
        allowed: true,
        callCount,
        cachedResult: record.cachedResult,
        reason: warning,
      };
    }

    // 写操作工具：允许但警告
    const warning =
      `⚠️ Repeat guard: you are calling ${toolName}(${argsSummary}) again (this will be call #${callCount}). ` +
      `Make sure this is intentional and not a loop.`;
    return { allowed: true, callCount, reason: warning };
  }

  /**
   * 记录一次工具调用的结果。
   * 必须在工具执行成功之后调用。
   */
  record(
    toolName: string,
    args: Record<string, any>,
    result: string,
  ): void {
    if (SKIP_DEDUP_TOOLS.has(toolName)) return;

    const key = `${toolName}::${argsToKey(args)}`;
    const now = Date.now();
    const isReadOnly = READ_ONLY_TOOLS.has(toolName);
    const existing = this.history.get(key);

    if (existing && now - existing.lastSeen <= CACHE_TTL_MS) {
      // 更新已有记录
      existing.callCount++;
      existing.lastSeen = now;
      if (isReadOnly) {
        existing.cachedResult = result;
      }
    } else {
      // 新建记录
      const record: CallRecord = {
        key,
        toolName,
        argsSummary: makeArgsSummary(toolName, args),
        firstSeen: now,
        lastSeen: now,
        callCount: 1,
        cachedResult: isReadOnly ? result : undefined,
      };
      this.history.set(key, record);
      this.order.push(key);
    }

    // 淘汰超出窗口的旧记录
    this.evict();
  }

  /**
   * 清空所有记录。在 /clear 或新会话时调用。
   */
  clear(): void {
    this.history.clear();
    this.order.length = 0;
  }

  /**
   * 获取当前统计信息（用于 /tokens 或调试）。
   */
  getStats(): { trackedCalls: number; topRepeated: string[] } {
    const entries = [...this.history.values()]
      .filter((r) => r.callCount > 1)
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 5);

    return {
      trackedCalls: this.history.size,
      topRepeated: entries.map(
        (e) => `${e.toolName}(${e.argsSummary}): ${e.callCount}x`,
      ),
    };
  }

  // ── Private ──

  private evict(): void {
    while (this.order.length > HISTORY_WINDOW) {
      const oldestKey = this.order.shift()!;
      const record = this.history.get(oldestKey);
      // 只淘汰过期的记录，未过期但超出窗口的保留
      if (record && Date.now() - record.lastSeen > CACHE_TTL_MS) {
        this.history.delete(oldestKey);
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

/** 全局唯一的 RepeatGuard 实例 */
export const repeatGuard = new RepeatGuard();
