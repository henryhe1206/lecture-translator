import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_HANDOUT_CHARS = 250000;
const PHRASE_WORDS = 10;
const PAUSE_MS = 1200;

const settings = {
  key: localStorage.getItem("key") || "",
  translateModel: localStorage.getItem("translateModel") || "claude-haiku-4-5-20251001",
  summaryModel: localStorage.getItem("summaryModel") || "claude-sonnet-5-5",
  lang: localStorage.getItem("lang") || "en-GB",
};

let docs = [];      // { name, digest, enabled }
let sessions = [];  // { id, title, created, entries: [{ en, zh }], summary }
let session = null; // the session currently being recorded / displayed

// ---------- UI helpers ----------
let statusTimer;
function status(msg, ms = 3000) {
  const el = $("status");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("lecture-handouts", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "name" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbRun(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbAll = (store) => dbRun(store, "readonly", (s) => s.getAll());
const dbPut = (store, value) => dbRun(store, "readwrite", (s) => s.put(value));
const dbDelete = (store, key) => dbRun(store, "readwrite", (s) => s.delete(key));

// ---------- Claude ----------
async function claude({ model, system, user, maxTokens }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((b) => b.text || "").join("").trim();
}

// ---------- Handouts ----------
async function extractText(file) {
  const loaded = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts = [];
  for (let i = 1; i <= loaded.numPages; i++) {
    const content = await (await loaded.getPage(i)).getTextContent();
    parts.push(content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim());
  }
  return parts.join("\n\n").slice(0, MAX_HANDOUT_CHARS);
}

function makeDigest(text) {
  return claude({
    model: settings.summaryModel,
    maxTokens: 2500,
    system: "You prepare briefing notes that help a live interpreter translate a university lecture from English to Simplified Chinese.",
    user: [
      "Below is the text of a handout for an upcoming lecture. Write a briefing (at most 900 words) with:",
      "1. The subject and an outline of the topics covered.",
      "2. A glossary of key terms, symbols and names with their standard Chinese translations (format: English = 中文).",
      "3. Notation conventions used (for example how vectors or matrices are written).",
      "",
      text,
    ].join("\n"),
  });
}

const activeDocs = () => docs.filter((d) => d.enabled);
const handoutBriefing = () => activeDocs().map((d) => `## ${d.name}\n${d.digest}`).join("\n\n");

function renderDocs() {
  const list = $("doc-list");
  list.replaceChildren();
  for (const d of docs) {
    const li = document.createElement("li");
    li.innerHTML = '<input type="checkbox"><span class="name"></span><button>删除</button>';
    const box = li.querySelector("input");
    box.checked = d.enabled;
    box.onchange = async () => {
      d.enabled = box.checked;
      await dbPut("docs", d);
      renderDocs();
    };
    li.querySelector(".name").textContent = d.name;
    li.querySelector("button").onclick = async () => {
      await dbDelete("docs", d.name);
      docs = docs.filter((x) => x.name !== d.name);
      renderDocs();
    };
    list.appendChild(li);
  }
  $("btn-handouts").textContent = docs.length ? `讲义 (${activeDocs().length}/${docs.length})` : "讲义";
}

$("file-pdf").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  if (!settings.key) return status("请先在设置里填写 API Key");
  for (const file of files) {
    try {
      status(`正在处理 ${file.name}…`, 0);
      const digest = await makeDigest(await extractText(file));
      const doc = { name: file.name, digest, enabled: true };
      await dbPut("docs", doc);
      docs = docs.filter((x) => x.name !== doc.name).concat(doc);
      renderDocs();
      status(`${file.name} 已处理`);
    } catch (err) {
      status(`${file.name} 处理失败：${err.message}`, 8000);
    }
  }
});

$("btn-handouts").onclick = () => $("dlg-handouts").showModal();
$("btn-handouts-close").onclick = () => $("dlg-handouts").close();

// ---------- Sessions ----------
const subList = $("sub-list");

function defaultTitle() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

async function createSession(title) {
  const s = { id: Date.now(), title, created: Date.now(), entries: [], summary: "" };
  await dbPut("sessions", s);
  sessions.push(s);
  return s;
}

async function openSession(s) {
  session = s;
  localStorage.setItem("currentSession", String(s.id));
  $("session-title").textContent = `当前课程：${s.title}`;
  subList.replaceChildren();
  s.entries.forEach((entry) => makeBox(entry));
  subList.scrollTop = subList.scrollHeight;
}

$("btn-new").onclick = async () => {
  const title = prompt("这节课的名称（例如：数学 Lecture 3）", defaultTitle());
  if (title === null) return;
  await openSession(await createSession(title.trim() || defaultTitle()));
};

function renderSessions() {
  const list = $("session-list");
  list.replaceChildren();
  for (const s of [...sessions].sort((a, b) => b.created - a.created)) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="name"><span class="t"></span><span class="meta"></span></span><button class="open">打开</button><button class="sum">总结</button><button class="del">删除</button>';
    li.querySelector(".t").textContent = s.id === session.id ? `${s.title}（当前）` : s.title;
    li.querySelector(".meta").textContent = `${new Date(s.created).toLocaleString("zh-CN", { hour12: false })} · ${s.entries.length} 段${s.summary ? " · 已有总结" : ""}`;
    li.querySelector(".open").onclick = async () => {
      await openSession(s);
      $("dlg-history").close();
    };
    li.querySelector(".sum").onclick = () => {
      $("dlg-history").close();
      showSummary(s);
    };
    li.querySelector(".del").onclick = async () => {
      if (!confirm(`删除“${s.title}”？`)) return;
      await dbDelete("sessions", s.id);
      sessions = sessions.filter((x) => x.id !== s.id);
      if (s.id === session.id) await openSession(await createSession(defaultTitle()));
      renderSessions();
    };
    list.appendChild(li);
  }
}

