/* Mia — один экран: чат сверху, живой поток таблицей снизу.
   Правила стабильности: строки таблицы обновляются НА МЕСТЕ (новые сверху, старые не двигаются),
   в ячейки пишем только при изменении текста, цифры табличные — ничто не прыгает и не перерисовывается целиком. */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const num = (n) => (n == null ? "—" : new Intl.NumberFormat("ru-RU").format(n));
const hhmmss = (ts) => {
  try { return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false }); } catch (e) { return "—"; }
};
const shortTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
};
// обновляем текст/класс только при реальном изменении — иначе браузер зря пересчитывает вёрстку
const setTxt = (node, v) => { if (node && node.textContent !== v) node.textContent = v; };
const setCls = (node, c) => { if (node && node.className !== c) node.className = c; };

/* ---------------------------------------------------------------- тема */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("mia-theme", t); } catch (e) {}
}
(function initTheme() {
  let t = "mocha";
  try { t = localStorage.getItem("mia-theme") || localStorage.getItem("nexus-theme") || "mocha"; } catch (e) {}
  setTheme(t);
  const btn = $("theme");
  if (btn) btn.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "latte" ? "mocha" : "latte"));
})();

/* ---------------------------------------------------------------- часы */

setInterval(() => setTxt($("clock"), new Date().toLocaleTimeString("ru-RU", { hour12: false })), 1000);

/* ---------------------------------------------------------------- Мия (мини-портрет в шапке)
   Мия кормится задачами: сытость = успешные задачи за час, здоровье = ок-рейт моделей,
   скорость = p95, опыт = всего запросов. Здесь только маленький портрет и строка состояния. */
const MINI = [
  "..HHHH..",
  ".HHHHHH.",
  ".HFFFFH.",
  ".HFEFEH.",
  ".HFFFFH.",
  "..FMMF..",
  "..BBBB..",
  ".BBBBBB.",
  "..S..S..",
];
const MIA_COLORS = { H: "#8a6bbf", F: "#f3d3bd", E: "#1b1b2b", M: "#8c4a5a", B: "#89b4fa", S: "#45475a" };
let mia = { mood: "idle", hunger: 0, fed_recent: 0, idle_min: 0, name: "Мия", level: 1, reqs: 0 };
let miaFrame = 0, miaReaction = null, miaReactionUntil = 0, miaThinking = false;

function react(kind, ms = 1200) { miaReaction = kind; miaReactionUntil = Date.now() + ms; }

function drawMia() {
  const cv = $("mia-mini");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const PX = 6;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const R = Date.now() < miaReactionUntil ? miaReaction : null;
  const sleeping = mia.mood === "sleep" && !R;
  const blink = miaFrame % 34 === 0;
  const bob = R === "eat" ? ((miaFrame % 4 < 2) ? -2 : 0) : (miaFrame % 12 < 6 ? 0 : 1);
  const shake = R === "sad" ? ((miaFrame % 4 < 2) ? -1 : 1) : 0;
  const x0 = Math.round((cv.width - 8 * PX) / 2) + shake, y0 = 1 + bob;

  const cmap = Object.assign({}, MIA_COLORS);
  if (mia.mood === "hungry") cmap.B = "#6c7fb8";
  if (mia.mood === "sick") { cmap.B = "#6c7086"; cmap.E = "#c9435f"; }
  if (R === "eat" || R === "happy") cmap.M = "#1b1b2b";

  MINI.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if ((sleeping || blink) && ch === "E") return;          // закрытые глаза во сне и при моргании
      ctx.fillStyle = cmap[ch];
      ctx.fillRect(x0 + x * PX, y0 + y * PX, PX, PX);
    });
  });

  if (sleeping) {                                            // «z» — спит
    ctx.fillStyle = "#a6adc8"; ctx.font = "9px monospace";
    ctx.fillText("z", x0 + 7 * PX, y0 + 2 * PX);
  }
  if (miaThinking) {                                        // думает над ответом
    ctx.fillStyle = "#cba6f7"; ctx.font = "9px monospace";
    ctx.fillText("…", x0 + 7 * PX, y0 - 1);
  }
  if (R === "eat") {                                         // ест задачу: к ней летит зелёный пиксель
    const t = 1 - Math.max(0, miaReactionUntil - Date.now()) / 1200;
    ctx.fillStyle = "#a6e3a1";
    ctx.fillRect(x0 - 12 + t * 16, y0 + 4 * PX, PX, PX);
  }
}

