#!/usr/bin/env node
// Offline conversation rewind for the ZCode desktop session store.
//
// The v4 conversation timeline is rebuilt on cold load from the message/part
// tables trimmed by session.revert (the same field the app's own edit-rerun
// writes). Setting revert therefore hides the tail of a conversation in the
// UI without deleting anything — clear it to bring the rows back.
//
//   node scripts/session-rewind.mjs list [--find <关键词>]
//   node scripts/session-rewind.mjs inspect <session前缀> [--limit 200]
//   node scripts/session-rewind.mjs rewind <session前缀> --to <序号|id前缀> [--dry-run]
//   node scripts/session-rewind.mjs clear <session前缀>
//
// Requires ZCode to be fully closed (a running runtime holds the session in
// memory and would ignore/overwrite the change). Every write is preceded by a
// timestamped backup of db.sqlite.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { isZcodeRunning } from "../src/core/platform.mjs";

const DEFAULT_DB = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

function parseArgs(argv) {
  const opts = { db: process.env.ZCODE_SESSION_DB || DEFAULT_DB, limit: 200 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opts.db = argv[++i];
    else if (a === "--find") opts.find = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10) || 200;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--ignore-running") opts.ignoreRunning = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("--")) rest.push(a);
  }
  return { opts, cmd: rest[0] || null, arg: rest[1] || null };
}

const HELP = `ZCode 会话回退工具(离线,零依赖)

用法: node scripts/session-rewind.mjs <命令> [参数]

  list                     列出会话(标题/更新时间/消息数/是否有回退记录),--find 过滤
  inspect <session前缀>    按顺序列出该会话的消息链(序号/角色/模型/预览)
  rewind <session前缀> --to <序号|消息id前缀>
                           回退:保留到锚点行为止,其后的消息在 UI 中隐藏(不删除)
  clear <session前缀>      取消回退,恢复完整时间线

通用选项:
  --db <路径>       会话库路径(默认 ~/.zcode/cli/db/db.sqlite;可用 env ZCODE_SESSION_DB)
  --ignore-running  跳过"ZCode 正在运行"保护(仅对 --db 指向的副本使用!)
  --dry-run         rewind 只预览不写入

安全机制: ZCode 运行中一律拒绝;写入前自动生成带时间戳的备份;回退不删除任何消息,
随时可用 clear 恢复完整时间线。`;

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`会话库不存在: ${dbPath}`);
  return new DatabaseSync(dbPath);
}

function resolveSession(db, prefix) {
  if (!prefix) throw new Error("缺少 session 前缀(先用 list 查看)");
  const rows = db.prepare("select id, title, revert, time_updated from session where id like ? order by time_updated desc").all(prefix + "%");
  if (rows.length === 0) throw new Error(`没有匹配 ${prefix} 的会话(用 list 查看)`);
  if (rows.length > 1) {
    throw new Error(`前缀 ${prefix} 命中 ${rows.length} 个会话,请用更长的前缀:\n` +
      rows.slice(0, 5).map(r => `  ${r.id}  ${(r.title || "(无标题)").slice(0, 40)}`).join("\n"));
  }
  return rows[0];
}

function messageChain(db, sessionId, limit) {
  return db
    .prepare("select id, sequence, data from message where session_id = ? order by sequence limit ?")
    .all(sessionId, limit);
}

function describeRow(db, row) {
  let role = "?";
  let model = "";
  try {
    const d = JSON.parse(row.data);
    role = d.role || d.type || "?";
    if (d.modelId) model = `${d.providerId || ""}/${d.modelId}`;
  } catch {}
  const part = db
    .prepare("select data from part where message_id = ? and data like ? order by sequence limit 1")
    .get(row.id, '%type":"text%');
  let preview = "";
  if (part) {
    try {
      preview = String(JSON.parse(part.data).text || "").replace(/\s+/g, " ").slice(0, 70);
    } catch {}
  }
  return { role, model, preview };
}

function cmdList(db, opts) {
  const rows = db
    .prepare(`select s.id, s.title, s.revert, s.time_updated,
                     (select count(*) from message m where m.session_id = s.id) as messages
              from session s order by s.time_updated desc`)
    .all();
  const stamp = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 16);
  for (const r of rows) {
    if (opts.find) {
      const hay = `${r.id} ${r.title || ""}`.toLowerCase();
      if (!hay.includes(opts.find.toLowerCase())) continue;
    }
    const reverted = r.revert ? "[已回退]" : "";
    console.log(`${stamp(r.time_updated)}  ${r.id}  msgs=${String(r.messages).padStart(4)}  ${reverted}  ${(r.title || "(无标题)").slice(0, 60)}`);
  }
  console.log(`\n共 ${rows.length} 个会话。用 inspect <id前缀> 查看消息链。`);
}