$("btn-history").onclick = () => {
  renderSessions();
  $("dlg-history").showModal();
};
$("btn-history-close").onclick = () => $("dlg-history").close();

// ---------- Translation ----------
function buildSystem() {
  const handout = handoutBriefing();
  return [
    "You are a simultaneous interpreter at a university lecture, translating English speech into Simplified Chinese.",
    "The input is automatic speech recognition output. The recogniser often replaces technical terms with similar-sounding ordinary words (for example 'investors' for 'inverses', 'ortho final' for 'orthogonal', 'dot protect' for 'dot product').",
    "First correct the segment: if a word makes no sense in the subject of the lecture, replace it with the most similar-sounding term that fits the context, using the handout briefing, the previous speech and your subject knowledge. Change as little as possible; do not rewrite correct words.",
    "Then translate the corrected segment. Each segment is a fragment of continuous speech and may start or end mid-sentence; translate it fluently as a continuation of the previous speech, without repeating earlier translations.",
    "Translate ONLY the words that are in the segment. Never complete the sentence, never anticipate what the lecturer will say next, and never add content from the handout, even if the segment is the beginning of a sentence you recognise from the handout. The handout is only for correcting recognition errors in terms. The next words will arrive as the next segment.",
    "Use standard Chinese terminology of the subject. Keep formulas and symbols as written.",
    "Reply in exactly this format, with no other text:",
    "EN: <corrected English segment>",
    "ZH: <Chinese translation>",
    handout ? `\nHandout briefing:\n${handout}` : "",
  ].join("\n");
}

const saveSession = (s) => dbPut("sessions", s);

function makeBox(entry) {
  const box = document.createElement("div");
  box.className = "sub";
  box.innerHTML = '<div class="zh"></div><div class="en"></div>';
  box.querySelector(".en").textContent = entry.en;
  setZh(box, entry.zh || "…", !entry.zh);
  const nearBottom = subList.scrollHeight - subList.scrollTop - subList.clientHeight < 80;
  subList.appendChild(box);
  if (nearBottom) subList.scrollTop = subList.scrollHeight;
  return box;
}

