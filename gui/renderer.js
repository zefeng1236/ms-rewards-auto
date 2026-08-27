/* Microsoft Rewards 自动任务 - 渲染进程 */
const bridge = window.api;

let accounts = [];
let stats = {};
let selectedId = null;
let accountView = null;
let globalCfg = null;   // 全局设置
let accOverrides = null; // 当前账户的独立覆盖值（含回落到全局的字段）
let currentView = "dashboard";
let logQueue = [];
let logFlushTimer = null;
let autoScroll = true;
let tableSearch = "";

const $ = (sel) => document.querySelector(sel);

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (type ? " " + type : "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2600);
}

function setBusy(sel, busy) {
  const el = $(sel);
  if (el) el.disabled = busy;
}

/** 深合并到本地缓存，避免每次改设置都要重新拉一遍 IPC */
function mergeInto(base, patch) {
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      mergeInto(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/* ---------- 自定义对话框（Electron 不支持原生 prompt/confirm） ---------- */
let modalResolve = null;

function closeModal(value) {
  const mask = $("#modal-mask");
  if (mask) mask.hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
  else console.warn("[modal] closeModal called but no pending resolve; value=", value);
}

function openModal({ title, message = "", input = false, placeholder = "", okText = "确定" }) {
  return new Promise((resolve) => {
    if (modalResolve) {
      console.warn("[modal] openModal called while another modal is pending, forcing close previous");
      closeModal(null);
    }
    modalResolve = resolve;
    $("#modal-title").textContent = title;
    $("#modal-msg").textContent = message;
    $("#modal-msg").hidden = !message;
    const inp = $("#modal-input");
    inp.hidden = !input;
    inp.value = "";
    inp.placeholder = placeholder;
    $("#modal-ok").textContent = okText;
    $("#modal-mask").hidden = false;
    if (input) setTimeout(() => inp.focus(), 30);
    else setTimeout(() => $("#modal-ok").focus(), 30);
    console.log("[modal] opened:", title, "| hasResolve=", !!modalResolve);
  });
}

function askText(title, placeholder = "") {
  return openModal({ title, input: true, placeholder });
}

async function askConfirm(title, message, okText = "确定") {
  const r = await openModal({ title, message, okText });
  return r !== null;
}

function wireModal() {
  const ok = $("#modal-ok");
  const cancel = $("#modal-cancel");
  const mask = $("#modal-mask");
  if (!ok || !cancel || !mask) {
    console.error("[modal] wireModal: missing elements", { ok: !!ok, cancel: !!cancel, mask: !!mask });
    return;
  }
  ok.addEventListener("click", () => {
    const inp = $("#modal-input");
    closeModal(inp && !inp.hidden ? inp.value.trim() : true);
  });
  cancel.addEventListener("click", () => closeModal(null));
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) closeModal(null);
  });
  const inp = $("#modal-input");
  if (inp) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (mask.hidden) return;
    if (e.key === "Escape") closeModal(null);
    else if (e.key === "Enter" && (!inp || inp.hidden)) ok.click();
  });
  console.log("[modal] wireModal done: ok=", !!ok, "cancel=", !!cancel, "mask=", !!mask);
}

/** 包装点击回调，任何异常都提示出来而不是静默失败 */
function onClick(sel, fn) {
  const el = $(sel);
  if (!el) {
    console.warn("找不到元素: " + sel);
    return;
  }
  el.addEventListener("click", async (ev) => {
    try {
      await fn(ev);
    } catch (err) {
      console.error(err);
      toast("操作失败：" + (err && err.message ? err.message : String(err)), "err");
      setBusy(sel, false);
    }
  });
}

/* ==================== 设置表单工厂 ====================
 * 全局设置与账户独立设置字段完全一致，用同一套生成器产出两份，
 * 靠 ns 前缀区分 id（g- / a-），避免维护两份几乎相同的 HTML。
 */