const MIA_PHRASES = [
  "Жду задачу — можно что-нибудь проверить.",
  "Я рядом и слежу за очередью.",
  "Сытость в норме, но задач пока мало.",
  "Дайте мне маленькую задачу — разомнусь.",
  "Проверяю пульс системы…"
];
let miaPhraseIndex = 0;

function miaText(p) {
  const fed = `${p.fed_recent || 0} задач/час`;
  if (p.mood === "sleep") return `${p.name} спит · без работы ${p.idle_min} мин`;
  if (p.mood === "hungry") return `${p.name} голодна · без работы ${p.idle_min} мин`;
  if (p.mood === "sick") return `${p.name} приболела · модели отказывают`;
  return `${p.name} сыта ${100 - (p.hunger || 0)}% · ${fed}`;
}

function renderMiaBubbles(p) {
  const bubbles = $("mia-bubbles");
  if (!bubbles) return;
  
  // Сытость
  const hunger = $("b-hunger");
  setTxt(hunger, `${Math.round(p.hunger || 0)}%`);
  setCls(hunger, "active", p.hunger >= 80);
  
  // Настроение
  const mood = $("b-mood");
  let moodText = "—";
  if (p.mood === "hungry") moodText = "голод";
  else if (p.mood === "sick") moodText = "боль";
  else if (p.mood === "happy") moodText = "счастье";
  else if (p.mood === "sleep") moodText = "сон";
  else if (p.mood === "idle") moodText = "бодрствует";
  setTxt(mood, moodText);
  setCls(mood, "active", moodText !== "—");
  
  // Активные задачи
  const tasks = $("b-tasks");
  setTxt(tasks, p.activeTasks || "0");
  setCls(tasks, "active", p.activeTasks > 0);
}

function renderMia(p) {
  if (!p) return;
  mia = p;
  const line = $("mia-line");
  setTxt(line, MIA_PHRASES[miaPhraseIndex]);
  setCls(line, "mia-speech");
  
  // Профиль и модель принадлежат живому потоку (tickFlows). Не затираем их
  // неполным объектом pet из /api/live — иначе шапка мигала «значение → —».
  // Обновляем квоту из API
  setTxt($("h-quota"), `${num(p.quotaLeft)}/${num(p.quotaCap)}`);
  setTxt($("h-reqs"), `${num(p.reqs)} · ур. ${p.level}`);
}

/* ---------------------------------------------------------------- чат */

const chatLog = $("chat-log");
const CHAT_KEY = "mia-chat";
const CHAT_KEY_OLD = "nexus-chat";   // переписка, накопленная до переименования

function chatMessage(role, text, extra) {
  const box = el("div", "msg " + (role === "user" ? "mine" : "mia"));
  box.append(el("span", "who", role === "user" ? "ты" : (mia.name || "Мия")));
  const body = el("div", "body", text || "");
  box.append(body);
  if (extra) box.append(extra);
  return box;
}

function appendChat(node, save) {
  chatLog.append(node);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (save) saveChat();
}

function saveChat() {
  try {
    const items = [...chatLog.children].slice(-40).map((m) => ({
      role: m.classList.contains("mine") ? "user" : "mia",
      text: m.querySelector(".body")?.textContent || "",
      hits: [...m.querySelectorAll(".hit")].map((h) => h.textContent),
      meta: m.querySelector(".meta")?.textContent || "",
    }));
    localStorage.setItem(CHAT_KEY, JSON.stringify(items));
  } catch (e) { /* приватный режим — просто не сохраняем */ }
}

