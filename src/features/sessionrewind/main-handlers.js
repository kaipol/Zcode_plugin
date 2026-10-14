/* __ZCODE_SESSION_REWIND_V1__ main-process handlers (appended block, asar 注入版).
 * Self-contained; safe to remove this whole block to uninstall.
 * Registers: sessionrewind:request (listSessions / listTurns / insertText / submit / dbInfo).
 *
 * 机制说明(为什么这样做):
 *   ZCode 桌面版的会话时间线由**独立的 agent 运行时子进程**(resources/glm/zcode.cjs)
 *   持有,会话库是 ~/.zcode/cli/db/db.sqlite。运行时内置两个斜杠命令,走普通输入路径
 *   在运行时内执行、且不受"仅允许最新一轮"的 UI 闸门限制:
 *     /rewind cascade conversation <messageId>  回退到该用户消息之前(保留文件)
 *     /rewind fork [checkpointId]               从工作区检查点分叉出新会话
 *   模型选择是**按会话**存储的一条 session_entry(runtime/model_selection),与回退互不
 *   影响,所以回退后切换模型即可继续发送。
 *
 *   因此本特性不直接改写 session.revert(运行时在内存中持有会话,直接写库会被覆盖),
 *   而是:(1) 只读打开会话库,给渲染层列出可回退的用户轮次;(2) 把斜杠命令以受信输入
 *   写进输入框,由用户或渲染层触发发送。所有写库动作仍由运行时自己完成。
 */