/** 生成设置表单 HTML；ns 为 id 前缀（"g" 全局 / "a" 账户） */
function settingsFormHtml(ns) {
  const p = (k) => `${ns}-${k}`;
  return `
    <div class="sec">
      <div class="sec-title">任务开关</div>
      <div class="toggles">
        <label class="toggle"><input type="checkbox" id="${p("t-sign")}" data-task="sign" /><span>每日签入</span></label>
        <label class="toggle"><input type="checkbox" id="${p("t-read")}" data-task="read" /><span>阅读文章</span></label>
        <label class="toggle"><input type="checkbox" id="${p("t-promos")}" data-task="promos" /><span>活动交卷</span></label>
        <label class="toggle"><input type="checkbox" id="${p("t-search")}" data-task="search" /><span>搜索积分</span></label>
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">搜索设置</div>
      <div class="form-grid">
        <label class="field">
          <span>搜索间隔（秒，实际 ±15s 随机）</span>
          <input type="number" id="${p("search-span")}" min="5" max="300" />
        </label>
        <label class="field">
          <span>搜索词来源</span>
          <select id="${p("search-api")}">
            <option value="offline">内置随机词</option>
            <option value="hot.baiwumm.com">hot.baiwumm.com</option>
            <option value="hot.cnxiaobai.com">hot.cnxiaobai.com</option>
            <option value="hot.nntool.cc">hot.nntool.cc</option>
          </select>
        </label>
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">自动运行</div>
      <div class="form-grid">
        <label class="toggle inline"><input type="checkbox" id="${p("s-enable")}" /><span>启用自动运行</span></label>
        <label class="field inline">
          <span>运行模式</span>
          <select id="${p("s-mode")}">
            <option value="interval">循环间隔（推荐）</option>
            <option value="windows">指定时间段</option>
            <option value="daily">每天固定时刻一次</option>
          </select>
        </label>
      </div>
      <div id="${p("s-loop-box")}" class="form-grid">
        <label class="field inline">
          <span>每隔多少分钟跑一轮</span>
          <input type="number" id="${p("s-interval")}" min="5" max="720" />
        </label>
        <label class="field inline">
          <span>每天最多轮数（0=不限）</span>
          <input type="number" id="${p("s-maxrounds")}" min="0" max="99" />
        </label>
        <label class="toggle inline">
          <input type="checkbox" id="${p("s-stopdone")}" />
          <span>当天任务全部完成后停止循环</span>
        </label>
      </div>
      <div id="${p("s-windows-box")}" hidden>
        <div class="sub-title">执行时间段（可添加多段，支持跨零点如 22:00–02:00）</div>
        <div id="${p("s-windows-list")}" class="win-list"></div>
        <button id="${p("btn-add-window")}" class="btn small ghost">＋ 添加时间段</button>
      </div>
      <div id="${p("s-daily-box")}" class="form-grid" hidden>
        <label class="field inline">
          <span>每天运行时刻</span>
          <input type="time" id="${p("s-time")}" />
        </label>
      </div>
      <div class="sched-hint" id="${p("s-hint")}"></div>
    </div>

    <div class="sec">
      <div class="sec-title">推送通知（留空则不推送）</div>
      <div class="form-grid">
        <label class="field"><span>企业微信 Webhook</span><input type="text" id="${p("n-wework")}" placeholder="https://qyapi.weixin.qq.com/..." /></label>
        <label class="field"><span>钉钉 Webhook</span><input type="text" id="${p("n-dingding")}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." /></label>
        <label class="field"><span>飞书 Webhook</span><input type="text" id="${p("n-feishu")}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." /></label>
        <label class="field"><span>PushMe Key</span><input type="text" id="${p("n-pushme")}" placeholder="push_key" /></label>
        <label class="field"><span>Bark Key</span><input type="text" id="${p("n-bark")}" placeholder="https://api.day.app/XXXX" /></label>
      </div>
    </div>
  `;
}

/** 把配置值填进指定命名空间的表单 */
function fillSettingsForm(ns, cfg) {
  const q = (k) => $(`#${ns}-${k}`);
  const c = cfg || {};

  const t = c.tasks || {};
  q("t-sign").checked = !!t.sign;
  q("t-read").checked = !!t.read;
  q("t-promos").checked = !!t.promos;
  q("t-search").checked = !!t.search;

  const search = c.search || {};
  q("search-span").value = search.span || 30;
  q("search-api").value = search.api || "offline";

  const sc = c.schedule || {};
  q("s-enable").checked = sc.enable !== false;
  q("s-mode").value = ["interval", "windows", "daily"].includes(sc.mode) ? sc.mode : "interval";
  q("s-interval").value = Number(sc.intervalMinutes) || 45;
  q("s-maxrounds").value = Number(sc.maxRounds) || 0;
  q("s-stopdone").checked = sc.stopWhenDone !== false;
  q("s-time").value = sc.time || "08:00";
  renderWindows(ns, Array.isArray(sc.windows) && sc.windows.length ? sc.windows : [{ start: "09:00", end: "23:00" }]);
  applyScheduleMode(ns);

  const n = c.notice || {};
  q("n-wework").value = n.wework || "";
  q("n-dingding").value = n.dingding || "";
  q("n-feishu").value = n.feishu || "";
  q("n-pushme").value = n.pushme || "";
  q("n-bark").value = n.bark || "";
}

/**
 * 保存设置补丁
 * ns 决定写到哪儿：g -> 全局设置；a -> 当前账户的覆盖值
 */
async function saveSettings(ns, patch) {
  if (ns === "g") {
    await bridge.setGlobalConfig(patch);
    if (globalCfg) mergeInto(globalCfg, patch);
    // 遵循全局的账号有效配置随之变化，刷新一次概览
    refreshOverview();
  } else {
    if (!selectedId) return;
    await bridge.setConfig(selectedId, patch);
    if (accOverrides) mergeInto(accOverrides, patch);
  }
  toast("设置已保存", "ok");
}

/** 按当前模式显示/隐藏对应的设置块 */
function applyScheduleMode(ns) {
  const q = (k) => $(`#${ns}-${k}`);
  if (!q("s-mode")) return;
  const mode = q("s-mode").value;
  const enabled = q("s-enable").checked;
  q("s-loop-box").hidden = mode === "daily";
  q("s-windows-box").hidden = mode !== "windows";
  q("s-daily-box").hidden = mode !== "daily";
  // 未启用时把子控件禁掉，避免误以为在生效
  for (const k of ["s-mode", "s-interval", "s-maxrounds", "s-stopdone", "s-time", "btn-add-window"]) {
    const el = q(k);
    if (el) el.disabled = !enabled;
  }
  q("s-windows-list")
    .querySelectorAll("input,button")
    .forEach((el) => (el.disabled = !enabled));
  renderScheduleHint(ns);
}

/** 渲染时间段列表 */
function renderWindows(ns, windows) {
  const box = $(`#${ns}-s-windows-list`);
  if (!box) return;
  box.innerHTML = "";
  windows.forEach((w, idx) => {
    const row = document.createElement("div");
    row.className = "win-row";
    row.innerHTML =
      `<input type="time" class="win-start" value="${escapeHtml(w.start || "09:00")}" />` +
      `<span class="win-sep">至</span>` +
      `<input type="time" class="win-end" value="${escapeHtml(w.end || "23:00")}" />` +
      `<button class="win-del" title="删除此时间段">×</button>`;
    row.querySelector(".win-del").addEventListener("click", () => {
      const cur = collectWindows(ns);
      cur.splice(idx, 1);
      renderWindows(ns, cur.length ? cur : [{ start: "09:00", end: "23:00" }]);
      saveWindows(ns);
    });
    row.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => saveWindows(ns)));
    box.appendChild(row);
  });
}