function loadChat() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(CHAT_KEY) || localStorage.getItem(CHAT_KEY_OLD) || "[]"); } catch (e) {}
  for (const it of items.slice(-40)) {
    const extra = el("div");
    for (const h of (it.hits || [])) extra.append(el("div", "hit", h));
    if (it.meta) extra.append(el("div", "meta", it.meta));
    chatLog.append(chatMessage(it.role, it.text, extra.children.length ? extra : null));
  }
  if (!items.length) {
    appendChat(chatMessage("mia",
      "Привет. Я Мия — живу тут и помогаю с системой. Спроси что угодно: я сначала залезу " +
      "в свою базу знаний, потом отвечу. Не найду — скажу прямо, врать не буду."));
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

/* разбор вывода `db find`: строки-заметки (·), находки `[n] вид/ключ  заголовок` и их продолжения */
function parseFind(lines) {
  const out = { notes: [], hits: [] };
  let cur = null;
  for (const raw of (lines || [])) {
    const l = String(raw).replace(/\s+$/, "");
    const m = l.match(/^\[(\d+)\]\s+(\S+)\s*(.*)$/);
    if (m) { cur = { n: m[1], kind: m[2], title: m[3] || "", body: [] }; out.hits.push(cur); continue; }
    if (/^[·•]/.test(l)) { out.notes.push(l.replace(/^[·•]\s*/, "")); continue; }
    if (/^\(/.test(l)) { out.notes.push(l); continue; }
    if (cur && l.trim()) cur.body.push(l.replace(/^\s+/, ""));
  }
  return out;
}

function renderAnswer(res, ms) {
  // Откат: модель не ответила — показываем честно то, что нашлось в базе знаний.
  const host = el("div");
  const parsed = parseFind(res && res.lines);
  if (!parsed.hits.length) {
    host.append(el("div", "empty", parsed.notes.length
      ? parsed.notes.join(" ")
      : "Ничего не нашла — и это честный ответ. Спроси иначе или скажи записать в базу."));
  } else {
    parsed.hits.forEach((h) => {
      const hit = el("div", "hit");
      const top = el("div", "top");
      top.append(el("span", null, `[${h.n}] ${h.kind} `));
      if (h.title) top.append(el("b", null, h.title));
      hit.append(top);
      h.body.forEach((ln) => hit.append(el("div", "ln" + (/^[А-ЯЁ]{4,}/.test(ln) ? " lead" : ""), ln)));
      host.append(hit);
    });
  }
  const meta = el("div", "meta");
  meta.textContent = `поиск в базе · фрагментов ${parsed.hits.length} · ${ms} мс`;
  host.append(meta);
  return host;
}

/* ответ Мии из /api/chat: живой текст модели плюс ссылка на источники */
function renderChat(res, ms, fallbackNote) {
  const host = el("div");
  const src = (res && res.sources) || [];
  const bits = [];
  if (res && res.model) bits.push("модель " + String(res.model).split("/").pop());
  bits.push(`${ms} мс`);
  // откуда ответ: из базы знаний (перечисляем записи) или Мия ответила сама
  const sim = res && typeof res.bestSim === "number" ? res.bestSim.toFixed(2) : null;
  if (res && res.usedBase && src.length) bits.push(`источники из базы (${src.length}${sim ? ", сходство " + sim : ""}): ${src.join(", ")}`);
  else if (src.length) bits.push(`ответила сама — в базе только слабое совпадение${sim ? " (сходство " + sim + ")" : ""}`);
  else bits.push("ответила сама — в базе по этому вопросу ничего не нашлось");
  if (res && res.error) bits.push("модель молчит: " + res.error.slice(0, 60));
  // задача, поставленная Мией из разговора
  if (res && res.task) {
    bits.push(res.task.ok
      ? `задача ${res.task.n} поставлена${res.task.mode ? " (" + TASK_MODE[res.task.mode] + ")" : ""}`
      : "задачу поставить не смогла: " + String(res.task.error || "ошибка").slice(0, 60));
  }
  const meta = el("div", "meta", bits.join(" · "));
  host.append(meta);
  if (fallbackNote) host.prepend(el("div", "empty", fallbackNote));
  return host;
}

let asking = false;
const TYPE_LINE = ["печатает", "ищет в базе", "думает"];

$("composer").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("q").value.trim();
  if (!q || asking) return;
  asking = true;
  $("ask").disabled = true;
  $("q").value = "";
  appendChat(chatMessage("user", q), true);

  // пока она думает — показываем это прямо в ленте (и она это «переживает» аватаром)
  const pending = chatMessage("mia", "");
  const dots = el("div", "typing");
  let tick = 0;
  dots.textContent = "Мия " + TYPE_LINE[0] + "…";
  pending.querySelector(".body").append(dots);
  appendChat(pending, false);
  miaThinking = true;
  const spin = setInterval(() => {
    tick++;
    dots.textContent = "Мия " + TYPE_LINE[tick % TYPE_LINE.length] + "…";
  }, 900);

  const t0 = Date.now();
  let res = null;
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }) });
    res = await r.json();
  } catch (e) {
    res = { answer: "", error: String(e.message || e).slice(0, 80), lines: [], sources: [] };
  }
  clearInterval(spin);
  miaThinking = false;
  const ms = Date.now() - t0;

  const note = res && res.answer ? null : "Модель не ответила — вот что я нашла в базе сама:";
  const extra = res && res.answer
    ? renderChat(res, ms, null)
    : (() => { const box = renderAnswer(res, ms); box.prepend(renderChat(res, ms, note).firstChild); return box; })();

  pending.remove();
  appendChat(chatMessage("mia", (res && res.answer) || "", extra), true);
  if (res && res.answer) react("happy", 900);
  if (res && res.task && res.task.ok) setTimeout(tickTasks, 200);   // новая задача — сразу в панель

  asking = false;
  $("ask").disabled = false;
  $("q").focus();
});

