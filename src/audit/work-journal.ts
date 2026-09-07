import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { IncomingMessage } from "../types.js";
import type { RenderEvent } from "../claude/render-event.js";
import type { JournalRemote } from "./github-client.js";

const Status = z.enum(["accepted", "queued", "running", "completed", "cancelled", "failed", "unknown"]);
type Status = z.infer<typeof Status>;
const Action = z.object({ key: z.string(), name: z.string(), detail: z.string(), result: z.enum(["pending", "ok", "error"]) });
const Entry = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), actor: z.string(), instruction: z.string(), cwd: z.string(),
  createdAt: z.string(), updatedAt: z.string(), status: Status, actions: z.array(Action).max(40),
  omittedActions: z.number().int().nonnegative(), report: z.string(), error: z.string(),
  revision: z.number().int().positive(), syncedRevision: z.number().int().nonnegative(),
  createAttempted: z.boolean(), commentId: z.number().int().positive().optional(), url: z.string().optional(),
});
type Entry = z.infer<typeof Entry>;
const Store = z.object({ version: z.literal(1), destination: z.string(), entries: z.array(Entry).max(2000) });
const terminal = (status: Status): boolean => ["completed", "cancelled", "failed", "unknown"].includes(status);
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const labels: Record<Status, string> = {
  accepted: "已接收", queued: "排队中", running: "执行中",
  completed: "本轮执行结束（不代表需求已验收）", cancelled: "已取消", failed: "执行失败", unknown: "结果待核实（桥曾重启）",
};

export interface WorkRun {
  event(event: RenderEvent): void;
  finish(status: "completed" | "cancelled" | "failed", error?: string): void;
  syncNotice(timeoutMs?: number): Promise<string>;
}
export interface WorkJournal {
  begin(message: IncomingMessage, cwd: string): WorkRun | null;
  close(): Promise<void>;
}

/** Optional host-side journal. Never grants GitHub access to the model. */
export class GitHubWorkJournal implements WorkJournal {
  private readonly entries = new Map<string, Entry>();
  // Never persist partial provider text: secrets may span streamed chunks.
  private readonly publicText = new Map<string, { text: string; overflow: boolean }>();
  private pumping: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private scanAfter: string | undefined;
  private readonly redact: (text: string, maxChars?: number) => string;

