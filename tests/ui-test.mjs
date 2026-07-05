/* ============================================================
   annual-todo UI自動テスト
   Firebaseをモック化し、jsdom上でアプリを実際に描画して
   主要フロー（ホーム/リスト/恒例展開/検索/Undo/ics/実施率）を検証する。

   実行: npm test  （または node tests/ui-test.mjs）
   前提: npm install 済み（esbuild, jsdom は devDependencies）

   AIに改修を頼むときは「変更後に npm test を実行し、
   all passed を確認してから納品して」と指示すること。

   注意: モックの日付は new Date() から相対的に組み立てているため、
   実行日に依存せず動く（1月1日だけ一部の期待値が変わる場合あり）。
============================================================ */
let __pass = 0, __fail = 0;
{
  const orig = console.log.bind(console);
  console.log = (...a) => {
    const s = a.map(String).join(" ");
    if (/: true$/.test(s)) __pass++;
    else if (/: false$/.test(s)) { __fail++; a.push("  ← ★FAIL"); }
    orig(...a);
  };
}

import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, "..", "src", "App.jsx");

/* ---------- Firebaseスタブ ---------- */
const stubs = {
  "local-firebase": `export const db = {};`,
  "firebase/app": `export const initializeApp = () => ({});`,
  "firebase/firestore": `
    export const getFirestore = () => ({});
    export const initializeFirestore = () => ({});
    export const persistentLocalCache = () => ({});
    export const persistentMultipleTabManager = () => ({});
    export const doc = (...a) => ({ __path: a.filter((x) => typeof x === "string").join("/") });
    export const onSnapshot = (ref, cb) => {
      globalThis.__snapCb = cb;
      setTimeout(() => cb({ exists: () => true, data: () => globalThis.__MOCK }), 0);
      return () => {};
    };
    export const setDoc = (ref, data) => {
      (globalThis.__setDocs = globalThis.__setDocs || []).push(JSON.parse(JSON.stringify(data)));
      return Promise.resolve();
    };
  `,
};

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(APP)};
globalThis.__renderApp = (el) => {
  const root = createRoot(el);
  root.render(React.createElement(App));
};
`;

const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^firebase\// }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onResolve({ filter: /\.\/firebase$/ }, () => ({ path: "local-firebase", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: stubs[args.path], loader: "js",
    }));
    build.onResolve({ filter: /^__entry__$/ }, () => ({ path: "__entry__", namespace: "entry" }));
    build.onLoad({ filter: /.*/, namespace: "entry" }, () => ({
      contents: entry, loader: "jsx", resolveDir: path.join(__dirname, ".."),
    }));
  },
};

const built = await esbuild.build({
  entryPoints: ["__entry__"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  supported: { "import-meta": true },
  jsx: "automatic",
  plugins: [stubPlugin],
  define: { "process.env.NODE_ENV": '"test"' },
});
const bundled = built.outputFiles[0].text;

/* ---------- モックデータ（実行日から相対で組み立て） ---------- */
const pad = (n) => String(n).padStart(2, "0");
const ymd = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const mmdd = (dt) => `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())}`;

const today = new Date();
today.setHours(0, 0, 0, 0);
const Y = today.getFullYear();
const plus3 = new Date(Y, today.getMonth(), today.getDate() + 3);
const yesterday = new Date(Y, today.getMonth(), today.getDate() - 1);
const minus8 = new Date(Y, today.getMonth(), today.getDate() - 8);

const emptyYear = () => {
  const months = {};
  for (let m = 1; m <= 12; m++) months[m] = [];
  return { months, nextYear: [] };
};

const mockYd = emptyYear();
// 今日の予定
mockYd.months[today.getMonth() + 1].push({
  id: "e-today", importance: "高", date: mmdd(today), text: "本日イベント", author: "test", createdAt: 1,
});
// 3日後の予定（月をまたぐ可能性があるので月は plus3 から）
mockYd.months[plus3.getMonth() + 1].push({
  id: "e-plus3", importance: "中", date: mmdd(plus3), text: "三日後イベント", author: "test", createdAt: 2,
});
// 毎年恒例（同じ日付ルール）
mockYd.months[12].push({
  id: "e-bounen", importance: "", date: "12/15", text: "忘年会", author: "test", createdAt: 3,
  annual: true, annualRule: "same",
});
// 恒例だが日付未定（📌リマインド対象）
mockYd.months[10].push({
  id: "e-ryokou", importance: "", date: "", text: "医師会旅行", author: "test", createdAt: 4,
  annual: true, annualRule: "tbd", pendingDate: true,
});

globalThis.__MOCK = {
  yearOrder: [Y],
  years: { [Y]: mockYd },
  cal: {},
  recurring: [
    // 期限切れの定期タスク（昨日が期限になるよう weekly で構成）
    {
      id: "r-over", title: "レセプト送信", parentId: "", freq: "weekly",
      weekday: yesterday.getDay(), day: 1, month: 1, interval: 1,
      importance: "高", memo: "", author: "test",
      lastDone: ymd(minus8), doneLog: [ymd(minus8)], createdAt: 5,
    },
  ],
};

/* ---------- jsdomで描画 ---------- */
const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
  url: "https://example.com/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Blob = dom.window.Blob;

// NameModalをスキップするため名前を事前登録
dom.window.localStorage.setItem("annualTodo_name", "test");

// alert / URL / a.click のスタブ
globalThis.__alerts = [];
globalThis.alert = (m) => globalThis.__alerts.push(String(m));
dom.window.alert = globalThis.alert;
globalThis.__icsBlobs = [];
dom.window.URL.createObjectURL = (b) => { globalThis.__icsBlobs.push(b); return "blob:test"; };
dom.window.URL.revokeObjectURL = () => {};
// バンドル内のURLはNode側を参照するのでこちらも上書き
globalThis.URL.createObjectURL = dom.window.URL.createObjectURL;
globalThis.URL.revokeObjectURL = dom.window.URL.revokeObjectURL;
dom.window.HTMLAnchorElement.prototype.click = function () {};
globalThis.__printed = 0;
dom.window.print = () => { globalThis.__printed++; };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const setVal = (el, v) => {
  const desc = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value");
  desc.set.call(el, v);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};

const origError = console.error;
console.error = (...a) => {
  const s = String(a[0] || "");
  if (s.includes("act(") || s.includes("ReactDOM")) return;
  origError(...a);
};

try {
  eval(bundled);
  const rootEl = dom.window.document.getElementById("root");
  globalThis.__renderApp(rootEl);
  await wait(600);

  let html = rootEl.innerHTML;
  console.log("=== HEADER ===");
  console.log("Title rendered:", html.includes("年間予定表"));
  console.log("4 view tabs:", ["ホーム", "リスト", "カレンダー", "定期タスク"].every((t) => html.includes(t)));
  console.log("Search/ics/print buttons:", html.includes("🔍") && html.includes("📤") && html.includes("🖨"));

  /* ---------- ホーム ---------- */
  console.log("=== HOME ===");
  console.log("Recur overdue alert (件数のみ):", html.includes("期限切れの定期タスクが") && html.includes("1件"));
  console.log("今日 section with event:", html.includes("本日イベント"));
  console.log("今週 section with event:", html.includes("三日後イベント"));
  console.log("📌日付未定リマインド:", html.includes("日付が未定の恒例行事") && html.includes("医師会旅行"));
  // 定期タスクは行として出ない（レセプト送信の行がホームにない）
  console.log("Recur rows excluded from home:", !(rootEl.querySelector(".ann-home")?.innerHTML || "").includes("レセプト送信"));

  /* ---------- リスト: エスカレーションと恒例マーク ---------- */
  click([...rootEl.querySelectorAll(".ann-viewtab")].find((b) => b.textContent.includes("リスト")));
  await wait(300);
  html = rootEl.innerHTML;
  console.log("=== LIST ===");
  console.log("Months rendered:", html.includes("1月") && html.includes("12月"));
  console.log("is-due0 on today's event:", !!rootEl.querySelector(".ann-ev.is-due0"));
  console.log("is-due3 on +3days event:", !!rootEl.querySelector(".ann-ev.is-due3"));
  console.log("🔁 annual mark:", !!rootEl.querySelector(".ann-annual-mark"));
  console.log("📌 pending mark:", html.includes("📌 日付未定"));
  console.log("Rollover button:", html.includes(`恒例行事を${Y + 1}年へ展開`));

  /* ---------- 恒例行事の展開 ---------- */
  globalThis.__setDocs = [];
  click(rootEl.querySelector(".ann-rollover"));
  await wait(700);
  console.log("=== ROLLOVER ===");
  console.log("Alert 2件展開:", (globalThis.__alerts[0] || "").includes("2件"));
  const saved = globalThis.__setDocs[globalThis.__setDocs.length - 1];
  const nyData = saved?.years?.[Y + 1];
  console.log("Next year created:", !!nyData);
  const copied12 = nyData?.months?.[12]?.find((e) => e.copiedFrom === "e-bounen");
  console.log("忘年会 copied with same date:", copied12?.date === "12/15" && copied12?.annual === true);
  const copied10 = nyData?.months?.[10]?.find((e) => e.copiedFrom === "e-ryokou");
  console.log("旅行 copied as pending:", copied10?.pendingDate === true && copied10?.date === "");
  // 二重展開防止
  globalThis.__alerts = [];
  click(rootEl.querySelector(".ann-rollover"));
  await wait(500);
  console.log("Second rollover skipped:", (globalThis.__alerts[0] || "").includes("展開済み"));

  /* ---------- Undo ---------- */
  console.log("=== UNDO ===");
  html = rootEl.innerHTML;
  console.log("Undo button shown:", html.includes("↩️"));
  globalThis.__setDocs = [];
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent === "↩️"));
  await wait(700);
  const afterUndo = globalThis.__setDocs[globalThis.__setDocs.length - 1];
  console.log("Undo persisted:", !!afterUndo);

  /* ---------- 検索 ---------- */
  console.log("=== SEARCH ===");
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent === "🔍"));
  await wait(200);
  const sInput = rootEl.querySelector(".ann-search-input");
  console.log("Search input opened:", !!sInput);
  setVal(sInput, "忘年会");
  await wait(200);
  html = rootEl.innerHTML;
  console.log("Search result found:", !!rootEl.querySelector(".ann-search-row") && html.includes("忘年会"));
  setVal(sInput, "レセプト");
  await wait(200);
  console.log("Search finds recur:", rootEl.innerHTML.includes("🔁 定期"));
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent === "🔍"));
  await wait(200);

  /* ---------- 定期タスク: 実施率 ---------- */
  click([...rootEl.querySelectorAll(".ann-viewtab")].find((b) => b.textContent.includes("定期タスク")));
  await wait(300);
  html = rootEl.innerHTML;
  console.log("=== RECUR ===");
  console.log("Year summary 📊:", html.includes("今年の実施状況"));
  console.log("Rate on card:", html.includes("回 完了"));

  /* ---------- ics書き出し ---------- */
  console.log("=== ICS ===");
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent === "📤"));
  await wait(300);
  const blob = globalThis.__icsBlobs[0];
  console.log("ICS blob created:", !!blob);
  if (blob) {
    const text = await blob.text();
    console.log("ICS has VCALENDAR:", text.includes("BEGIN:VCALENDAR") && text.includes("END:VCALENDAR"));
    console.log("ICS has today event:", text.includes("本日イベント"));
    console.log("ICS has recur 🔁:", text.includes("🔁 レセプト送信"));
  }

  /* ---------- 予定エディタ: 恒例チェック ---------- */
  click([...rootEl.querySelectorAll(".ann-viewtab")].find((b) => b.textContent.includes("リスト")));
  await wait(300);
  click(rootEl.querySelector(".ann-add"));
  await wait(200);
  html = rootEl.innerHTML;
  console.log("=== EDITOR ===");
  console.log("Annual toggle in editor:", html.includes("毎年恒例の行事"));
  // エディタを閉じる
  click([...rootEl.querySelectorAll(".ann-btn-ghost")].find((b) => b.textContent === "キャンセル"));
  await wait(200);

  /* ---------- 印刷メニュー ---------- */
  console.log("=== PRINT MENU ===");
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  html = rootEl.innerHTML;
  console.log("Print menu 5 items:",
    ["年間カレンダー", "3ヶ月カレンダー", "予定リスト", "定期タスク一覧", "月別ページ"].every((t) => html.includes(t)));

  // 年間カレンダー
  click([...rootEl.querySelectorAll(".ann-print-item")].find((b) => b.textContent.includes("年間カレンダー")));
  await wait(500);
  console.log("Yearcal rendered:", !!rootEl.querySelector(".ann-ycal") && rootEl.querySelectorAll(".ann-ycal-month").length === 12);
  console.log("Yearcal print called:", globalThis.__printed >= 1);

  // 3ヶ月カレンダー
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  click([...rootEl.querySelectorAll(".ann-print-3m-row .ann-btn-save")][0]);
  await wait(500);
  console.log("Cal3 rendered (3 months):", rootEl.querySelectorAll(".ann-c3-month").length === 3);

  // 予定リスト
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  click([...rootEl.querySelectorAll(".ann-print-item")].find((b) => b.textContent.includes("予定リスト")));
  await wait(500);
  console.log("PrintList has event:", (rootEl.querySelector(".ann-plist")?.innerHTML || "").includes("忘年会"));

  // 定期タスク一覧
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  click([...rootEl.querySelectorAll(".ann-print-item")].find((b) => b.textContent.includes("定期タスク一覧")));
  await wait(500);
  const prec = rootEl.querySelector(".ann-prec-table")?.innerHTML || "";
  console.log("PrintRecur table:", prec.includes("レセプト送信") && prec.includes("☐"));

  /* ---------- 月別ページ: 定期が日別行に☐で入る ---------- */
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  click([...rootEl.querySelectorAll(".ann-print-item")].find((b) => b.textContent.includes("月別ページ")));
  await wait(500);
  const monthlyTable = rootEl.querySelector(".ann-print-table")?.parentElement?.innerHTML || "";
  console.log("=== MONTHLY PRINT ===");
  console.log("Recur in day rows with ☐:", monthlyTable.includes("☐") && monthlyTable.includes("🔁レセプト送信"));

  /* ---------- 完了トースト+取消 ---------- */
  console.log("=== TOAST ===");
  click([...rootEl.querySelectorAll(".ann-viewtab")].find((b) => b.textContent.includes("定期タスク")));
  await wait(300);
  const doneBtn = [...rootEl.querySelectorAll(".ann-recur-done")][0];
  click(doneBtn);
  await wait(300);
  html = rootEl.innerHTML;
  console.log("Toast shown:", html.includes("を完了にしました") && !!rootEl.querySelector(".ann-toast-undo"));
  click(rootEl.querySelector(".ann-toast-undo"));
  await wait(300);
  console.log("Toast undo hides:", !rootEl.querySelector(".ann-toast"));

  /* ---------- カレンダーの日タップ→予定追加 ---------- */
  console.log("=== CAL ADD ===");
  click([...rootEl.querySelectorAll(".ann-viewtab")].find((b) => b.textContent.includes("カレンダー")));
  await wait(300);
  // 15日あたりのセルをタップ
  const dayBtn = [...rootEl.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "15" && b.className.includes("mm")
  ) || [...rootEl.querySelectorAll("button")].find((b) => b.textContent.trim() === "15");
  click(dayBtn);
  await wait(250);
  html = rootEl.innerHTML;
  console.log("CalPicker add button:", html.includes("この日に予定を追加"));
  click(rootEl.querySelector(".ann-cp-add"));
  await wait(250);
  const dateInput = [...rootEl.querySelectorAll(".ann-input")].find((i) => /\d{2}\/15/.test(i.value));
  console.log("Editor opens with preset date:", !!dateInput);
  click([...rootEl.querySelectorAll(".ann-btn-ghost")].find((b) => b.textContent === "キャンセル"));
  await wait(200);
} catch (e) {
  console.error = origError;
  console.log("=== RENDER FAILED ===");
  console.log(e.stack?.slice(0, 1500));
  process.exit(1);
}

console.log(`\n==== ${__pass} passed / ${__fail} failed ====`);
console.log(__fail === 0 ? "✅ all passed" : "❌ FAILED");
process.exit(__fail === 0 ? 0 : 1);