/* ---------------------------------------------------------------- живой поток (таблица строк)
   Одна строка = одна попытка. Новые строки появляются сверху, существующие не двигаются:
   так лента читается как журнал и ничего не прыгает при обновлении. */

const STATUS = {
  ok: ["ок", "st-ok"],
  empty: ["пусто", "st-empty"],
  fail: ["отказ", "st-fail"],
  exhausted: ["исчерпана", "st-fail"],
  loop_detected: ["цикл", "st-empty"],
  nudge: ["подсказка", "st-off"],
  compacted: ["сжатие", "st-sq"],
};
const MAX_ROWS = 60;
const flowRows = new Map();       // ключ `rid:n` → {tr, cells}
const flowBody = $("flow-body");

function makeRow() {
  const tr = el("tr");
  const cells = {
    time: el("td", "c-time"), prof: el("td", "c-prof"), step: el("td", "c-step"),
    stat: el("td", "c-stat"), ms: el("td", "c-ms"), note: el("td", "c-note"),
  };
  Object.values(cells).forEach((c) => tr.append(c));
  return { tr, cells };
}

function noteFor(f, s) {
  const bits = [];
  if (f.squeezed) bits.push(`сжатие ${shortTok(f.squeezed.before)}→${shortTok(f.squeezed.after)}`);
  if (f.waited) bits.push(`ожидание ${f.waited.sec} с`);
  if (s.escalated) bits.push("эскалация");
  if (s.attempt > 1 && !s.escalated) bits.push(`попытка ${s.attempt}`);
  return bits.join(" · ");
}