function collectWindows(ns) {
  return Array.from($(`#${ns}-s-windows-list`).querySelectorAll(".win-row")).map((row) => ({
    start: row.querySelector(".win-start").value || "09:00",
    end: row.querySelector(".win-end").value || "23:00",
  }));
}

async function saveWindows(ns) {
  await saveSettings(ns, { schedule: { windows: collectWindows(ns) } });
  renderScheduleHint(ns);
}

/** 底部提示文案：把当前设置翻译成一句人话 */
function renderScheduleHint(ns) {
  const q = (k) => $(`#${ns}-${k}`);
  const hint = q("s-hint");
  if (!hint) return;
  if (!q("s-enable").checked) {
    hint.textContent = "自动运行已关闭，只能手动点「立即运行」。";
    return;
  }
  const mode = q("s-mode").value;
  const iv = Number(q("s-interval").value) || 45;
  const mr = Number(q("s-maxrounds").value) || 0;
  const stopDone = q("s-stopdone").checked;
  const parts = [];
  if (mode === "interval") {
    parts.push(`每 ${iv} 分钟自动跑一轮`);
  } else if (mode === "windows") {
    const ws = collectWindows(ns).map((w) => `${w.start}–${w.end}`).join("、");
    parts.push(`仅在 ${ws} 内，每 ${iv} 分钟跑一轮`);
  } else {
    parts.push(`每天 ${q("s-time").value || "08:00"} 运行一次（跑完即止，不循环）`);
  }
  if (mode !== "daily") {
    parts.push(stopDone ? "当天任务全部完成后停止，次日自动恢复" : "不判断完成状态，持续循环");
    if (mr > 0) parts.push(`每天最多 ${mr} 轮`);
  }
  hint.textContent = parts.join("；") + "。";
}

/** 给指定命名空间的表单绑定事件（全局与账户各调一次） */
function wireSettingsForm(ns) {
  const q = (k) => $(`#${ns}-${k}`);
  if (!q("s-mode")) return;

  // 任务开关
  for (const key of ["sign", "read", "promos", "search"]) {
    const el = q("t-" + key);
    if (el) el.addEventListener("change", () => saveSettings(ns, { tasks: { [key]: el.checked } }));
  }

  // 搜索设置
  q("search-span").addEventListener("change", () => {
    const val = Math.max(5, Math.min(300, Number(q("search-span").value) || 30));
    q("search-span").value = val;
    saveSettings(ns, { search: { span: val } });
  });
  q("search-api").addEventListener("change", () => {
    saveSettings(ns, { search: { api: q("search-api").value } });
  });

  // 自动运行
  q("s-enable").addEventListener("change", () => {
    saveSettings(ns, { schedule: { enable: q("s-enable").checked } });
    applyScheduleMode(ns);
  });
  q("s-mode").addEventListener("change", () => {
    saveSettings(ns, { schedule: { mode: q("s-mode").value } });
    applyScheduleMode(ns);
  });
  q("s-interval").addEventListener("change", () => {
    const val = Math.max(5, Math.min(720, Number(q("s-interval").value) || 45));
    q("s-interval").value = val;
    saveSettings(ns, { schedule: { intervalMinutes: val } });
    renderScheduleHint(ns);
  });
  q("s-maxrounds").addEventListener("change", () => {
    const val = Math.max(0, Math.min(99, Number(q("s-maxrounds").value) || 0));
    q("s-maxrounds").value = val;
    saveSettings(ns, { schedule: { maxRounds: val } });
    renderScheduleHint(ns);
  });
  q("s-stopdone").addEventListener("change", () => {
    saveSettings(ns, { schedule: { stopWhenDone: q("s-stopdone").checked } });
    renderScheduleHint(ns);
  });
  q("s-time").addEventListener("change", () => {
    saveSettings(ns, { schedule: { time: q("s-time").value } });
    renderScheduleHint(ns);
  });
  q("btn-add-window").addEventListener("click", async () => {
    const cur = collectWindows(ns);
    cur.push({ start: "09:00", end: "23:00" });
    renderWindows(ns, cur);
    applyScheduleMode(ns);
    await saveWindows(ns);
  });

  // 推送通知
  for (const key of ["wework", "dingding", "feishu", "pushme", "bark"]) {
    const el = q("n-" + key);
    if (el) el.addEventListener("change", () => saveSettings(ns, { notice: { [key]: el.value.trim() } }));
  }
}

/* ==================== 视图路由 ==================== */

const VIEW_META = {
  dashboard: { title: "仪表盘", desc: "所有账户的运行概况与今日进度。" },
  account: { title: "账户详情", desc: "查看单个账号的任务进度，并为其单独配置。" },
  settings: { title: "全局设置", desc: "所有「遵循全局设置」的账号共用这份配置。" },
};

/** 切换视图 */
function switchView(name) {
  if (!VIEW_META[name]) name = "dashboard";
  currentView = name;
  for (const k of Object.keys(VIEW_META)) {
    const el = $("#view-" + k);
    if (el) el.hidden = k !== name;
  }
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  $("#view-title").textContent = VIEW_META[name].title;
  $("#view-desc").textContent = VIEW_META[name].desc;
  try { localStorage.setItem("view", name); } catch {}

  // 进入视图时补一次渲染，保证数据是最新的
  if (name === "dashboard") renderDashboard();
  else if (name === "account") renderAccountView();
  else if (name === "settings") renderGlobalSettings();
}