  constructor(private readonly options: {
    remote: JournalRemote; stateFile: string; destination: string; issueUrl: string;
    actorLabels: Readonly<Record<string, string>>;
    redact: (text: string, maxChars?: number) => string;
    onSyncError?: () => void;
  }) {
    this.redact = options.redact;
    mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 });
    const stateDirectory = lstatSync(dirname(options.stateFile));
    if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink() || (stateDirectory.mode & 0o077) !== 0) {
      throw new Error("Journal directory must be private (0700) and not a symlink");
    }
    if (existsSync(options.stateFile)) {
      if (lstatSync(options.stateFile).isSymbolicLink()) throw new Error("Journal state cannot be a symlink");
      const state = Store.parse(JSON.parse(readFileSync(options.stateFile, "utf8")));
      if (state.destination !== options.destination) throw new Error("Journal destination changed; explicit migration required");
      for (const entry of state.entries) {
        if (this.entries.has(entry.id)) throw new Error("Duplicate journal record");
        if (!terminal(entry.status)) {
          entry.status = "unknown";
          entry.error = "桥进程重启，无法确认上次任务结果；不自动重跑，请核对代码/PR。";
          entry.report = "";
          entry.updatedAt = new Date().toISOString();
          entry.revision++;
        }
        this.entries.set(entry.id, entry);
      }
    }
    this.save();
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, intervalMs);
    this.timer.unref();
    void this.flush();
  }

  begin(message: IncomingMessage, cwd: string): WorkRun | null {
    const actor = this.options.actorLabels[message.senderOpenId];
    if (!actor) throw new Error("Work journal has no verified actor mapping");
    const id = hash(`${message.chatId}\n${message.messageId}`);
    // Durable duplicate detection: never replay an already journaled task.
    if (this.entries.has(id)) return null;
    if (this.entries.size >= 2000) throw new Error("Work journal capacity reached; archive before accepting more work");
    const now = new Date().toISOString();
    const entry: Entry = {
      id, actor: this.redact(actor, 100), instruction: this.redact(message.text, 6000), cwd: this.redact(cwd, 500),
      createdAt: new Date(message.receivedAt).toISOString(), updatedAt: now, status: "accepted",
      actions: [], omittedActions: 0, report: "", error: "", revision: 1, syncedRevision: 0, createAttempted: false,
    };
    this.entries.set(id, entry);
    try { this.save(); } catch (error) { this.entries.delete(id); throw error; }
    this.publicText.set(id, { text: "", overflow: false });
    // The local save above is synchronous: no network window before submit
    // in which /stop can acknowledge and then let a pending task start.
    void this.flush();
    return {
      event: event => this.observe(entry, event),
      finish: (status, error) => {
        if (terminal(entry.status)) return;
        entry.status = status;
        entry.error = error ? this.redact(error, 2000) : "";
        const buffered = this.publicText.get(id);
        entry.report = status === "completed"
          ? buffered?.overflow ? "公开回复超过安全缓冲上限，未上传回复正文；请在 Lark 核对结果。" : this.redact(buffered?.text ?? "", 8000)
          : "";
        this.publicText.delete(id);
        this.touch(entry);
        void this.flush();
      },
      syncNotice: async (timeoutMs = 12_000) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const syncLatest = async (): Promise<void> => {
            await this.flush();
            if (entry.syncedRevision !== entry.revision) await this.flush();
          };
          await Promise.race([syncLatest(), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
        } finally { if (timer) clearTimeout(timer); }
        return entry.syncedRevision === entry.revision && entry.url
          ? `工作记录已同步 GitHub：${entry.url}`
          : `工作记录已保存本机，GitHub 尚待同步（请勿视为已同步）：${this.options.issueUrl}`;
      },
    };
  }

  private observe(entry: Entry, event: RenderEvent): void {
    if (terminal(entry.status)) return;
    if (event.type === "queued") entry.status = "queued";
    else if (event.type === "tool_use") {
      entry.status = "running";
      this.publicText.set(entry.id, { text: "", overflow: false });
      if (entry.actions.length < 40) {
        const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
        const detail = ["file_path", "path"]
          .flatMap(key => typeof input[key] === "string" ? [`${key}: ${input[key]}`] : []).join("\n");
        const hasCommand = typeof input.command === "string" || typeof input.cmd === "string";
        entry.actions.push({ key: hash(event.id), name: this.redact(event.name, 120),
          detail: this.redact([detail, hasCommand ? "Shell 命令已调用；参数/脚本正文不上传，请结合结果报告核对。" : ""].filter(Boolean).join("\n"), 600), result: "pending" });
      } else entry.omittedActions++;
    } else if (event.type === "tool_result") {
      const action = entry.actions.find(item => item.key === hash(event.toolUseId));
      if (action) action.result = event.isError ? "error" : "ok";
    } else if (event.type === "text") {
      entry.status = "running";
      const buffered = this.publicText.get(entry.id) ?? { text: "", overflow: false };
      if (!buffered.overflow) {
        if (buffered.text.length + event.text.length > 64_000) {
          buffered.text = "";
          buffered.overflow = true;
        } else buffered.text += event.text;
      }
      this.publicText.set(entry.id, buffered);
    } else return;
    this.touch(entry);
  }

  private touch(entry: Entry): void {
    entry.updatedAt = new Date().toISOString();
    entry.revision++;
    this.save();
  }

  private save(): void {
    const path = this.options.stateFile;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, destination: this.options.destination, entries: [...this.entries.values()] }), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }

  private render(entry: Entry): string {
    // All untrusted text is quoted as inert, indented code; no markdown
    // instructions, mentions or remote images from users/model are rendered.
    const quote = (text: string, byteLimit = 12_000): string => {
      const lines = (text || "（无）").split("\n");
      const formatted = lines.slice(0, 200).map(line => `    ${line}`).join("\n");
      let result = "";
      let bytes = 0;
      for (const character of formatted) {
        bytes += Buffer.byteLength(character, "utf8");
        if (bytes > byteLimit) break;
        result += character;
      }
      return result + (result.length < formatted.length || lines.length > 200 ? "\n    [超过本条摘要长度，已截断]" : "");
    };
    const actions = entry.actions.map((action, i) => `${i + 1}. ${action.name} — ${action.result === "ok" ? "工具返回成功" : action.result === "error" ? "工具返回失败" : "未收到结果"}\n${action.detail}`).join("\n\n");
    return [
      `<!-- corebyte-lark-work:${entry.id} -->`,
      `### Lark 工作记录 ${entry.id.slice(0, 10)}`,
      `状态：${labels[entry.status]}\n\n发起人：${entry.actor} · 执行者：corebyte-codex（自动记录）`,
      `接收时间 UTC：${entry.createdAt}\n\n最后更新 UTC：${entry.updatedAt}`,
      "#### 工作目录", quote(entry.cwd, 2000),
      "#### Lark 指令（已过滤敏感内容）", quote(entry.instruction, 10_000),
      "#### 实际观察到的动作 / 验证", quote(actions),
      entry.omittedActions > 0 ? `另有 ${entry.omittedActions} 次工具调用超出本条明细上限，未声称全量明细。` : "",
      "工具返回成功仅代表工具结果，不代表业务验收；原始输出不上传。",
      "#### Codex 结果报告（最后一组连续公开回复；保留完成项 / 待办 / Issue、PR）",
      quote(entry.status === "completed" ? entry.report : "本轮尚无已完成的最终报告；取消/失败不沿用中间答复。"),
      entry.error ? `#### 异常 / 阻塞\n\n${quote(entry.error, 6000)}` : "",
      "本记录来自桥的任务事件与模型公开答复，不是人工审批或人工验收；不会自动关闭 Issue 或合并 PR。",
    ].filter(Boolean).join("\n\n");
  }

  flush(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.drain().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  private async drain(): Promise<void> {
    const processed = new Set<string>();
    for (let n = 0; n < 20; n++) {
      const rows = [...this.entries.values()];
      const offset = this.scanAfter ? rows.findIndex(item => item.id === this.scanAfter) + 1 : 0;
      const entry = [...rows.slice(offset), ...rows.slice(0, offset)]
        .find(item => item.syncedRevision !== item.revision && !processed.has(item.id));
      if (!entry) return;
      this.scanAfter = entry.id;
      processed.add(entry.id); // At most one update per entry per pass; coalesce streaming events.
      try {
        const revision = entry.revision;
        const marker = `<!-- corebyte-lark-work:${entry.id} -->`;
        const body = this.render(entry);
        if (entry.commentId === undefined) {
          const existing = await this.options.remote.find(marker);
          if (existing) {
            entry.commentId = existing.id; entry.url = existing.url; this.save();
          } else {
            // A lost POST response cannot safely be retried. Continue to
            // look up its marker, but never issue another blind creation.
            if (entry.createAttempted) throw new Error("Prior creation is in doubt; reconciliation required");
            entry.createAttempted = true;
            this.save();
            const created = await this.options.remote.create(marker, body);
            entry.commentId = created.id; entry.url = created.url;
            entry.syncedRevision = revision;
            this.save();
            continue;
          }
        }
        await this.options.remote.update(marker, entry.commentId, body);
        entry.syncedRevision = revision;
        this.save();
      } catch {
        try { this.options.onSyncError?.(); } catch { /* Diagnostics must not break the queue. */ }
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.save();
    // Do not hang shutdown on GitHub. Persistent dirty entries are retried
    // on the next start; an ambiguous create is reconciled by marker.
  }
}