function updateFlow(flows) {
  const wanted = [];
  for (const f of flows) {
    (f.steps || []).forEach((s, i) => wanted.push({ key: `${f.rid}:${s.n}`, f, s, first: i === 0 }));
  }
  const seen = new Set();
  let prevTr = null;
  for (const w of wanted) {
    seen.add(w.key);
    let row = flowRows.get(w.key);
    if (!row) {                                  // новая попытка — вставляем сразу после предыдущей
      row = makeRow();
      flowRows.set(w.key, row);
      flowBody.insertBefore(row.tr, prevTr ? prevTr.nextSibling : flowBody.firstChild);
      row.tr.classList.add("grp");
    }
    prevTr = row.tr;
    const c = row.cells;
    setTxt(c.time, hhmmss(w.s.ts || w.f.ts));
    setTxt(c.prof, w.first ? (w.f.profile || "—") : "");
    const [label, cls] = STATUS[w.s.status] || [String(w.s.status || "—"), "st-off"];
    setTxt(c.step, w.s.rung || w.s.status || "—");
    if (c.step.title !== (w.s.rung || "")) c.step.title = w.s.rung || "";
    setTxt(c.stat, label);
    setCls(c.stat, `c-stat ${cls}`);
    setTxt(c.ms, w.s.ms ? `${w.s.ms}` : "—");
    setTxt(c.note, noteFor(w.f, w.s) || "—");   // прочерк вместо пустоты: бумажная таблица не оставляет дыр
    setCls(row.tr, w.first ? "grp" : "");
  }
  // лишние строки (старше, чем показываем) убираем снизу, чтобы таблица не росла бесконечно
  const keys = [...flowRows.keys()];
  for (const k of keys) {
    if (seen.has(k)) continue;
    const row = flowRows.get(k);
    row.tr.remove();
    flowRows.delete(k);
  }
  let count = flowRows.size;
  while (count > MAX_ROWS) {
    const oldest = [...flowRows.entries()].pop();
    oldest[1].tr.remove();
    flowRows.delete(oldest[0]);
    count--;
  }
}

let flowTimer = null;
async function tickFlows() {
  try {
    const r = await fetch("/api/flows?limit=12");
    const d = await r.json();
    const flows = d.flows || [];
    updateFlow(flows);
    const last = flows[0];
    let n = 0;
    for (const f of flows) n += (f.steps || []).length;
    setTxt($("flow-meta"), last ? `последний ${last.at} · ${last.profile} · ${last.status} · строк ${n}` : "пока нет записей");
    if (last) {                                   // шапка: чем реально работает система
      setTxt($("h-profile"), last.profile || "—");
      const ok = (last.steps || []).filter((s) => s.status === "ok").pop();
      setTxt($("h-model"), ok ? String(ok.rung).split("/").pop() : "—");
    }
  } catch (e) { /* роутер молчит — таблица остаётся как была */ }
}
function scheduleFlowRefresh() { clearTimeout(flowTimer); flowTimer = setTimeout(tickFlows, 350); }

/* ---------------------------------------------------------------- живой поток событий */

let es = null;
function startStream() {
  try {
    es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (!["request", "attempt", "ok", "fail", "squeeze", "escalate", "wait-decision", "nudge"].includes(d.type)) return;
        scheduleFlowRefresh();
        if (d.type === "ok") react("eat");
        else if (d.type === "fail" || d.type === "empty") react("sad");
      } catch (e) { /* не событие — пропускаем */ }
    };
  } catch (e) { /* останется опрос */ }
}

/* ---------------------------------------------------------------- ЗАДАЧИ МИИ
   Задачи ставит только Мия (из чата) — кнопки создания здесь нет намеренно.
   Строки обновляются на месте: новые сверху, старые не двигаются. */
const TASK_ST = {
  new: ["ждёт", "st-new"], queued: ["в очереди", "st-queued"], running: ["работает", "st-running"],
  ok: ["готово", "st-ok"], failed: ["ошибка", "st-fail"], cancelled: ["отменена", "st-off"],
};
const TASK_MODE = { read: "чтение", edit: "правка", full: "полный" };
const taskRows = new Map();
const tasksBody = $("tasks-body");

function taskRow() {
  const tr = el("tr");
  const c = { stat: el("td", "t-stat"), title: el("td", "t-title"), model: el("td", "t-model"),
              time: el("td", "t-time"), act: el("td", "t-act") };
  Object.values(c).forEach((x) => tr.append(x));
  return { tr, c };
}