/* ==================== 仪表盘 ==================== */

/** lastRunDate 是 YYYYMMDD 数字，格式化成「08-26」 */
function fmtLastRun(a) {
  const st = a.state || {};
  const d = Number(st.lastRunDate) || 0;
  if (!d) return "—";
  const s = String(d);
  if (s.length !== 8) return "—";
  return s.slice(4, 6) + "-" + s.slice(6, 8);
}

/** 自动运行状态短文案 */
function schedText(a) {
  const sd = (a.state || {}).sched || {};
  if (sd.enable === false) return { text: "未启用", cls: "off" };
  if (sd.dayDone) return { text: "已收工 " + (sd.rounds || 0) + " 轮", cls: "done" };
  if (sd.mode === "daily") return { text: "每日定时", cls: "on" };
  if (sd.mode === "windows") return { text: "时间段循环", cls: "on" };
  return { text: "每 " + (sd.intervalMinutes || 45) + " 分钟", cls: "on" };
}

/** 渲染仪表盘（统计卡 + 表格） */
function renderDashboard() {
  const s = stats || {};
  $("#d-total").textContent = s.total || 0;
  $("#d-enabled").textContent = s.enabled || 0;
  $("#d-loggedin").textContent = s.loggedIn || 0;
  $("#d-today").textContent = s.todayPoints || 0;
  $("#d-progress").textContent = (s.dayDone || 0) + "/" + (s.enabled || 0);

  const tbody = $("#d-tbody");
  const empty = $("#d-empty");
  const kw = tableSearch.trim().toLowerCase();
  const rows = accounts.filter((a) => !kw || String(a.name || "").toLowerCase().includes(kw));

  empty.hidden = accounts.length > 0;
  tbody.innerHTML = "";
  if (!rows.length) return;

  for (const a of rows) {
    const st = a.state || {};
    const sd = st.sched || {};
    const sch = schedText(a);
    const pending = Array.isArray(sd.pending) && sd.pending.length ? sd.pending.join("、") : "";
    const initial = escapeHtml((a.name || "?").slice(0, 1).toUpperCase());
    const shortId = escapeHtml(String(a.id).slice(0, 8));
    const scopeText = a.useGlobal === false ? "独立设置" : "遵循全局";

    const tr = document.createElement("tr");
    if (a.id === selectedId) tr.className = "is-current";
    tr.innerHTML =
      "<td><div class='cell-acc'>" +
        "<span class='acc-avatar'>" + initial + "</span>" +
        "<div><div class='cell-name'>" + escapeHtml(a.name || "未命名") + "</div>" +
        "<div class='cell-id'>" + shortId + " · " + scopeText + "</div></div>" +
      "</div></td>" +
      "<td><span class='tag-state " + (st.loggedIn ? "ok" : "warn") + "'>" +
        (st.loggedIn ? "已登录" : "未登录") + "</span></td>" +
      "<td class='num'>" + (st.todayPoints || 0) + "</td>" +
      "<td class='num'>" + (st.lastBalance || 0) + "</td>" +
      "<td>" + (pending
        ? "<span class='tag-pending'>" + escapeHtml(pending) + "</span>"
        : "<span class='tag-state ok'>全部完成</span>") + "</td>" +
      "<td><span class='tag-sched " + sch.cls + "'>" + escapeHtml(sch.text) + "</span></td>" +
      "<td class='dim'>" + fmtLastRun(a) + "</td>" +
      "<td class='col-act'>" +
        "<button class='icon-btn act-run' title='运行此账号'>▶</button>" +
        "<button class='icon-btn act-open' title='查看详情'>⋯</button>" +
        "<label class='switch' title='启用/停用'><input type='checkbox' " +
          (a.enabled ? "checked" : "") + " /><span class='slider'></span></label>" +
      "</td>";

    tr.querySelector(".switch input").addEventListener("change", async (e) => {
      await bridge.setAccountEnabled(a.id, e.target.checked);
      await refreshOverview();
    });
    tr.querySelector(".act-run").addEventListener("click", async (e) => {
      e.stopPropagation();
      await runAccount(a.id);
    });
    tr.querySelector(".act-open").addEventListener("click", (e) => {
      e.stopPropagation();
      selectAccount(a.id);
      switchView("account");
    });
    tr.addEventListener("dblclick", () => {
      selectAccount(a.id);
      switchView("account");
    });
    tbody.appendChild(tr);
  }
}

/* ==================== 账户详情 ==================== */

/**
 * 设置卡片主值 + 视觉状态类
 * is-done  -> 完成态（绿色渐变）
 * is-empty -> 无数据（降低视觉权重）
 */
function setCardValue(sel, text, kind) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-done", kind === "done");
  el.classList.toggle("is-empty", kind === "empty");
}

/** 切换当前账号（不改视图） */
function selectAccount(id) {
  if (!id || selectedId === id) return;
  selectedId = id;
  accountView = accounts.find((a) => a.id === id) || null;
  accOverrides = null; // 强制下次渲染时重新拉取覆盖值
  try { localStorage.setItem("accountId", id); } catch {}
}