function setZh(box, text, pending = false, error = false) {
  const zh = box.querySelector(".zh");
  zh.textContent = text;
  zh.classList.toggle("pending", pending);
  zh.classList.toggle("error", error);
}

function enqueue(en) {
  const owner = session;
  const context = owner.entries.slice(-3).map((s) => s.en).join(" ");
  const entry = { en, zh: "" };
  owner.entries.push(entry);
  translate(owner, entry, makeBox(entry), context);
}

async function translate(owner, entry, box, context) {
  try {
    const reply = await claude({
      model: settings.translateModel,
      system: buildSystem(),
      user: `Previous speech (context only, do not translate):\n${context || "(none)"}\n\nCorrect and translate this segment (only these words, do not complete the sentence):\n${entry.en}`,
      maxTokens: 500,
    });
    const match = reply.match(/^EN:\s*(.*?)\s*\n\s*ZH:\s*([\s\S]+)$/);
    if (!match) throw new Error(`模型返回格式不对：${reply}`);
    entry.en = match[1];
    entry.zh = match[2].trim();
    await saveSession(owner);
    box.querySelector(".en").textContent = entry.en;
    setZh(box, entry.zh);
  } catch (err) {
    setZh(box, `翻译失败：${err.message}`, false, true);
  }
  const nearBottom = subList.scrollHeight - subList.scrollTop - subList.clientHeight < 120;
  if (nearBottom) subList.scrollTop = subList.scrollHeight;
}

// ---------- Speech recognition ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let sent = {};        // result index -> number of words already dispatched
let latest = null;    // { i, text } of the most recent result
let pauseTimer;

// Dispatches complete phrases from result i: at the last comma/period, or after PHRASE_WORDS words.
// With force (a pause or a final result), everything not yet dispatched goes out.
function dispatch(i, text, force) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const from = sent[i] || 0;
  if (words.length <= from) return;
  const pending = words.slice(from);
  let cut = 0;
  if (force) {
    cut = pending.length;
  } else {
    for (let k = 3; k < pending.length; k++) if (/[,.;:?!]$/.test(pending[k])) cut = k + 1;
    if (!cut && pending.length >= PHRASE_WORDS) cut = pending.length;
  }
  if (!cut) return;
  sent[i] = from + cut;
  enqueue(pending.slice(0, cut).join(" "));
}

function startListening() {
  if (!SpeechRecognition) return status("此浏览器不支持语音识别，请使用 Safari", 6000);
  if (!settings.key) return status("请先在设置里填写 API Key");
  listening = true;
  $("btn-record").textContent = "停止";
  $("btn-record").classList.add("on");
  keepAwake(true);
  beginRecognition();
  status("正在听…（说话后下方会出现灰色文字）", 2500);
}

function beginRecognition() {
  sent = {};
  latest = null;
  recognition = new SpeechRecognition();
  recognition.lang = settings.lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      dispatch(i, text, e.results[i].isFinal);
      latest = { i, text };
    }
    const rest = latest.text.trim().split(/\s+/).slice(sent[latest.i] || 0).join(" ");
    $("interim").textContent = rest;
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => dispatch(latest.i, latest.text, true), PAUSE_MS);
  };
  recognition.onerror = (e) => {
    if (e.error === "no-speech") return;
    status(`语音识别错误：${e.error}${e.message ? `（${e.message}）` : ""}`, 8000);
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "network" || e.error === "audio-capture") {
      stopListening();
    }
  };
  recognition.onend = () => {
    clearTimeout(pauseTimer);
    if (latest) dispatch(latest.i, latest.text, true);
    $("interim").textContent = "";
    if (listening) beginRecognition();
  };
  recognition.start();
}