function taskElapsed(t) {
  if (!t.started_at) return "—";
  try {
    const start = new Date(String(t.started_at).replace(" ", "T")).getTime();
    const end = t.ended_at ? new Date(String(t.ended_at).replace(" ", "T")).getTime() : Date.now();
    const sec = Math.max(0, Math.round((end - start) / 1000));
    return t.ended_at ? `${sec} с` : `${sec} с…`;
  } catch (e) { return "—"; }
}

function renderTasks(list, settings) {
  const seen = new Set();
  let prev = null;
  for (const t of list) {
    const key = t.n || String(t.id);
    seen.add(key);
    let row = taskRows.get(key);
    if (!row) {
      row = taskRow();
      taskRows.set(key, row);
      tasksBody.insertBefore(row.tr, prev ? prev.nextSibling : tasksBody.firstChild);
    }
    prev = row.tr;
    const [label, cls] = TASK_ST[t.status] || [t.status || "—", "st-off"];
    setTxt(row.c.stat, label); setCls(row.c.stat, "t-stat " + cls);
    setTxt(row.c.title, `${key} · ${t.title || ""}`);
    setTxt(row.c.model, String(t.model || "").replace("ladder/", ""));
    setTxt(row.c.time, taskElapsed(t));
    // кнопки: ▶ старт для ждущих, ✕ отмена для тех, кого можно остановить
    const acts = [];
    if (t.status === "new") acts.push(["▶", "start", ""]);                       // запустить
    if (["new", "queued", "running"].includes(t.status)) acts.push(["✕", "cancel", "kill"]);   // отменить
    if (["ok", "failed", "cancelled"].includes(t.status)) acts.push(["↻", "start", "repeat"]); // повторить
    const sig = acts.map((a) => a[1]).join(",");
    if (row.c.act.dataset.sig !== sig) {
      row.c.act.dataset.sig = sig;
      row.c.act.textContent = "";
      for (const [glyph, action, extra] of acts) {
        const b = el("button", ("act " + extra).trim(), glyph);
        b.type = "button";
        b.dataset.id = key;
        b.dataset.action = action;
        b.title = action === "cancel" ? "отменить задачу"
                  : extra === "repeat" ? "повторить задачу" : "запустить задачу";
        row.c.act.append(b);
      }
    }
  }
  for (const [k, row] of [...taskRows]) if (!seen.has(k)) { row.tr.remove(); taskRows.delete(k); }

  const c = { new: 0, queued: 0, running: 0, ok: 0, failed: 0, cancelled: 0 };
  for (const t of list) c[t.status] = (c[t.status] || 0) + 1;
  setTxt($("tasks-meta"), list.length
    ? `работает ${c.running} · ждут ${c.new + c.queued} · готово ${c.ok}${c.failed ? " · упало " + c.failed : ""}`
    : "пока нет задач — их ставит Мия в чате");

  if (settings) {
    const a = $("sw-auto"), m = $("sw-mode");
    setTxt(a, settings.auto ? "авто вкл" : "авто выкл");
    setCls(a, "sw" + (settings.auto ? " on" : ""));
    setTxt(m, "режим: " + (TASK_MODE[settings.mode] || settings.mode || "—"));
    setCls(m, "sw" + (settings.mode === "read" ? " warn" : ""));
  }
}

async function tickTasks() {
  try {
    const r = await fetch("/api/tasks");
    const d = await r.json();
    renderTasks(d.tasks || [], d.settings || null);
    const modeBtn = $("mia-mode-toggle");
    if (modeBtn && d.mia && (d.mia.mode === "chat" || d.mia.mode === "agent")) {
      setTxt(modeBtn, d.mia.mode === "agent" ? "агент" : "чат");
      setCls(modeBtn, "mia-mode-switch" + (d.mia.mode === "agent" ? " agent" : ""));
      modeBtn.title = d.mia.mode === "agent" ? "Мия работает как агент — нажмите для режима болтания" : "Мия болтает — нажмите для режима агента";
    }
    // Передаём количество активных задач в облачко
    if (d.pet) {
      renderMiaBubbles(d.pet);
    }
  } catch (e) { /* база молчит — панель остаётся как была */ }
}