/** 渲染账户下拉选择器 */
function renderAccountPicker() {
  const sel = $("#acc-select");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  for (const a of accounts) {
    const opt = document.createElement("option");
    opt.value = a.id;
    const st = a.state || {};
    const mark = (st.sched || {}).dayDone ? " ✓" : "";
    opt.textContent =
      (a.name || "未命名") + mark + " · " + (st.loggedIn ? "已登录" : "未登录") + " · " + (st.todayPoints || 0) + " 分";
    sel.appendChild(opt);
  }
  if (selectedId) sel.value = selectedId;
  else if (prev) sel.value = prev;
}

/** 只渲染状态区（下拉 + 积分卡片），不碰表单，避免打断输入 */
function renderAccountStatus() {
  const v = accountView;
  if (!v) return;
  const s = v.state || {};

  const dot = $("#acc-login-dot");
  if (dot) dot.className = "dot " + (s.loggedIn ? "on" : "off");
  const lt = $("#acc-login-text");
  if (lt) lt.textContent = s.loggedIn ? "已登录" : s.hasRefreshToken ? "已授权（Cookie 待同步）" : "未登录";

  setCardValue("#c-balance", s.lastBalance ? String(s.lastBalance) : "--", s.lastBalance ? "" : "empty");
  setCardValue("#c-today", s.todayPoints ? String(s.todayPoints) : "--", s.todayPoints ? "" : "empty");
  setCardValue(
    "#c-sign",
    s.signDone ? "✓ 完成" : s.signPoint > 0 ? String(s.signPoint) : "--",
    s.signDone ? "done" : s.signPoint > 0 ? "" : "empty"
  );

  // 阅读：主值显示篇数进度，完成时显示 ✓；副标题给出积分与剩余
  const raDone = Number(s.readArticlesDone) || 0;
  const raTotal = Number(s.readArticlesTotal) || 0;
  if (s.readDone) {
    setCardValue("#c-read", "✓ 完成", "done");
    $("#c-read-sub").textContent = raTotal ? raTotal + "/" + raTotal + " 篇 · " + (s.readPoint || 0) + " 分" : "";
  } else if (raTotal > 0) {
    setCardValue("#c-read", raDone + "/" + raTotal + " 篇", "");
    $("#c-read-sub").textContent = "还需 " + Math.max(0, raTotal - raDone) + " 篇 · " + (s.readPoint || 0) + " 分";
  } else {
    setCardValue("#c-read", s.readPoint > 0 ? String(s.readPoint) : "--", s.readPoint > 0 ? "" : "empty");
    $("#c-read-sub").textContent = "";
  }

  setCardValue(
    "#c-promos",
    s.promosDone ? "✓ 完成" : s.promosPoint > 0 ? String(s.promosPoint) : "--",
    s.promosDone ? "done" : s.promosPoint > 0 ? "" : "empty"
  );

  if (s.searchDone) {
    setCardValue("#c-search", "✓ 完成", "done");
    $("#c-search-sub").textContent = s.searchProgress || "";
  } else if (s.searchProgress) {
    setCardValue("#c-search", s.searchProgress, "");
    $("#c-search-sub").textContent = "";
  } else {
    setCardValue("#c-search", "--", "empty");
    $("#c-search-sub").textContent = "";
  }
  setCardValue("#c-restricted", s.restrictedTimes ? String(s.restrictedTimes) : "--", s.restrictedTimes ? "" : "empty");

  renderScheduleStatus();
}

/** 顶部徽标：显示今日调度实况 */
function renderScheduleStatus() {
  const el = $("#sched-status");
  if (!el) return;
  const sd = ((accountView && accountView.state) || {}).sched;
  if (!sd) {
    el.textContent = "";
    el.className = "sched-status";
    return;
  }
  if (sd.enable === false) {
    el.textContent = "自动运行未启用";
    el.className = "sched-status off";
    return;
  }
  if (sd.dayDone) {
    el.textContent = "✓ 今日已完成（" + (sd.rounds || 0) + " 轮）" + (sd.nextRunText ? " · 下次 " + sd.nextRunText : "");
    el.className = "sched-status done";
    return;
  }
  const pend = Array.isArray(sd.pending) && sd.pending.length ? "待办 " + sd.pending.join("/") : "待检查";
  el.textContent = pend + " · 今日 " + (sd.rounds || 0) + " 轮" + (sd.nextRunText ? " · 下次 " + sd.nextRunText : "");
  el.className = "sched-status looping";
}

/**
 * 渲染账户视图（含表单）
 *
 * 表单只在切换账号或首次进入时渲染，周期推送只走 renderAccountStatus，
 * 否则用户正在输入的内容会被冲掉（光标跳走、输入被覆盖）。
 */