;(async () => {
  try {
    const G = globalThis;
    if (G.__ZCODE_SESSION_REWIND_V1_MAIN__) return;
    G.__ZCODE_SESSION_REWIND_V1_MAIN__ = true;
    const electron = await import("electron");
    const fs = (await import("node:fs")).default;
    const path = (await import("node:path")).default;
    const os = (await import("node:os")).default;

    const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), ".zcode");
    const DEFAULT_DB = process.env.ZCODE_SESSION_DB || path.join(ZCODE_HOME, "cli", "db", "db.sqlite");
    const MAX_TURNS = 2000;

    // node:sqlite 在较新的 Electron/Node 中可用;ZCode 运行时自身即用它打开会话库。
    // 不可用时明确报错(渲染层据此提示改用离线 CLI:scripts/session-rewind.mjs)。
    let DatabaseSync = null;
    let sqliteError = "";
    try {
      const mod = await import("node:sqlite");
      DatabaseSync = mod.DatabaseSync || (mod.default && mod.default.DatabaseSync) || null;
      if (!DatabaseSync) sqliteError = "node:sqlite 未导出 DatabaseSync";
    } catch (e) {
      sqliteError = (e && e.message) || String(e);
    }

    function openDb() {
      if (!DatabaseSync) throw new Error(`当前环境缺少 node:sqlite(${sqliteError});请在 ZCode 完全退出后用离线工具:node scripts/session-rewind.mjs list`);
      if (!fs.existsSync(DEFAULT_DB)) throw new Error(`会话库不存在: ${DEFAULT_DB}`);
      // 只读:运行时子进程持有 WAL 写锁,只读连接可并发读取,不干扰它。
      return new DatabaseSync(DEFAULT_DB, { readOnly: true });
    }

    function safeJson(text) {
      try { return JSON.parse(text); } catch { return null; }
    }

    function previewOf(text) {
      return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    }

    // 汇总某条消息的文本(取全部 type=text 的 part,按顺序拼接)。
    function textOfMessage(db, messageId) {
      const parts = db.prepare("select data from part where message_id = ? order by sequence").all(messageId);
      const chunks = [];
      for (const p of parts) {
        const d = safeJson(p.data);
        if (d && d.type === "text" && typeof d.text === "string") chunks.push(d.text);
      }
      return chunks.join("\n").trim();
    }

    function describeTurn(db, row, visible) {
      const d = safeJson(row.data) || {};
      const text = textOfMessage(db, row.id);
      const sel = d.modelSelection || {};
      const model = sel.providerId && sel.modelId ? `${sel.providerId}/${sel.modelId}` : "";
      return {
        messageId: row.id,
        sequence: row.sequence,
        time: row.time_created,
        role: "user",
        model,
        text,
        preview: previewOf(text),
        visible,
      };
    }

    // 当前分支上可见的消息集合。运行时的分支解析(selectActiveConversationBranch)为:
    //   keptMessageIDs(回退目标之前的消息) ∪ {branchCutAfterMessageID 之后追加的消息}
    // 后半段就是"回退之后又继续聊天"产生的新消息——它们必须算作可见,否则会把
    // 用户回退后新发的轮次错误地标成"已隐藏"。
    function visibleSet(session, rows) {
      if (!session || !session.revert) return null;
      const r = safeJson(session.revert);
      if (!r) return null;
      const kept = Array.isArray(r.keptMessageIDs) ? new Set(r.keptMessageIDs) : null;
      if (!kept && !r.branchCutAfterMessageID) return null;
      const set = kept || new Set();
      if (r.branchCutAfterMessageID) {
        const cutRow = rows.find((x) => x.id === r.branchCutAfterMessageID);
        if (cutRow) for (const row of rows) if (row.sequence > cutRow.sequence) set.add(row.id);
      }
      return set;
    }

    function listSessions(find) {
      const db = openDb();
      try {
        const rows = db
          .prepare(
            `select s.id, s.title, s.revert, s.time_updated,
                    (select count(*) from message m where m.session_id = s.id) as messages
             from session s order by s.time_updated desc`,
          )
          .all();
        const needle = find ? String(find).toLowerCase() : "";
        const out = [];
        for (const r of rows) {
          if (needle && !`${r.id} ${r.title || ""}`.toLowerCase().includes(needle)) continue;
          const rev = r.revert ? safeJson(r.revert) : null;
          out.push({
            id: r.id,
            title: r.title || "",
            messages: r.messages,
            timeUpdated: r.time_updated,
            hasRevert: !!rev,
            branchGeneration: (rev && rev.branchGeneration) || 0,
          });
          if (out.length >= 200) break;
        }
        return { ok: true, sessions: out, dbPath: DEFAULT_DB };
      } finally {
        db.close();
      }
    }

    function listTurns(sessionId, limit) {
      if (!sessionId) throw new Error("缺少 sessionId");
      const db = openDb();
      try {
        const session = db.prepare("select id, title, revert, time_updated from session where id = ?").get(sessionId);
        if (!session) throw new Error(`会话不存在: ${sessionId}`);
        const rows = db
          .prepare("select id, sequence, time_created, data from message where session_id = ? order by sequence")
          .all(sessionId);
        const visible = visibleSet(session, rows);
        const turns = [];
        for (const row of rows) {
          if (turns.length >= (limit || MAX_TURNS)) break;
          const d = safeJson(row.data);
          if (!d || d.role !== "user") continue;
          const sem = d.semantics || {};
          // 只认真正的用户提问:排除 system_reminder / todo_reminder / 合成的行。
          const isPrompt = sem.kind === "user_prompt" || sem.origin === "real_user";
          if (!isPrompt) continue;
          if (d.synthetic === true) continue;
          turns.push(describeTurn(db, row, visible ? visible.has(row.id) : true));
        }
        const rev = session.revert ? safeJson(session.revert) : null;
        return {
          ok: true,
          dbPath: DEFAULT_DB,
          session: {
            id: session.id,
            title: session.title || "",
            hasRevert: !!rev,
            branchGeneration: (rev && rev.branchGeneration) || 0,
            cutAfter: (rev && rev.branchCutAfterMessageID) || null,
            messageId: (rev && rev.messageID) || null,
          },
          turns,
          hiddenCount: turns.filter((t) => !t.visible).length,
        };
      } finally {
        db.close();
      }
    }

    function dbInfo() {
      return {
        ok: true,
        dbPath: DEFAULT_DB,
        dbExists: fs.existsSync(DEFAULT_DB),
        sqliteAvailable: !!DatabaseSync,
        sqliteError: sqliteError || null,
      };
    }

    // 受信输入:先发全选按键(镜像真实用户操作),再插入文本。等价 zcodeplus 的
    // insertText —— ZCode 的 Lexical 输入框对纯合成事件不认账,必须走真实输入管线。
    function insertTrusted(wc, text) {
      if (!/^\//.test(String(text || "").trim())) throw new Error("仅允许向输入框写入斜杠命令");
      if (String(text).length > 4000) throw new Error("命令过长");
      const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
      wc.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers });
      wc.insertText(String(text));
    }

    // 受信提交:向当前聚焦元素注入真实 Enter 按键,等价用户按回车发送。
    // 渲染层的自动发送优先点击发送按钮,失败时才走这里(例如按钮一时不可用)。
    function submitTrusted(wc) {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }

    async function handleRequest(event, raw) {
      let msg;
      try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { ok: false, error: "无效请求" }; }
      try {
        if (msg.type === "dbInfo") return dbInfo();
        if (msg.type === "listSessions") return listSessions(msg.find);
        if (msg.type === "listTurns") return listTurns(msg.sessionId, msg.limit);
        if (msg.type === "insertText") {
          insertTrusted(event.sender, msg.text);
          return { ok: true };
        }
        if (msg.type === "submit") {
          submitTrusted(event.sender);
          return { ok: true };
        }
        return { ok: false, error: "未知请求类型" };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error).slice(0, 300) };
      }
    }

    async function register(name, fn) {
      try { electron.ipcMain.removeHandler(name); } catch {}
      electron.ipcMain.handle(name, async (event, payload) => {
        try { return await fn(event, payload); } catch (e) {
          return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
        }
      });
    }
    await register("sessionrewind:request", handleRequest);
  } catch (e) {
    try { console.error("[session-rewind] main init failed:", (e && e.message) || e); } catch {}
  }
})();