$("tasks-body").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button.act");
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    await fetch("/api/task", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.dataset.id, action: b.dataset.action }) });
  } catch (e) {}
  setTimeout(tickTasks, 300);
});

$("sw-auto").addEventListener("click", async () => {
  const cur = $("sw-auto").classList.contains("on");
  try {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: !cur }) });
  } catch (e) {}
  setTimeout(tickTasks, 200);
});

$("sw-mode").addEventListener("click", async () => {
  const order = ["read", "edit", "full"];
  const txt = $("sw-mode").textContent.replace("режим: ", "").trim();
  const cur = order.find((m) => TASK_MODE[m] === txt) || "edit";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  try {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }) });
  } catch (e) {}
  setTimeout(tickTasks, 200);
});

$("mia-mode-toggle").addEventListener("click", async () => {
  const btn = $("mia-mode-toggle");
  const isCurrentlyAgent = btn.textContent.trim() === "агент";
  const nextMode = isCurrentlyAgent ? "chat" : "agent";
  let ok = false;
  try {
    const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mia_mode: nextMode }) });
    const d = await r.json();
    ok = d.ok !== false && d.mia && d.mia.mode === nextMode;
  } catch (e) {}
  if (ok) {
    setTxt(btn, isCurrentlyAgent ? "чат" : "агент");
    setCls(btn, "mia-mode-switch" + (isCurrentlyAgent ? "" : " agent"));
    btn.title = isCurrentlyAgent ? "Мия болтает — нажмите для режима агента" : "Мия работает как агент — нажмите для режима болтания";
  }
  setTimeout(tickTasks, 200);
});
/* ---------------------------------------------------------------- опрос */

async function tickLive() {
  try {
    const r = await fetch("/api/live");
    const d = await r.json();
    renderMia(d.pet || d); // Используем pet или сам объект, если pet отсутствует
    // Передаём данные в облачко
    if (d.pet) {
      renderMiaBubbles(d.pet);
    }
  } catch (e) { /* тихо: покажем прошлое состояние */ }
}

/* ---------------------------------------------------------------- канал команд
   Страница забирает команды (JS) и возвращает результат: так интерфейс проверяется
   ровно так, как им пользуется человек — набор текста, нажатие кнопок. */
const uiDone = new Set();          // страховка: одну команду не выполняем дважды даже при сбое сервера
async function pumpUI() {
  try {
    const r = await fetch("/api/ui");
    const d = await r.json();
    for (const c of (d.commands || [])) {
      if (uiDone.has(c.id)) continue;
      uiDone.add(c.id);
      let value = "", ok = true;
      try { value = String(eval(c.js)); }        // eslint-disable-line no-eval
      catch (e) { ok = false; value = String((e && e.message) || e); }
      try {
        await fetch("/api/ui/result", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: c.id, ok, value: value.slice(0, 2000) }) });
      } catch (e) {}
    }
  } catch (e) { /* канал недоступен — это не ошибка страницы */ }
}
setInterval(pumpUI, 1000);

/* ---------------------------------------------------------------- старт */

loadChat();
startStream();
tickLive();
tickFlows();
setInterval(tickLive, 5000);
setInterval(() => {
  if (!miaThinking && $("mia-line")) {
    miaPhraseIndex = (miaPhraseIndex + 1) % MIA_PHRASES.length;
    setTxt($("mia-line"), MIA_PHRASES[miaPhraseIndex]);
  }
}, 12000);
setInterval(tickFlows, 3000);
tickTasks();
setInterval(tickTasks, 3000);
setInterval(() => { miaFrame++; drawMia(); }, 400);
drawMia();
$("q").focus();

/* горячая перезагрузка: сервер отдаёт отпечаток статики, при изменении перезагружаем страницу */
let version = null;
async function checkVersion() {
  try {
    const r = await fetch("/api/version");
    const v = (await r.text()).trim();
    if (version && v !== version) location.reload();
    version = v;
  } catch (e) {}
}
setInterval(checkVersion, 1000);
