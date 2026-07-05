// テストハーネスを流用して印刷用HTMLを取り出し、weasyprintでPDF化するための素材を作る
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { fileURLToPath as f2p } from "node:url";
const __dirname = path.dirname(f2p(import.meta.url));
const APP = path.join(__dirname, "..", "src", "App.jsx");

const stubs = {
  "local-firebase": `export const db = {};`,
  "firebase/app": `export const initializeApp = () => ({});`,
  "firebase/firestore": `
    export const getFirestore = () => ({});
    export const initializeFirestore = () => ({});
    export const persistentLocalCache = () => ({});
    export const persistentMultipleTabManager = () => ({});
    export const doc = () => ({});
    export const onSnapshot = (ref, cb) => { setTimeout(() => cb({ exists: () => true, data: () => globalThis.__MOCK }), 0); return () => {}; };
    export const setDoc = () => Promise.resolve();
  `,
};
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import App from ${JSON.stringify(APP)};
globalThis.__renderApp = (el) => { createRoot(el).render(React.createElement(App)); };
`;
const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^firebase\// }, (a) => ({ path: a.path, namespace: "stub" }));
    build.onResolve({ filter: /\.\/firebase$/ }, () => ({ path: "local-firebase", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    build.onResolve({ filter: /^__entry__$/ }, () => ({ path: "__entry__", namespace: "entry" }));
    build.onLoad({ filter: /.*/, namespace: "entry" }, () => ({ contents: entry, loader: "jsx", resolveDir: path.join(__dirname, "..") }));
  },
};
const built = await esbuild.build({
  entryPoints: ["__entry__"], bundle: true, write: false, format: "iife",
  jsx: "automatic", plugins: [stubPlugin], define: { "process.env.NODE_ENV": '"test"' },
  platform: "browser", supported: { "import-meta": true },
});

// リアルな1年分のモック(実際の医院運用を想定した量)
const Y = 2026;
const emptyYear = () => { const months = {}; for (let m = 1; m <= 12; m++) months[m] = []; return { months, nextYear: [] }; };
const yd = emptyYear();
let id = 0;
const add = (m, date, text, imp = "", clinic = false) =>
  yd.months[m].push({ id: "e" + (++id), importance: imp, date, text, author: "k", clinic, createdAt: id });
add(1, "01/07", "仕事始め・朝礼", "高"); add(1, "01/12", "珂北歯科医師会 新年会", "中"); add(1, "01/25", "レセコン保守点検");
add(2, "02/03", "節分・スタッフ会", "家"); add(2, "02/14", "学校歯科健診 打合せ", "中"); add(2, "02/23", "ユニット定期メンテ");
add(3, "03/08", "ひたちなか市歯科医師会 総会", "高"); add(3, "03/15", "子ども 卒業式", "家"); add(3, "03/20", "春の院内大掃除"); add(3, "03/29", "日曜診療", "", true);
add(4, "04/05", "入学式", "家"); add(4, "04/12", "新人スタッフ研修", "中"); add(4, "04/19", "学校歯科健診(小学校)", "高"); add(4, "04/26", "学校歯科健診(中学校)", "高");
add(5, "05/03", "05/03〜05/06 GW休診"); add(5, "05/17", "口腔機能低下症セミナー", "中"); add(5, "05/24", "日曜診療", "", true);
add(6, "06/04", "歯と口の健康週間 イベント", "高"); add(6, "06/14", "エアコン点検"); add(6, "06/21", "スタッフ面談週間", "中");
add(7, "07/05", "七夕飾り付け", "家"); add(7, "07/12", "珂北 理事会", "中"); add(7, "07/20", "夏季賞与 支給", "高"); add(7, "07/26", "日曜診療", "", true);
add(8, "08/11", "08/11〜08/16 夏季休診", "高"); add(8, "08/23", "院内感染対策 研修", "中");
add(9, "09/06", "防災訓練"); add(9, "09/13", "敬老の日 訪問診療", "中"); add(9, "09/23", "秋の院内勉強会");
add(10, "10/04", "医師会旅行(日程未定→決定)", "中"); add(10, "10/18", "インフルエンザ予防接種", "高"); add(10, "10/25", "日曜診療", "", true);
add(11, "11/08", "いい歯の日 イベント", "高"); add(11, "11/15", "七五三", "家"); add(11, "11/28", "珂北歯科医師会 忘年会", "高");
add(12, "12/06", "年末調整 書類提出", "高"); add(12, "12/13", "院内大掃除"); add(12, "12/20", "冬季賞与 支給", "高"); add(12, "12/28", "仕事納め", "中");

// カレンダー状態: 休診(木曜日曜)+年休+代診+検討中を散らす
const cal = { [Y]: {} };
for (let m = 1; m <= 12; m++) {
  const dim = new Date(Y, m, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    const dow = new Date(Y, m - 1, d).getDay();
    if (dow === 4) cal[Y][`${m}-${d}`] = "off"; // 木曜休診
  }
}
cal[Y]["3-29"] = "open"; cal[Y]["5-24"] = "open"; cal[Y]["7-26"] = "open"; cal[Y]["10-25"] = "open";
cal[Y]["5-1"] = "nenkyu"; cal[Y]["5-2"] = "nenkyu"; cal[Y]["8-11"] = "nenkyu"; cal[Y]["8-12"] = "nenkyu";
cal[Y]["6-19"] = "daishin"; cal[Y]["9-18"] = "daishin";
cal[Y]["12-29"] = "kentou"; cal[Y]["12-30"] = "kentou";

globalThis.__MOCK = {
  yearOrder: [Y], years: { [Y]: yd }, cal,
  recurring: [
    { id: "r1", title: "レセプト送信", parentId: "", freq: "monthly", day: 10, importance: "高", memo: "社保・国保", lastDone: "", doneLog: [], createdAt: 1 },
    { id: "r2", title: "給与振込", parentId: "", freq: "monthly", day: 25, importance: "高", memo: "", lastDone: "", doneLog: [], createdAt: 2 },
    { id: "r3", title: "エアコンフィルタ掃除", parentId: "", freq: "everyN", interval: 3, day: 15, baseYear: Y, baseMonth: 1, importance: "低", memo: "", lastDone: "", doneLog: [], createdAt: 3 },
  ],
};

const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { url: "https://example.com/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
dom.window.localStorage.setItem("annualTodo_name", "test");
globalThis.alert = () => {}; dom.window.alert = globalThis.alert;
dom.window.print = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

eval(built.outputFiles[0].text);
const rootEl = dom.window.document.getElementById("root");
globalThis.__renderApp(rootEl);
await wait(600);

// 印刷メニューから各モードを選び、印刷用HTMLを保存
const capture = async (matcher, name, before) => {
  click([...rootEl.querySelectorAll("button")].find((b) => b.textContent.includes("🖨")));
  await wait(200);
  if (before) before();
  click([...rootEl.querySelectorAll(".ann-print-item, .ann-print-3m-row .ann-btn-save")].find(matcher));
  await wait(400);
  const printEl = rootEl.querySelector(".ann-print");
  fs.writeFileSync(`/tmp/pp-${name}.html`,
    `<!doctype html><html><head><meta charset="utf-8"><style>${fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8")}</style></head><body><div class="ann-root"><div class="ann-print">${printEl.innerHTML}</div></div></body></html>`);
  console.log("captured", name);
};

await capture((b) => b.textContent.includes("年間カレンダー"), "yearcal");
await capture((b) => b.textContent === "印刷", "cal3"); // 3ヶ月(開始月は今月既定)
await capture((b) => b.textContent.includes("予定リスト"), "list");
await capture((b) => b.textContent.includes("定期タスク一覧"), "recur");
process.exit(0);