function cmdInspect(db, arg, opts) {
  const s = resolveSession(db, arg);
  console.log(`会话 ${s.id}`);
  console.log(`标题: ${s.title || "(无标题)"}   消息数: (见下)`);
  if (s.revert) console.log(`现有回退: ${String(s.revert).slice(0, 160)}…`);
  const chain = messageChain(db, s.id, opts.limit);
  for (const row of chain) {
    const d = describeRow(db, row);
    console.log(`[${String(row.sequence).padStart(4)}] ${row.id}  ${d.role}${d.model ? ` @ ${d.model}` : ""}  ${d.preview}`);
  }
  console.log(`\n回退示例: node scripts/session-rewind.mjs rewind ${s.id.slice(0, 12)} --to <上面某行的序号或id前缀>`);
}

function anchorFromChain(chain, to) {
  if (to === undefined || to === null || to === "") throw new Error("rewind 需要 --to <序号|id前缀>(用 inspect 查看)");
  let anchor;
  if (/^\d+$/.test(String(to))) {
    const seq = parseInt(to, 10);
    anchor = chain.find((r) => r.sequence === seq);
    if (!anchor) throw new Error(`序号 ${seq} 不在消息链中(注意 inspect 默认截断 200 条,可用 --limit 放开)`);
  } else {
    const hits = chain.filter((r) => r.id.startsWith(to));
    if (hits.length === 0) throw new Error(`没有匹配 ${to} 的消息`);
    if (hits.length > 1) throw new Error(`id 前缀 ${to} 命中 ${hits.length} 条,请用更长前缀`);
    anchor = hits[0];
  }
  return anchor;
}

function backupDb(dbPath) {
  // WAL 收口后单文件备份;打开数据库连接做一次 checkpoint 再拷贝。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.pre-rewind-${stamp}.bak`;
  const fd = new DatabaseSync(dbPath);
  fd.exec("pragma wal_checkpoint(truncate)");
  fd.close();
  fs.copyFileSync(dbPath, backup);
  return backup;
}

function cmdRewind(db, arg, opts) {
  const s = resolveSession(db, arg);
  const chain = messageChain(db, s.id, 1000000);
  const anchor = anchorFromChain(chain, opts.to);
  const kept = chain.filter((r) => r.sequence <= anchor.sequence);
  const previous = s.revert ? JSON.parse(s.revert) : null;
  const revert = {
    keptMessageIDs: kept.map((r) => r.id),
    branchCutAfterMessageID: anchor.id,
    branchGeneration: ((previous && previous.branchGeneration) || 0) + 1,
    messageID: anchor.id,
    kind: "conversation_rewind",
    scope: "conversation",
  };
  const preview = describeRow(db, anchor);
  console.log(`会话 ${s.id}(${(s.title || "").slice(0, 40)})`);
  console.log(`锚点 [seq ${anchor.sequence}] ${anchor.id} ${preview.role} :: ${preview.preview}`);
  console.log(`保留 ${kept.length} / ${chain.length} 条消息,其后 ${chain.length - kept.length} 条在 UI 中隐藏(数据不删除)。`);
  if (opts.dryRun) {
    console.log(`[i] --dry-run:未写入。revert 预览: ${JSON.stringify(revert).slice(0, 200)}…`);
    return;
  }
  const backup = backupDb(opts.db);
  const json = JSON.stringify(revert);
  const info = db.prepare("update session set revert = ? where id = ?").run(json, s.id);
  if (Number(info.changes) !== 1) throw new Error("revert 写入失败(影响行数不为 1)");
  const back = JSON.parse(db.prepare("select revert from session where id = ?").get(s.id).revert);
  if (back.branchCutAfterMessageID !== anchor.id || back.keptMessageIDs.length !== kept.length) {
    throw new Error("回读校验失败,请用备份文件恢复");
  }
  console.log(`[√] 已回退。消息 ${kept.length}/${chain.length} 保留,`+
    `branchGeneration=${revert.branchGeneration}。`);
  console.log(`    备份: ${backup}(clear 可撤销回退;备份可直接覆盖还原)`);
  console.log("    启动 ZCode 后该会话时间线即变短,用切换后的模型继续即可。");
}

function cmdClear(db, arg) {
  const s = resolveSession(db, arg);
  const info = db.prepare("update session set revert = null, summary_additions = null, summary_deletions = null, summary_files = null, summary_diffs = null where id = ?").run(s.id);
  if (Number(info.changes) !== 1) throw new Error("clear 写入失败");
  console.log(`[√] 已清除 ${s.id} 的回退记录,时间线恢复完整。启动 ZCode 生效。`);
}

function main() {
  const { opts, cmd, arg } = parseArgs(process.argv.slice(2));
  if (opts.help || !cmd) return console.log(HELP);
  if (isZcodeRunning() && !opts.ignoreRunning) {
    console.error("[x] ZCode 正在运行。请先完全退出 ZCode(包括托盘)再执行;仅对 --db 指向的副本测试时可加 --ignore-running。");
    process.exit(2);
  }
  const db = openDb(opts.db);
  try {
    if (cmd === "list") cmdList(db, opts);
    else if (cmd === "inspect") cmdInspect(db, arg, opts);
    else if (cmd === "rewind") cmdRewind(db, arg, opts);
    else if (cmd === "clear") cmdClear(db, arg);
    else {
      console.error(`未知命令: ${cmd}`);
      console.log(HELP);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  console.error(`[x] ${e.message}`);
  process.exit(2);
}