async function renderAccountView() {
  const none = $("#acc-none");
  const body = $("#acc-body");
  if (!accounts.length) {
    if (none) none.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if (none) none.hidden = true;
  if (body) body.hidden = false;

  if (!selectedId) selectedId = accounts[0].id;
  accountView = accounts.find((a) => a.id === selectedId) || accounts[0] || null;
  if (!accountView) return;
  selectedId = accountView.id;

  renderAccountPicker();
  renderAccountStatus();

  const rename = $("#acc-rename");
  if (rename) rename.value = accountView.name || "";

  // 「遵循全局设置」开关
  const useGlobal = accountView.useGlobal !== false;
  const ug = $("#use-global");
  if (ug) ug.checked = useGlobal;
  renderUseGlobalHint(useGlobal);

  const box = $("#acc-settings");
  if (!box) return;
  box.hidden = useGlobal;
  if (useGlobal) return;

  // 独立模式：注入表单并填值。覆盖值里未设过的字段回落全局值，
  // 这样切过来时表单不是空的，而是以当前全局值为起点。
  if (!accOverrides) {
    try {
      accOverrides = await bridge.getOverrides(selectedId);
    } catch (e) {
      console.error(e);
      accOverrides = accountView.config || {};
    }
  }
  if (!box.dataset.wired) {
    box.innerHTML = settingsFormHtml("a");
    box.dataset.wired = "1";
    wireSettingsForm("a");
  }
  fillSettingsForm("a", accOverrides);
}

/** 「遵循全局设置」下方的说明文案 */
function renderUseGlobalHint(useGlobal) {
  const el = $("#use-global-hint");
  if (!el) return;
  el.textContent = useGlobal
    ? "当前跟随全局设置。改动全局设置会同时影响此账号；到「全局设置」页调整即可。"
    : "当前使用独立设置，不受全局设置影响。未单独调整的项以切换时的全局值为起点。";
}

/* ==================== 全局设置 ==================== */

async function renderGlobalSettings() {
  const box = $("#global-settings");
  if (!box) return;
  if (!globalCfg) {
    try {
      globalCfg = await bridge.getGlobalConfig();
    } catch (e) {
      console.error(e);
      toast("读取全局设置失败：" + e.message, "err");
      return;
    }
  }
  if (!box.dataset.wired) {
    box.innerHTML = settingsFormHtml("g");
    box.dataset.wired = "1";
    wireSettingsForm("g");
  }
  fillSettingsForm("g", globalCfg);
  renderGlobalApplyCount();
}

/** 顶部小徽标：有多少账号在跟随全局设置 */
function renderGlobalApplyCount() {
  const el = $("#global-apply-count");
  if (!el) return;
  const follow = accounts.filter((a) => a.useGlobal !== false).length;
  const total = accounts.length;
  if (!total) {
    el.textContent = "";
    return;
  }
  el.textContent = follow + "/" + total + " 个账号正在跟随";
}

/* ==================== 数据刷新 ==================== */

/** 拉取概览数据并渲染当前视图 */
async function refreshOverview() {
  try {
    const ov = await bridge.overview();
    accounts = (ov && Array.isArray(ov.accounts) ? ov.accounts : []).filter(Boolean);
    stats = (ov && ov.stats) || {};
  } catch (e) {
    console.error(e);
    accounts = [];
    stats = {};
  }
  if (selectedId && !accounts.find((a) => a.id === selectedId)) selectedId = null;
  if (!selectedId && accounts.length) selectedId = accounts[0].id;
  accountView = accounts.find((a) => a.id === selectedId) || null;

  renderDashboard();
  renderAccountPicker();
  if (currentView === "account") await renderAccountView();
  if (currentView === "settings") renderGlobalApplyCount();
}

/**
 * 主进程周期推送账户数据（3~9 秒一次）
 * 只刷状态与表格，不重绘表单，避免打断用户输入。
 */
function handleAccountsPush(list) {
  if (!Array.isArray(list)) return;
  const next = list.filter(Boolean);
  if (!next.length) return;
  // 用户正在对话框里操作时跳过，避免焦点被扰动
  if (!$("#modal-mask").hidden) return;

  accounts = next;
  // 推送不带 stats，本地按同样规则重算一遍
  stats = computeStats(accounts);
  if (selectedId && !accounts.find((a) => a.id === selectedId)) return;
  accountView = accounts.find((a) => a.id === selectedId) || null;

  if (currentView === "dashboard") renderDashboard();
  else if (currentView === "account" && accountView) {
    renderAccountPicker();
    renderAccountStatus();
  } else if (currentView === "settings") renderGlobalApplyCount();
}

/** 与主进程 overview() 保持同样的统计口径 */
function computeStats(list) {
  const s = { total: list.length, enabled: 0, loggedIn: 0, todayPoints: 0, balance: 0, dayDone: 0, pendingAccounts: 0 };
  for (const a of list) {
    const st = a.state || {};
    if (a.enabled) s.enabled++;
    if (st.loggedIn) s.loggedIn++;
    s.todayPoints += Number(st.todayPoints) || 0;
    s.balance += Number(st.lastBalance) || 0;
    if ((st.sched || {}).dayDone) s.dayDone++;
    else if (a.enabled) s.pendingAccounts++;
  }
  return s;
}

/** 运行单个账号（仪表盘和详情页共用） */
async function runAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  const res = await bridge.run(id);
  if (!res || !res.ok) toast((res && res.error) || "运行失败", "err");
  else toast("「" + (acc ? acc.name : "") + "」运行完成", "ok");
  await refreshOverview();
}

/* ==================== 日志 ==================== */
function renderLine(line) {
  const m = line.match(/^\[(.*?)\] \[(.*?)\](.*)$/);
  if (!m) return escapeHtml(line);
  const ts = m[1];
  const level = m[2];
  let rest = m[3];
  let tag = "";
  const tagM = rest.match(/^ \[(.*?)\](.*)$/);
  if (tagM) {
    tag = tagM[1];
    rest = tagM[2];
  }
  return (
    "<span class='ts'>[" + escapeHtml(ts) + "]</span>" +
    "<span class='tag'>[" + escapeHtml(level) + "]</span>" +
    (tag ? "<span class='tag'>[" + escapeHtml(tag) + "]</span>" : "") +
    escapeHtml(rest)
  );
}

function levelClass(line) {
  if (line.includes("[ERROR]")) return "error";
  if (line.includes("[WARN]")) return "warn";
  if (line.includes("[OK]")) return "ok";
  if (line.includes("[INFO]")) return "info";
  return "";
}

