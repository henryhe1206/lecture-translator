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

let docs = []; // { name, digest }
const transcript = JSON.parse(localStorage.getItem("transcript") || "[]"); // { en, zh }

// ---------- UI helpers ----------
let statusTimer;
function status(msg, ms = 3000) {
  const el = $("status");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- IndexedDB (handouts) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("lecture-handouts", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("docs", { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("docs", mode);
    const req = fn(tx.objectStore("docs"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbAll = () => dbRun("readonly", (s) => s.getAll());
const dbPut = (doc) => dbRun("readwrite", (s) => s.put(doc));
const dbDelete = (name) => dbRun("readwrite", (s) => s.delete(name));

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

function renderDocs() {
  const list = $("doc-list");
  list.replaceChildren();
  for (const d of docs) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="name"></span><span class="state">要点已生成</span><button>删除</button>';
    li.querySelector(".name").textContent = d.name;
    li.querySelector("button").onclick = async () => {
      await dbDelete(d.name);
      docs = docs.filter((x) => x.name !== d.name);
      renderDocs();
    };
    list.appendChild(li);
  }
  $("btn-handouts").textContent = docs.length ? `讲义 (${docs.length})` : "讲义";
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
      const doc = { name: file.name, digest };
      await dbPut(doc);
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

// ---------- Translation ----------
function buildSystem() {
  const handout = docs.map((d) => `## ${d.name}\n${d.digest}`).join("\n\n");
  return [
    "You are a simultaneous interpreter at a university mathematics lecture, translating English speech into Simplified Chinese.",
    "The input is automatic speech recognition output. The recogniser often replaces technical terms with similar-sounding ordinary words (for example 'investors' for 'inverses', 'ortho final' for 'orthogonal', 'dot protect' for 'dot product').",
    "First correct the segment: if a word makes no sense in a mathematics lecture, replace it with the most similar-sounding term that fits the context, using the handout briefing, the previous speech and your mathematical knowledge. Change as little as possible; do not rewrite correct words.",
    "Then translate the corrected segment. Each segment is a fragment of continuous speech and may start or end mid-sentence; translate it fluently as a continuation of the previous speech, without repeating earlier translations.",
    "Use standard Chinese mathematical terminology. Keep formulas and symbols as written.",
    "Reply in exactly this format, with no other text:",
    "EN: <corrected English segment>",
    "ZH: <Chinese translation>",
    handout ? `\nHandout briefing:\n${handout}` : "",
  ].join("\n");
}

const subList = $("sub-list");

function persist() {
  localStorage.setItem("transcript", JSON.stringify(transcript));
}

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
  const context = transcript.slice(-3).map((s) => s.en).join(" ");
  const entry = { en, zh: "" };
  transcript.push(entry);
  const box = makeBox(entry);
  translate(entry, box, context);
}

async function translate(entry, box, context) {
  try {
    const reply = await claude({
      model: settings.translateModel,
      system: buildSystem(),
      user: `Previous speech (context only, do not translate):\n${context || "(none)"}\n\nCorrect and translate this segment:\n${entry.en}`,
      maxTokens: 500,
    });
    const match = reply.match(/^EN:\s*(.*?)\s*\n\s*ZH:\s*([\s\S]+)$/);
    if (!match) throw new Error(`模型返回格式不对：${reply}`);
    entry.en = match[1];
    entry.zh = match[2].trim();
    persist();
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
$("btn-summary").onclick = async () => {
  if (!settings.key) return status("请先在设置里填写 API Key");
  if (!transcript.length) return status("还没有听课记录");
  const body = $("summary-body");
  body.textContent = "正在生成总结…";
  $("dlg-summary").showModal();
  try {
    const handout = docs.map((d) => `## ${d.name}\n${d.digest}`).join("\n\n");
    body.textContent = await claude({
      model: settings.summaryModel,
      maxTokens: 4000,
      system: "You summarise university lectures for a student, in Simplified Chinese.",
      user: [
        "Below is the automatic speech transcript of a lecture (English, may contain recognition errors in mathematical terms) and, if available, a briefing on the lecture handouts.",
        "Write a clear summary in Simplified Chinese with these sections:",
        "1. 本课主题",
        "2. 核心知识点（定义、公式、定理，公式保持原样书写）",
        "3. 例题与推导思路",
        "4. 老师强调的重点、易错点、作业或考试提示（没有则写“无”）",
        "5. 课后需要复习的内容",
        "Only include what the lecturer actually said; do not add material from the handout that was not covered.",
        handout ? `\nHandout briefing:\n${handout}` : "",
        `\nTranscript:\n${transcript.map((s) => s.en).join(" ")}`,
      ].join("\n"),
    });
  } catch (err) {
    body.textContent = `总结失败：${err.message}`;
  }
};
$("btn-summary-close").onclick = () => $("dlg-summary").close();
$("btn-summary-copy").onclick = async () => {
  await navigator.clipboard.writeText($("summary-body").textContent);
  status("已复制");
};

// ---------- Misc controls ----------
$("chk-en").addEventListener("change", (e) => subList.classList.toggle("hide-en", !e.target.checked));
$("btn-clear").onclick = () => {
  if (!confirm("清空所有听课记录？")) return;
  transcript.length = 0;
  persist();
  subList.replaceChildren();
};

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
  docs = await dbAll();
  renderDocs();
  transcript.forEach(makeBox);
})();