function stopListening() {
  listening = false;
  clearTimeout(pauseTimer);
  if (recognition) recognition.stop();
  keepAwake(false);
  $("btn-record").textContent = "开始听课";
  $("btn-record").classList.remove("on");
}

$("btn-record").onclick = () => (listening ? stopListening() : startListening());

// ---------- Keep screen awake while listening ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on) {
      wakeLock = await navigator.wakeLock.request("screen");
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    console.warn("wake lock unavailable:", err);
  }
}
document.addEventListener("visibilitychange", () => {
  if (listening && document.visibilityState === "visible") keepAwake(true);
});

// ---------- Summary ----------
let summaryTarget = null;

async function generateSummary(s) {
  const body = $("summary-body");
  body.textContent = "正在生成总结…";
  try {
    const handout = handoutBriefing();
    s.summary = await claude({
      model: settings.summaryModel,
      maxTokens: 4000,
      system: "You summarise university lectures for a student, in Simplified Chinese.",
      user: [
        "Below is the automatic speech transcript of a lecture (English, corrected where possible but it may still contain recognition errors in technical terms) and, if available, a briefing on the lecture handouts.",
        "Write a clear summary in Simplified Chinese with these sections:",
        "1. 本课主题",
        "2. 核心知识点（定义、公式、定理，公式保持原样书写）",
        "3. 例题与推导思路",
        "4. 老师强调的重点、易错点、作业或考试提示（没有则写“无”）",
        "5. 课后需要复习的内容",
        "Only include what the lecturer actually said; do not add material from the handout that was not covered.",
        handout ? `\nHandout briefing:\n${handout}` : "",
        `\nTranscript:\n${s.entries.map((x) => x.en).join(" ")}`,
      ].join("\n"),
    });
    await saveSession(s);
    if (summaryTarget === s) body.textContent = s.summary;
  } catch (err) {
    if (summaryTarget === s) body.textContent = `总结失败：${err.message}`;
  }
}

function showSummary(s) {
  if (!settings.key) return status("请先在设置里填写 API Key");
  if (!s.entries.length) return status("这节课还没有听课记录");
  summaryTarget = s;
  $("summary-title").textContent = `课堂总结：${s.title}`;
  $("dlg-summary").showModal();
  if (s.summary) $("summary-body").textContent = s.summary;
  else generateSummary(s);
}

$("btn-summary").onclick = () => showSummary(session);
$("btn-summary-redo").onclick = () => generateSummary(summaryTarget);
$("btn-summary-close").onclick = () => $("dlg-summary").close();
$("btn-summary-copy").onclick = async () => {
  await navigator.clipboard.writeText($("summary-body").textContent);
  status("已复制");
};

// ---------- Misc controls ----------
$("chk-en").addEventListener("change", (e) => subList.classList.toggle("hide-en", !e.target.checked));

// ---------- Settings ----------
$("btn-settings").onclick = () => {
  $("set-key").value = settings.key;
  $("set-translate-model").value = settings.translateModel;
  $("set-summary-model").value = settings.summaryModel;
  $("set-lang").value = settings.lang;
  $("dlg-settings").showModal();
};
$("dlg-settings").addEventListener("close", () => {
  if ($("dlg-settings").returnValue !== "save") return;
  settings.key = $("set-key").value.trim();
  settings.translateModel = $("set-translate-model").value.trim();
  settings.summaryModel = $("set-summary-model").value.trim();
  settings.lang = $("set-lang").value.trim();
  for (const k of Object.keys(settings)) localStorage.setItem(k, settings[k]);
  status("设置已保存");
});

// ---------- Startup ----------
(async () => {
  docs = await dbAll("docs");
  sessions = await dbAll("sessions");
  renderDocs();
  const saved = sessions.find((s) => String(s.id) === localStorage.getItem("currentSession"));
  await openSession(saved || (await createSession(defaultTitle())));
})();