function flushLogs() {
  logFlushTimer = null;
  if (!logQueue.length) return;
  const filter = $("#log-filter").value.trim().toLowerCase();
  const body = $("#log-body");
  const frag = document.createDocumentFragment();
  for (const line of logQueue) {
    if (filter && !line.toLowerCase().includes(filter)) continue;
    const div = document.createElement("div");
    div.className = "log-line " + levelClass(line);
    div.innerHTML = renderLine(line);
    frag.appendChild(div);
  }
  logQueue = [];
  body.appendChild(frag);
  while (body.childElementCount > 3000) body.removeChild(body.firstChild);
  if (autoScroll) body.scrollTop = body.scrollHeight;
}

function handleLog(line) {
  logQueue.push(line);
  if (logQueue.length > 1000) logQueue.splice(0, logQueue.length - 1000);
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 120);
}

async function reloadLogs() {
  const lines = await bridge.getLogs();
  $("#log-body").innerHTML = "";
  logQueue = lines.slice(-800);
  flushLogs();
}

/* ==================== Chromium ==================== */
async function checkChromium() {
  const st = await bridge.chromiumStatus();
  const badge = $("#chromium-badge");
  if (st.ready) {
    badge.textContent = "✓ Chromium 已就绪";
    badge.className = "badge ok";
    $("#btn-install-browser").hidden = true;
  } else {
    badge.textContent = "⚠ Chromium 未安装";
    badge.className = "badge warn";
    $("#btn-install-browser").hidden = false;
  }
}

/* ==================== 事件绑定 ==================== */

/** 左导航切换 */
function wireNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
}

/** 账户相关操作 */
function wireAccountActions() {
  const sel = $("#acc-select");
  if (sel) {
    sel.addEventListener("change", async () => {
      selectAccount(sel.value);
      await renderAccountView();
    });
  }

  onClick("#btn-add", async () => {
    const name = await askText("新增账号", "账户名称（可留空自动命名）");
    if (name === null) return;
    const acc = await bridge.createAccount(name || "");
    if (!acc || !acc.id) {
      toast("账户创建失败：" + ((acc && acc.error) || "请查看日志"), "err");
      return;
    }
    selectedId = acc.id;
    toast("账户已创建，请到详情页点「授权登录」", "ok");
    await refreshOverview();
  });

  onClick("#btn-login", async () => {
    if (!selectedId) return;
    setBusy("#btn-login", true);
    try {
      const res = await bridge.login(selectedId);
      toast(res.message || res.error || (res.ok ? "登录完成" : "登录失败"), res.ok ? "ok" : "err");
    } finally {
      setBusy("#btn-login", false);
    }
    await refreshOverview();
  });

  onClick("#btn-sync", async () => {
    if (!selectedId) return;
    setBusy("#btn-sync", true);
    try {
      const res = await bridge.sync(selectedId);
      if (!res.ok) toast(res.error || "刷新失败", "err");
      else toast(res.message || (res.loggedIn ? "登录状态已同步" : "未检测到登录态"), res.loggedIn ? "ok" : "warn");
    } finally {
      setBusy("#btn-sync", false);
    }
    await refreshOverview();
  });

  onClick("#btn-run", async () => {
    if (!selectedId) return;
    setBusy("#btn-run", true);
    try {
      await runAccount(selectedId);
    } finally {
      setBusy("#btn-run", false);
    }
  });

  onClick("#btn-delete", async () => {
    if (!selectedId || !accountView) return;
    const ok = await askConfirm(
      "删除账户",
      "确定删除账户「" + accountView.name + "」？\n其登录状态、配置与浏览器数据将一并删除。",
      "删除"
    );
    if (!ok) return;
    await bridge.removeAccount(selectedId);
    selectedId = null;
    accOverrides = null;
    toast("账户已删除", "ok");
    await refreshOverview();
    switchView("dashboard");
  });

  const rename = $("#acc-rename");
  if (rename) {
    rename.addEventListener("change", async () => {
      const name = rename.value.trim();
      if (name && selectedId) {
        await bridge.renameAccount(selectedId, name);
        toast("已重命名", "ok");
        await refreshOverview();
      }
    });
  }

  // 「遵循全局设置」开关：关闭时展开独立设置表单
  const ug = $("#use-global");
  if (ug) {
    ug.addEventListener("change", async () => {
      if (!selectedId) return;
      await bridge.setUseGlobal(selectedId, ug.checked);
      accOverrides = null; // 强制重新拉取，回落值可能变了
      toast(ug.checked ? "已切换为遵循全局设置" : "已切换为独立设置", "ok");
      await refreshOverview();
      await renderAccountView();
    });
  }

  // 仪表盘表格搜索
  const search = $("#acc-search");
  if (search) {
    search.addEventListener("input", () => {
      tableSearch = search.value;
      renderDashboard();
    });
  }
}

/** 顶部与全局按钮 */
function wireGlobalActions() {
  onClick("#btn-refresh", async () => {
    setBusy("#btn-refresh", true);
    try {
      globalCfg = null;
      accOverrides = null;
      await refreshOverview();
      if (currentView === "settings") await renderGlobalSettings();
      if (currentView === "account") await renderAccountView();
      toast("已刷新", "ok");
    } finally {
      setBusy("#btn-refresh", false);
    }
  });

  onClick("#btn-run-all", async () => {
    setBusy("#btn-run-all", true);
    try {
      const res = await bridge.runAll();
      if (!res.ok) toast(res.error || "运行失败", "err");
      else toast("全部账户运行完成", "ok");
      await refreshOverview();
    } finally {
      setBusy("#btn-run-all", false);
    }
  });

  onClick("#btn-stop", async () => {
    const res = await bridge.stop();
    if (!res || !res.ok) toast((res && res.error) || "停止失败", "err");
    else toast("已发送停止指令，正在结束当前任务…", "warn");
  });

  onClick("#btn-install-browser", async () => {
    setBusy("#btn-install-browser", true);
    try {
      const res = await bridge.installBrowser();
      toast(res.ok ? "Chromium 安装完成" : "安装失败，请查看日志", res.ok ? "ok" : "err");
    } finally {
      setBusy("#btn-install-browser", false);
    }
    await checkChromium();
  });
}

/* ==================== 日志面板 / 运行态 / 缩放 ==================== */

/** 切换日志面板显隐 */
function toggleLog(force) {
  const consoleEl = $(".log-console");
  const resizer = $("#log-resizer");
  if (!consoleEl) return;
  const willShow = force !== undefined ? force : consoleEl.classList.contains("collapsed");
  consoleEl.classList.toggle("collapsed", !willShow);
  if (resizer) resizer.classList.toggle("hidden", !willShow);
  const btn = $("#btn-toggle-log");
  if (btn) {
    btn.classList.toggle("active", willShow);
    btn.title = willShow ? "隐藏日志面板（Ctrl+`）" : "显示日志面板（Ctrl+`）";
  }
  try { localStorage.setItem("logVisible", willShow ? "1" : "0"); } catch {}
  if (willShow && autoScroll) {
    const body = $("#log-body");
    if (body) body.scrollTop = body.scrollHeight;
  }
}

/** 运行态 UI：显示/隐藏「停止」按钮，禁用运行相关按钮 */
function setRunningState(running) {
  const stopBtn = $("#btn-stop");
  if (stopBtn) stopBtn.hidden = !running;
  for (const sel of ["#btn-run", "#btn-run-all", "#btn-login", "#btn-sync"]) {
    const el = $(sel);
    if (el) el.disabled = running;
  }
  // 表格里的单账号运行按钮同步禁用
  document.querySelectorAll(".act-run").forEach((b) => (b.disabled = running));
}

/** 拖动日志窗口上方的分隔条调整高度 */
function wireLogResizer() {
  const resizer = $("#log-resizer");
  const consoleEl = $(".log-console");
  if (!resizer || !consoleEl) return;
  let dragging = false;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newHeight = window.innerHeight - e.clientY;
    const clamped = Math.max(80, Math.min(window.innerHeight - 220, newHeight));
    consoleEl.style.height = clamped + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
  });
}

/** 日志工具栏 + 快捷键 */
function wireLogTools() {
  $("#btn-clear-log").addEventListener("click", () => {
    $("#log-body").innerHTML = "";
  });
  $("#log-filter").addEventListener("input", reloadLogs);
  $("#btn-scroll-log").addEventListener("click", () => {
    autoScroll = !autoScroll;
    $("#btn-scroll-log").textContent = autoScroll ? "⤓ 自动" : "⏸ 手动";
    if (autoScroll) $("#log-body").scrollTop = $("#log-body").scrollHeight;
  });
  onClick("#btn-toggle-log", () => toggleLog());
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "`" || e.key === "l" || e.key === "L")) {
      e.preventDefault();
      toggleLog();
    }
  });
  wireLogResizer();
}

/**
 * 页面自动缩放：按窗口宽度动态调整基准字号
 * 配合 style.css 的媒体查询，让窄窗口整页等比收缩而不是出横向滚动条。
 */
function applyAutoScale() {
  const w = window.innerWidth;
  let fs = 13;
  if (w < 1180) fs = Math.max(11, 13 - (1180 - w) / 260);
  else if (w > 1500) fs = Math.min(14.5, 13 + (w - 1500) / 500);
  document.documentElement.style.setProperty("--fs-base", fs.toFixed(2) + "px");
}

function wireEvents() {
  wireModal();
  wireNav();
  wireAccountActions();
  wireGlobalActions();
  wireLogTools();

  bridge.onRunning(setRunningState);
  bridge.isRunning().then((v) => setRunningState(!!v)).catch(() => {});
  if (bridge.onAccounts) bridge.onAccounts(handleAccountsPush);
  bridge.onLog(handleLog);
}

/* ==================== 启动 ==================== */
async function init() {
  window.addEventListener("error", (e) => {
    toast("脚本错误：" + (e.message || "未知"), "err");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    toast("异步错误：" + (r && r.message ? r.message : String(r)), "err");
  });

  if (!bridge) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<div style="padding:14px;background:#f85149;color:#fff">预加载脚本未生效，无法与主进程通信。请检查 electron-preload.js。</div>'
    );
    return;
  }

  try { wireEvents(); } catch (e) { console.error(e); }

  try {
    applyAutoScale();
    let scaleTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(applyAutoScale, 80);
    });
  } catch (e) { console.error(e); }

  // 恢复日志面板显隐（默认显示）
  try {
    const saved = localStorage.getItem("logVisible");
    toggleLog(saved === null ? true : saved === "1");
  } catch { toggleLog(true); }

  // 恢复上次选中的账号，再拉数据
  try { selectedId = localStorage.getItem("accountId") || null; } catch {}

  try {
    await refreshOverview();
  } catch (e) {
    console.error(e);
    toast("加载账户失败：" + e.message, "err");
  }

  // 恢复上次所在视图（放在数据就绪之后，避免渲染空视图）
  let view = "dashboard";
  try { view = localStorage.getItem("view") || "dashboard"; } catch {}
  switchView(view);

  try { await checkChromium(); } catch (e) { console.error(e); }
  try { await reloadLogs(); } catch (e) { console.error(e); }
}

init();
