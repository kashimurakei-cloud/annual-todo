import React, { useState, useEffect, useRef, useCallback } from "react";
import { db } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

/* ------------------------------------------------------------------ *
 *  年間予定表 ― Annual To-Do List
 *  ログイン不要・全員で1つのリストを共同編集（リアルタイム同期）
 *  ・削除は取り消し線で残り、2週間後に自動消去（元に戻せる）
 *  ・自分以外が追加した予定は色分け表示
 * ------------------------------------------------------------------ */

const SHARED_DOC = () => doc(db, "shared", "annualTodo");
const NAME_KEY = "annualTodo_name";
const CAL_KEY = "annualTodo_calAdded";
const DELETE_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 2週間
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = [
  { n: 1, en: "JAN" }, { n: 2, en: "FEB" }, { n: 3, en: "MAR" },
  { n: 4, en: "APR" }, { n: 5, en: "MAY" }, { n: 6, en: "JUN" },
  { n: 7, en: "JUL" }, { n: 8, en: "AUG" }, { n: 9, en: "SEP" },
  { n: 10, en: "OCT" }, { n: 11, en: "NOV" }, { n: 12, en: "DEC" },
];

const LEVELS = [
  { key: "高", label: "高", color: "#E5484D", bg: "#FCECEC" },
  { key: "中", label: "中", color: "#C77100", bg: "#FBF0E1" },
  { key: "低", label: "低", color: "#5B6873", bg: "#EEF1F3" },
  { key: "家", label: "家", color: "#0E9F8E", bg: "#E1F4F0" },
];
const levelOf = (k) => LEVELS.find((l) => l.key === k);

// 日付（MM/DD）と年から曜日を求める
const WD = ["日", "月", "火", "水", "木", "金", "土"];
function weekdayInfo(dateStr, year) {
  const m = String(dateStr || "").match(/(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const da = Number(m[2]);
  const d = new Date(year, mo - 1, da);
  if (d.getMonth() !== mo - 1 || d.getDate() !== da) return null; // 02/30 などの不正値
  return { wd: WD[d.getDay()], dow: d.getDay() };
}

let _id = 0;
const uid = () => `e${Date.now().toString(36)}${(_id++).toString(36)}`;
const ev = (importance, date, text, author, clinic) => ({
  id: uid(), importance, date, text, author: author || "",
  clinic: !!clinic, createdAt: Date.now(),
});

const emptyYear = () => {
  const months = {};
  for (let m = 1; m <= 12; m++) months[m] = [];
  return { months, nextYear: [] };
};

function initialData() {
  return {
    yearOrder: [2026, 2027, 2028, 2029],
    years: {
      2026: emptyYear(), 2027: emptyYear(), 2028: emptyYear(), 2029: emptyYear(),
    },
    cal: {},
  };
}

// カレンダーの各日の区分
const DAY_STATES = [
  { key: "open", label: "診療", cls: "" },
  { key: "off", label: "休診", cls: "st-off" },
  { key: "holiday", label: "祝日", cls: "st-holiday" },
  { key: "nenkyu", label: "計画年休", cls: "st-nenkyu" },
  { key: "daishin", label: "代診", cls: "st-daishin" },
  { key: "kentou", label: "検討中", cls: "st-kentou" },
];
const dayStateOf = (k) => DAY_STATES.find((s) => s.key === k);
// 日本の祝日（振替休日・国民の休日を含む)。年ごとにキャッシュ
const _holCache = {};
function computeJpHolidays(year) {
  const set = new Set();
  const add = (m, d) => set.add(`${m}-${d}`);
  const dow = (m, d) => new Date(year, m - 1, d).getDay();
  const nthMonday = (month, n) => {
    const w = new Date(year, month - 1, 1).getDay();
    return 1 + ((1 - w + 7) % 7) + (n - 1) * 7;
  };
  add(1, 1); add(2, 11); add(2, 23); add(4, 29); add(5, 3); add(5, 4); add(5, 5);
  add(8, 11); add(11, 3); add(11, 23);
  add(1, nthMonday(1, 2)); add(7, nthMonday(7, 3));
  add(9, nthMonday(9, 3)); add(10, nthMonday(10, 2));
  const k = year - 1980;
  add(3, Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4)));
  add(9, Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4)));
  const base = new Set(set);
  // 国民の休日（前後が祝日で、本人は祝日でも日曜でもない)
  for (let m = 1; m <= 12; m++) {
    const dim = new Date(year, m, 0).getDate();
    for (let d = 1; d <= dim; d++) {
      if (base.has(`${m}-${d}`) || dow(m, d) === 0) continue;
      const prev = new Date(year, m - 1, d - 1);
      const next = new Date(year, m - 1, d + 1);
      if (base.has(`${prev.getMonth() + 1}-${prev.getDate()}`) &&
          base.has(`${next.getMonth() + 1}-${next.getDate()}`)) set.add(`${m}-${d}`);
    }
  }
  // 振替休日（祝日が日曜なら、次の祝日でない日)
  for (const key of base) {
    const [m, d] = key.split("-").map(Number);
    if (dow(m, d) === 0) {
      let cur = new Date(year, m - 1, d + 1);
      while (set.has(`${cur.getMonth() + 1}-${cur.getDate()}`))
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      if (cur.getFullYear() === year) set.add(`${cur.getMonth() + 1}-${cur.getDate()}`);
    }
  }
  return set;
}
function isJpHoliday(year, m, day) {
  if (!_holCache[year]) _holCache[year] = computeJpHolidays(year);
  return _holCache[year].has(`${m}-${day}`);
}

// 日曜・月曜はデフォルト休診、祝日はデフォルト祝日、それ以外は診療
function defaultDayState(year, m, day) {
  if (isJpHoliday(year, m, day)) return "holiday";
  const dow = new Date(year, m - 1, day).getDay();
  return dow === 0 || dow === 1 ? "off" : "open";
}
function calState(cal, year, m, day) {
  const v = cal && cal[year] && cal[year][`${m}-${day}`];
  return v || defaultDayState(year, m, day);
}
// 月ごとの集計：診療(open+代診)・休(休診+祝日)・年休・日曜診療数・スタッフ労働日
function monthCounts(cal, year, m) {
  const dim = new Date(year, m, 0).getDate();
  let open = 0, off = 0, nenkyu = 0, sunClinic = 0;
  for (let d = 1; d <= dim; d++) {
    const s = calState(cal, year, m, d);
    const dow = new Date(year, m - 1, d).getDay();
    // 「検討中」は決まるまで診療日としてカウントする
    if (s === "open" || s === "daishin" || s === "kentou") { open++; if (dow === 0) sunClinic++; }
    else if (s === "nenkyu") nenkyu++;
    else off++; // 休診・祝日
  }
  return { open, off, nenkyu, sunClinic, staff: open - sunClinic, staffOff: off + sunClinic };
}

const dateOrder = (d) => {
  const m = String(d || "").match(/(\d{1,2})\D+(\d{1,2})/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 9999;
};
const sortByDate = (list) =>
  list.sort((a, b) => dateOrder(a.date) - dateOrder(b.date));

function normalize(raw) {
  if (!raw || !raw.years) return initialData();
  const years = {};
  for (const y of Object.keys(raw.years)) {
    const src = raw.years[y] || {};
    const months = {};
    for (let m = 1; m <= 12; m++) {
      const list = (src.months && src.months[m]) || [];
      months[m] = sortByDate(
        list.map(cleanEvent).filter((e) => !e.clinic)
      );
    }
    years[Number(y)] = {
      months,
      nextYear: sortByDate(
        (src.nextYear || []).map(cleanEvent).filter((e) => !e.clinic)
      ),
    };
  }
  const yearOrder = (raw.yearOrder || Object.keys(years).map(Number))
    .map(Number)
    .sort((a, b) => a - b);
  return {
    yearOrder, years, cal: raw.cal || {},
    recurring: (raw.recurring || []).map(cleanRecur),
  };
}

// ===== 定期タスク（リマインダー) =====
function cleanRecur(t) {
  return {
    id: t.id || uid(),
    title: t.title || "",
    parentId: t.parentId || "",
    freq: t.freq || "monthly", // monthly | yearly | everyN | weekly | none
    day: t.day ?? 1,
    month: t.month ?? 1,
    interval: t.interval ?? 1,
    baseYear: t.baseYear ?? null,
    baseMonth: t.baseMonth ?? null,
    weekday: t.weekday ?? 1,
    importance: t.importance || "",
    memo: t.memo || "",
    author: t.author || "",
    lastDone: t.lastDone || "",
    doneLog: Array.isArray(t.doneLog) ? t.doneLog : [], // 完了履歴（実施率用）
    createdAt: t.createdAt || 0,
  };
}
const rDaysInMonth = (y, m) => new Date(y, m, 0).getDate();
const rClampDay = (y, m, d) => Math.min(d, rDaysInMonth(y, m));
const rMid = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
const rAddDays = (dt, n) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n);
const rYmd = (dt) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const rParse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

function occOnOrAfter(t, from) {
  const f = rMid(from);
  if (t.freq === "weekly") {
    const wd = t.weekday ?? 1;
    return rAddDays(f, (wd - f.getDay() + 7) % 7);
  }
  if (t.freq === "yearly") {
    let y = f.getFullYear();
    for (let i = 0; i < 6; i++) {
      const m = t.month ?? 1, d = rClampDay(y, m, t.day ?? 1);
      const c = new Date(y, m - 1, d);
      if (c >= f) return c;
      y++;
    }
    return null;
  }
  if (t.freq === "everyN") {
    const iv = Math.max(1, t.interval ?? 1);
    const baseIdx = (t.baseYear ?? f.getFullYear()) * 12 + ((t.baseMonth ?? (f.getMonth() + 1)) - 1);
    let idx = f.getFullYear() * 12 + f.getMonth();
    const rem = ((idx - baseIdx) % iv + iv) % iv;
    if (rem !== 0) idx += iv - rem;
    for (let i = 0; i < iv * 4 + 24; i++) {
      const y = Math.floor(idx / 12), m = (idx % 12) + 1, d = rClampDay(y, m, t.day ?? 1);
      const c = new Date(y, m - 1, d);
      if (c >= f) return c;
      idx += iv;
    }
    return null;
  }
  // monthly
  let y = f.getFullYear(), m = f.getMonth() + 1;
  for (let i = 0; i < 14; i++) {
    const d = rClampDay(y, m, t.day ?? 1);
    const c = new Date(y, m - 1, d);
    if (c >= f) return c;
    m++; if (m > 12) { m = 1; y++; }
  }
  return null;
}
function startOfPeriod(t, today) {
  const x = rMid(today);
  if (t.freq === "weekly") return rAddDays(x, -((x.getDay() + 6) % 7));
  if (t.freq === "yearly") return new Date(x.getFullYear(), 0, 1);
  return new Date(x.getFullYear(), x.getMonth(), 1);
}
function nextDue(t, today) {
  if (t.freq === "none") return null;
  const from = t.lastDone ? rAddDays(rParse(t.lastDone), 1) : startOfPeriod(t, today);
  return occOnOrAfter(t, from);
}
function recurLabel(t) {
  if (t.freq === "none") return "まとめ（期限なし)";
  if (t.freq === "weekly") return `毎週${["日", "月", "火", "水", "木", "金", "土"][t.weekday ?? 1]}曜`;
  if (t.freq === "yearly") return `毎年${t.month}/${t.day}`;
  if (t.freq === "everyN") return `${t.interval}ヶ月ごと ${t.day}日`;
  return `毎月${t.day}日`;
}
// ある年の発生日マップ { "m-d": [タイトル] }（カレンダー表示用)
function recurOccMap(tasks, year) {
  const map = {};
  for (const t of tasks || []) {
    if (!t || t.freq === "none") continue;
    let cur = occOnOrAfter(t, new Date(year, 0, 1));
    let guard = 0;
    while (cur && cur.getFullYear() === year && guard < 420) {
      const k = `${cur.getMonth() + 1}-${cur.getDate()}`;
      (map[k] = map[k] || []).push(t.title || "");
      cur = occOnOrAfter(t, rAddDays(cur, 1));
      guard++;
    }
  }
  return map;
}
// ある年・月に発生する定期タスク（印刷用)
function recurInMonth(tasks, year, m) {
  const out = [];
  for (const t of tasks || []) {
    if (!t || t.freq === "none") continue;
    let cur = occOnOrAfter(t, new Date(year, m - 1, 1));
    let guard = 0;
    while (cur && cur.getFullYear() === year && cur.getMonth() + 1 === m && guard < 40) {
      out.push({ id: t.id, title: t.title || "", day: cur.getDate(), importance: t.importance || "" });
      cur = occOnOrAfter(t, rAddDays(cur, 1));
      guard++;
    }
  }
  return out.sort((a, b) => a.day - b.day);
}

/* 日付(MM/DD)から「第◯ ◯曜」を求める。例: 2026/03/14(土) → {nth:2, dow:6} */
function nthWeekdayOf(dateStr, year) {
  const wi = weekdayInfo(dateStr, year);
  if (!wi) return null;
  const m = String(dateStr).match(/(\d{1,2})\D+(\d{1,2})/);
  const day = Number(m[2]);
  return { month: Number(m[1]), nth: Math.ceil(day / 7), dow: wi.dow };
}
/* 指定年の「m月 第nth dow曜」の日付(MM/DD)を返す。第5がない年は最終週に丸める */
function dateOfNthWeekday(year, month, nth, dow) {
  const first = new Date(year, month - 1, 1);
  let day = 1 + ((dow - first.getDay() + 7) % 7) + (nth - 1) * 7;
  const dim = new Date(year, month, 0).getDate();
  while (day > dim) day -= 7;
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function cleanEvent(e) {
  const o = {
    id: e.id || uid(),
    importance: e.importance || "",
    date: e.date || "",
    text: e.text || "",
    author: e.author || "",
    clinic: !!e.clinic,
    createdAt: e.createdAt || 0,
  };
  if (e.deletedAt) o.deletedAt = e.deletedAt;
  if (e.auto) { o.auto = true; o.calDay = e.calDay || ""; }
  if (e.tag) o.tag = e.tag;
  if (e.annual) {
    o.annual = true;
    o.annualRule = e.annualRule || "same"; // same | nthWeekday | tbd
  }
  if (e.pendingDate) o.pendingDate = true; // 恒例なのに日付未定
  if (e.copiedFrom) o.copiedFrom = e.copiedFrom;
  return o;
}

// 2週間を過ぎた削除済みを実際に取り除く。取り除いたら true を返す
function purgeExpired(data) {
  const now = Date.now();
  let changed = false;
  const purge = (list) => {
    const kept = list.filter((e) => !(e.deletedAt && now - e.deletedAt > DELETE_GRACE_MS));
    if (kept.length !== list.length) changed = true;
    return kept;
  };
  for (const y of Object.keys(data.years)) {
    const yr = data.years[y];
    for (let m = 1; m <= 12; m++) yr.months[m] = purge(yr.months[m]);
    yr.nextYear = purge(yr.nextYear);
  }
  return changed;
}

export default function App() {
  const [data, setData] = useState(null);
  const [activeYear, setActiveYear] = useState(new Date().getFullYear());
  const [filter, setFilter] = useState(null);
  const [view, setView] = useState("home"); // "home" | "list" | "cal" | "recur"
  const [pendingScroll, setPendingScroll] = useState(null);
  const [calPick, setCalPick] = useState(null); // {m, day}
  const [editor, setEditor] = useState(null);
  const [recurEditor, setRecurEditor] = useState(null); // {id} or {id:null}
  const swipeRef = useRef({ x: 0, y: 0 });
  const [synced, setSynced] = useState(false);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [toast, setToast] = useState(null); // {msg, undoId}
  const toastTimer = useRef(null);
  const [printMode, setPrintMode] = useState({ mode: "monthly", startM: 1 });

  const doPrint = (mode, startM) => {
    setPrintMode({ mode, startM: startM || 1 });
    setShowPrint(false);
    setTimeout(() => window.print(), 80);
  };
  const [myName, setMyName] = useState(() => localStorage.getItem(NAME_KEY) || "");
  const [showName, setShowName] = useState(false);
  const [calAdded, setCalAdded] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CAL_KEY) || "{}"); } catch { return {}; }
  });
  const setCal = (id, val) => {
    setCalAdded((prev) => {
      const next = { ...prev };
      if (val) next[id] = 1; else delete next[id];
      localStorage.setItem(CAL_KEY, JSON.stringify(next));
      return next;
    });
  };
  const saveTimer = useRef(null);
  const purgedOnce = useRef(false);

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  useEffect(() => {
    if (!myName) setShowName(true); // 初回は名前を尋ねる
  }, []); // eslint-disable-line

  useEffect(() => {
    let first = true;
    const unsub = onSnapshot(
      SHARED_DOC(),
      (snap) => {
        setSynced(true);
        if (!snap.exists()) {
          if (first) setDoc(SHARED_DOC(), initialData());
        } else {
          const normalized = normalize(snap.data());
          // 期限切れの削除済みを1回だけ実際に消す
          if (!purgedOnce.current) {
            const copy = structuredClone(normalized);
            if (purgeExpired(copy)) {
              purgedOnce.current = true;
              setDoc(SHARED_DOC(), copy).catch(() => {});
              setData(copy);
              first = false;
              return;
            }
          }
          setData(normalized);
        }
        first = false;
      },
      (err) => console.error("同期エラー", err)
    );
    return unsub;
  }, []);

  const persist = useCallback((next) => {
    setData(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setDoc(SHARED_DOC(), next).catch((e) => console.error("保存に失敗しました", e));
    }, 350);
  }, []);

  // ↩️ 操作の取り消し（直近10回分）
  const undoStack = useRef([]);
  const [undoCount, setUndoCount] = useState(0);

  const update = (mut) => {
    undoStack.current.push(structuredClone(data));
    if (undoStack.current.length > 10) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
    const next = structuredClone(data);
    mut(next);
    persist(next);
  };

  const undoLast = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setUndoCount(undoStack.current.length);
    persist(prev);
  };

  const saveName = (name) => {
    const n = name.trim();
    setMyName(n);
    localStorage.setItem(NAME_KEY, n);
    setShowName(false);
  };

  useEffect(() => {
    if (view !== "list") return;
    // 指定があればそこへ、なければ今月へ自動スクロール
    const target = pendingScroll != null
      ? pendingScroll
      : (activeYear === curYear ? curMonth : null);
    if (target == null) return;
    const el = document.getElementById("ann-m" + target);
    if (el) el.scrollIntoView?.({ behavior: pendingScroll != null ? "smooth" : "auto", block: "start" });
    if (pendingScroll != null) setPendingScroll(null);
  }, [view, pendingScroll]); // eslint-disable-line

  if (!data) {
    return (
      <div className="ann-root">
        <div className="ann-loading">読み込んでいます…</div>
        {showName && <NameModal current={myName} onSave={saveName} onClose={() => setShowName(false)} />}
      </div>
    );
  }

  const yd = data.years[activeYear] || emptyYear();
  const recurMap = recurOccMap(data.recurring || [], activeYear);

  // ホームの件数バッジ（期限切れ＋今日)
  const alertCount = (() => {
    const t0 = rMid(new Date());
    const yNow = t0.getFullYear();
    let n = 0;
    for (const t of data.recurring || []) {
      if (t.freq === "none") continue;
      const due = nextDue(t, t0);
      if (due && Math.round((rMid(due) - t0) / 86400000) <= 0) n++;
    }
    const ydNow = data.years[yNow];
    if (ydNow) {
      for (let m = 1; m <= 12; m++) {
        for (const e of ydNow.months[m]) {
          if (e.deletedAt || !e.date) continue;
          const mm = String(e.date).match(/(\d{1,2})\D+(\d{1,2})/);
          if (!mm) continue;
          const dd = Math.round(
            (rMid(new Date(yNow, Number(mm[1]) - 1, Number(mm[2]))) - t0) / 86400000
          );
          if (dd === 0) n++;
        }
      }
    }
    return n;
  })();

  // 恒例行事（annual）を翌年へ複製する。二重展開はcopiedFromで防ぐ
  const rolloverAnnual = () => {
    const src = data.years[activeYear];
    if (!src) return;
    const ny = activeYear + 1;
    let created = 0, skipped = 0;
    update((d) => {
      if (!d.years[ny]) {
        d.years[ny] = emptyYear();
        if (!d.yearOrder.includes(ny)) d.yearOrder = [...d.yearOrder, ny].sort((a, b) => a - b);
      }
      for (let m = 1; m <= 12; m++) {
        for (const e of src.months[m]) {
          if (!e.annual || e.deletedAt || e.auto) continue;
          // すでに展開済みならスキップ
          const exists = d.years[ny].months[m].some((x) => x.copiedFrom === e.id);
          if (exists) { skipped++; continue; }
          const rule = e.annualRule || "same";
          let date = "", pending = false;
          if (rule === "same") date = e.date || "";
          else if (rule === "nthWeekday") {
            const nw = nthWeekdayOf(e.date, activeYear);
            date = nw ? dateOfNthWeekday(ny, nw.month, nw.nth, nw.dow) : "";
            if (!nw) pending = true;
          } else pending = true; // tbd
          if (!date && rule !== "tbd" && !e.date) pending = true;
          const copy = {
            id: uid(), importance: e.importance || "", date, text: e.text || "",
            author: myName, clinic: !!e.clinic, createdAt: Date.now(),
            annual: true, annualRule: rule, copiedFrom: e.id,
          };
          if (pending || rule === "tbd") copy.pendingDate = true;
          d.years[ny].months[m].push(copy);
          created++;
        }
        sortByDate(d.years[ny].months[m]);
      }
    });
    alert(
      created > 0
        ? `${ny}年へ ${created}件の恒例行事を展開しました。` +
          (skipped ? `（${skipped}件は展開済みのためスキップ）` : "") +
          `\n日付未定のものはホームに表示されます。`
        : skipped
          ? `すべて展開済みでした（${skipped}件）。`
          : `🔁マークの付いた恒例行事がありません。\n予定を開いて「毎年恒例」にチェックを入れてください。`
    );
  };

  // 📤 .ics書き出し（表示中の年の予定＋定期タスクの発生日を終日予定として）
  const exportIcs = () => {
    const pad = (n) => String(n).padStart(2, "0");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "PRODID:-//annual-todo//JP", "CALSCALE:GREGORIAN",
    ];
    const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const pushEv = (uidStr, y, m, d, summary, endYmd) => {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${uidStr}@annual-todo`);
      lines.push(`DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`);
      if (endYmd) lines.push(`DTEND;VALUE=DATE:${endYmd}`);
      lines.push(`SUMMARY:${esc(summary)}`);
      lines.push("END:VEVENT");
    };
    const ydx = data.years[activeYear];
    if (ydx) {
      for (let m = 1; m <= 12; m++) {
        for (const e of ydx.months[m]) {
          if (e.deletedAt || !e.date) continue;
          const dates = rangeDates(e.date);
          if (dates.length >= 2) {
            // 連休（複数日）: 最初〜最後
            const first = dates[0], last = dates[dates.length - 1];
            const end = new Date(activeYear, last.m - 1, last.d + 1); // DTENDは翌日
            pushEv(e.id, activeYear, first.m, first.d,
              (e.importance ? `[${e.importance}] ` : "") + e.text,
              `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`);
          } else {
            const mm = String(e.date).match(/(\d{1,2})\D+(\d{1,2})/);
            if (!mm) continue;
            pushEv(e.id, activeYear, Number(mm[1]), Number(mm[2]),
              (e.importance ? `[${e.importance}] ` : "") + e.text);
          }
        }
      }
    }
    for (let m = 1; m <= 12; m++) {
      for (const x of recurInMonth(data.recurring || [], activeYear, m)) {
        pushEv(`${x.id}-${m}-${x.day}`, activeYear, m, x.day, `🔁 ${x.title}`);
      }
    }
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `annual-${activeYear}.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const addYear = () => {
    const last = Math.max(...data.yearOrder);
    const ny = last + 1;
    update((d) => {
      d.yearOrder = [...d.yearOrder, ny].sort((a, b) => a - b);
      d.years[ny] = emptyYear();
    });
    setActiveYear(ny);
  };

  const saveEvent = ({ month, id, importance, date, text, clinic, annual, annualRule }) => {
    if (!text.trim() && !date.trim()) { setEditor(null); return; }
    update((d) => {
      const y = d.years[activeYear];
      const target = month === "next" ? y.nextYear : y.months[month];
      const extra = {
        annual: !!annual,
        annualRule: annual ? (annualRule || "same") : "",
        // 日付を入れたら「未定」状態は解除
        pendingDate: undefined,
      };
      if (id) {
        const i = target.findIndex((e) => e.id === id);
        if (i >= 0) {
          const prev = target[i];
          target[i] = { ...prev, importance, date, text, clinic: !!clinic, ...extra };
          if (!annual) { delete target[i].annual; delete target[i].annualRule; }
          if (date.trim()) delete target[i].pendingDate;
          else if (prev.pendingDate) target[i].pendingDate = true;
          delete target[i].undefined;
        }
      } else {
        const e2 = ev(importance, date, text, myName, clinic);
        if (annual) { e2.annual = true; e2.annualRule = annualRule || "same"; }
        target.push(e2);
      }
      // pendingDate: undefinedの掃除
      for (const e3 of target) { if (e3.pendingDate === undefined) delete e3.pendingDate; }
      sortByDate(target);
    });
    setEditor(null);
  };

  // 定期タスクの保存・削除・完了
  const saveRecur = (t) => {
    if (!t.title.trim()) { setRecurEditor(null); return; }
    update((d) => {
      d.recurring = d.recurring || [];
      // 数ヶ月ごとは登録月を基準にする
      if (t.freq === "everyN" && (t.baseYear == null || t.baseMonth == null)) {
        const now = new Date();
        t.baseYear = now.getFullYear();
        t.baseMonth = now.getMonth() + 1;
      }
      if (t.id) {
        const i = d.recurring.findIndex((x) => x.id === t.id);
        if (i >= 0) d.recurring[i] = { ...d.recurring[i], ...t };
      } else {
        d.recurring.push(cleanRecur({ ...t, id: uid(), author: myName, createdAt: Date.now() }));
      }
    });
    setRecurEditor(null);
  };
  const deleteRecur = (id) => {
    update((d) => {
      d.recurring = (d.recurring || []).filter((x) => x.id !== id);
      // 子は親なし（トップ)に格上げ
      for (const x of d.recurring) if (x.parentId === id) x.parentId = "";
    });
    setRecurEditor(null);
  };
  const completeRecur = (id) => {
    const task = (data.recurring || []).find((x) => x.id === id);
    update((d) => {
      const t = (d.recurring || []).find((x) => x.id === id);
      if (!t) return;
      const due = nextDue(t, new Date());
      if (due) {
        t.lastDone = rYmd(due);
        t.doneLog = [...(t.doneLog || []), rYmd(due)]; // 実施率の記録
      }
    });
    // 完了トースト（取消付き）
    clearTimeout(toastTimer.current);
    setToast({ msg: `✓ 「${task?.title || "タスク"}」を完了にしました`, undoId: id });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  const undoRecur = (id) => {
    update((d) => {
      const t = (d.recurring || []).find((x) => x.id === id);
      if (!t) return;
      const log = [...(t.doneLog || [])];
      log.pop();
      t.doneLog = log;
      t.lastDone = log.length ? log[log.length - 1] : "";
    });
  };

  // 横スワイプ（フリック)でビュー切替
  const VIEW_ORDER = ["home", "list", "cal", "recur"];
  const onSwipeStart = (e) => {
    const p = e.touches[0];
    swipeRef.current = { x: p.clientX, y: p.clientY };
  };
  const onSwipeEnd = (e) => {
    const p = e.changedTouches[0];
    const dx = p.clientX - swipeRef.current.x;
    const dy = p.clientY - swipeRef.current.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const i = VIEW_ORDER.indexOf(view);
      if (dx < 0 && i < VIEW_ORDER.length - 1) setView(VIEW_ORDER[i + 1]);
      else if (dx > 0 && i > 0) setView(VIEW_ORDER[i - 1]);
    }
  };

  // 日曜診療・代診・計画年休は予定リストへ自動反映
  const setDayState = (yr, m, day, state) => {
    update((d) => {
      d.cal = d.cal || {};
      d.cal[yr] = d.cal[yr] || {};
      const key = `${m}-${day}`;
      if (state === defaultDayState(yr, m, day)) delete d.cal[yr][key];
      else d.cal[yr][key] = state;

      // 予定リストへの自動反映
      const yearData = d.years[yr];
      if (yearData) {
        const list = yearData.months[m];
        // この日の自動エントリを一旦削除
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].auto && list[i].calDay === key) list.splice(i, 1);
        }
        let autoText = null, tag = "";
        if (state === "daishin") { autoText = "代診"; tag = "daishin"; }
        else if (state === "nenkyu") { autoText = "計画年休"; tag = "nenkyu"; }
        if (autoText) {
          const dd = `${String(m).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
          list.push({
            id: uid(), importance: "", date: dd, text: autoText,
            author: "", tag, createdAt: Date.now(), auto: true, calDay: key,
          });
          sortByDate(list);
        }
      }
    });
  };

  // カレンダーの日付からリスト表示の月へジャンプ
  const jumpToMonth = (m) => { setView("list"); setPendingScroll(m); };

  // 取り消し線（ソフト削除）
  const softDelete = (month, id) => {
    update((d) => {
      const y = d.years[activeYear];
      const target = month === "next" ? y.nextYear : y.months[month];
      const i = target.findIndex((e) => e.id === id);
      if (i >= 0) target[i].deletedAt = Date.now();
    });
    setEditor(null);
  };

  const restore = (month, id) => {
    update((d) => {
      const y = d.years[activeYear];
      const target = month === "next" ? y.nextYear : y.months[month];
      const i = target.findIndex((e) => e.id === id);
      if (i >= 0) delete target[i].deletedAt;
    });
    setEditor(null);
  };

  const hardDelete = (month, id) => {
    update((d) => {
      const y = d.years[activeYear];
      const target = month === "next" ? y.nextYear : y.months[month];
      const i = target.findIndex((e) => e.id === id);
      if (i >= 0) target.splice(i, 1);
    });
    setEditor(null);
  };

  const editing =
    editor &&
    (() => {
      const list = editor.month === "next" ? yd.nextYear : yd.months[editor.month];
      return editor.id ? list.find((e) => e.id === editor.id) : null;
    })();

  const visible = (list) =>
    filter ? list.filter((e) => e.importance === filter) : list;

  // 🔍 横断検索（全年の予定＋定期タスク）
  const searchResults = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out = [];
    for (const yKey of data.yearOrder) {
      const ydx = data.years[yKey];
      if (!ydx) continue;
      for (let m = 1; m <= 12; m++) {
        for (const e of ydx.months[m]) {
          if (e.deletedAt) continue;
          if ((e.text || "").toLowerCase().includes(q)) {
            out.push({ kind: "event", year: yKey, m, e });
          }
        }
      }
      for (const e of ydx.nextYear) {
        if (e.deletedAt) continue;
        if ((e.text || "").toLowerCase().includes(q)) out.push({ kind: "next", year: yKey, e });
      }
    }
    for (const t of data.recurring || []) {
      if ((t.title || "").toLowerCase().includes(q) || (t.memo || "").toLowerCase().includes(q)) {
        out.push({ kind: "recur", t });
      }
    }
    return out.slice(0, 30);
  })();
  const totalCount = Object.values(yd.months)
    .reduce((a, l) => a + l.filter((e) => !e.deletedAt).length, 0);

  return (
    <div className="ann-root">
      <header className="ann-head">
        <div className="ann-head-top">
          <div>
            <div className="ann-eyebrow">ANNUAL TO-DO LIST</div>
            <h1 className="ann-title">年間予定表</h1>
          </div>
          <div className="ann-head-right">
            <div className="ann-count">
              <span className="ann-count-num">{totalCount}</span>
              <span className="ann-count-lbl">件 / {activeYear}年</span>
            </div>
            <button className="ann-namechip" onClick={() => setShowName(true)}>
              {myName ? `👤 ${myName}` : "名前を設定"}
            </button>
            <button className="ann-printbtn" onClick={() => { setShowSearch((v) => !v); setQuery(""); }} title="検索">
              🔍
            </button>
            {undoCount > 0 && (
              <button className="ann-printbtn" onClick={undoLast} title="直前の操作を取り消す">
                ↩️
              </button>
            )}
            <button className="ann-printbtn" onClick={exportIcs} title={`${activeYear}年をカレンダー形式で書き出し`}>
              📤
            </button>
            <button className="ann-printbtn" onClick={() => setShowPrint(true)} title="印刷メニュー">
              🖨 印刷
            </button>
          </div>
        </div>

        <div className="ann-years">
          {data.yearOrder.map((y) => (
            <button
              key={y}
              className={"ann-year" + (y === activeYear ? " is-on" : "")}
              onClick={() => setActiveYear(y)}
            >
              {y}
            </button>
          ))}
          <button className="ann-year ann-year-add" onClick={addYear} title="年を追加">
            ＋
          </button>
        </div>

        <div className="ann-viewtabs">
          <button
            className={"ann-viewtab" + (view === "home" ? " is-on" : "")}
            onClick={() => setView("home")}
          >
            ホーム
            {alertCount > 0 && <span className="ann-tab-badge">{alertCount}</span>}
          </button>
          <button
            className={"ann-viewtab" + (view === "list" ? " is-on" : "")}
            onClick={() => setView("list")}
          >
            リスト
          </button>
          <button
            className={"ann-viewtab" + (view === "cal" ? " is-on" : "")}
            onClick={() => setView("cal")}
          >
            カレンダー
          </button>
          <button
            className={"ann-viewtab" + (view === "recur" ? " is-on" : "")}
            onClick={() => setView("recur")}
          >
            定期タスク
          </button>
        </div>

        {showSearch && (
          <div className="ann-searchbar">
            <input
              className="ann-input ann-search-input"
              value={query}
              autoFocus
              placeholder="🔍 予定・定期タスクを検索（全年から）"
              onChange={(e) => setQuery(e.target.value)}
            />
            {searchResults && (
              <div className="ann-search-results">
                {searchResults.length === 0 && <div className="ann-empty ann-empty-wide">見つかりませんでした</div>}
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    className="ann-search-row"
                    onClick={() => {
                      setShowSearch(false); setQuery("");
                      if (r.kind === "recur") { setView("recur"); }
                      else {
                        setActiveYear(r.year);
                        if (r.kind === "event") { setView("list"); setPendingScroll(r.m); }
                        else setView("list");
                      }
                    }}
                  >
                    {r.kind === "recur" ? (
                      <><span className="ann-sr-tag">🔁 定期</span>{r.t.title}</>
                    ) : r.kind === "next" ? (
                      <><span className="ann-sr-tag">{r.year}年 来年欄</span>{r.e.date && `${r.e.date}　`}{r.e.text}</>
                    ) : (
                      <><span className="ann-sr-tag">{r.year}年{r.m}月</span>{r.e.date && `${r.e.date}　`}{r.e.text}</>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="ann-legend">
          <button
            className={"ann-chip ann-chip-all" + (filter === null ? " is-on" : "")}
            onClick={() => setFilter(null)}
          >
            すべて
          </button>
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={"ann-chip" + (filter === l.key ? " is-on" : "")}
              style={
                filter === l.key
                  ? { background: l.color, borderColor: l.color, color: "#fff" }
                  : { color: l.color, borderColor: l.color }
              }
              onClick={() => setFilter(filter === l.key ? null : l.key)}
            >
              {l.label}
            </button>
          ))}
          <span className={"ann-sync" + (synced ? " is-on" : "")}>
            {synced ? "● 同期中" : "○ 接続中…"}
          </span>
        </div>
      </header>

      <div className="ann-body" onTouchStart={onSwipeStart} onTouchEnd={onSwipeEnd}>
      {view === "home" && (
        <HomeView
          data={data}
          onComplete={completeRecur}
          onGoMonth={(m) => jumpToMonth(m)}
          onGoRecur={() => setView("recur")}
        />
      )}

      {view === "cal" && (
        <CalendarView
          yd={yd}
          year={activeYear}
          cal={data.cal || {}}
          recur={recurMap}
          onPick={(m, day) => setCalPick({ m, day })}
          onJump={jumpToMonth}
        />
      )}

      {view === "recur" && (
        <RecurView
          tasks={data.recurring || []}
          onAdd={() => setRecurEditor({ id: null })}
          onEdit={(id) => setRecurEditor({ id })}
          onComplete={completeRecur}
          onUndo={undoRecur}
        />
      )}

      {view === "list" && (
      <>
      <div className="ann-grid">
        {MONTHS.map((m) => {
          const list = visible(yd.months[m.n]);
          const isCur = activeYear === curYear && m.n === curMonth;
          return (
            <section key={m.n} id={"ann-m" + m.n} className={"ann-month" + (isCur ? " is-current" : "")}>
              <div className="ann-month-head">
                <span className="ann-month-jp">{m.n}月</span>
                <span className="ann-month-en">{m.en}</span>
                {isCur && <span className="ann-now">今月</span>}
                <MonthSpecials cal={data.cal || {}} year={activeYear} m={m.n} />
              </div>
              <div className="ann-events">
                {list.length === 0 && <div className="ann-empty">—</div>}
                {list.map((e) => (
                  <EventRow key={e.id} e={e} myName={myName} year={activeYear}
                    added={!!calAdded[e.id]}
                    onCalMark={() => setCal(e.id, true)}
                    onCalUnmark={() => setCal(e.id, false)}
                    onClick={() => setEditor({ month: m.n, id: e.id })} />
                ))}
              </div>
              <button className="ann-add" onClick={() => setEditor({ month: m.n, id: null })}>
                ＋ 追加
              </button>
            </section>
          );
        })}
      </div>

      <section className="ann-next">
        <div className="ann-next-head">
          <span className="ann-next-title">{activeYear + 1}年に向けて</span>
          <span className="ann-next-sub">NEXT YEAR</span>
          <button className="ann-rollover" onClick={rolloverAnnual}>
            🔁 恒例行事を{activeYear + 1}年へ展開
          </button>
        </div>
        <div className="ann-next-list">
          {visible(yd.nextYear).length === 0 && (
            <div className="ann-empty ann-empty-wide">まだ何もありません</div>
          )}
          {visible(yd.nextYear).map((e) => (
            <EventRow key={e.id} e={e} myName={myName} wide year={activeYear + 1}
              added={!!calAdded[e.id]}
              onCalMark={() => setCal(e.id, true)}
              onCalUnmark={() => setCal(e.id, false)}
              onClick={() => setEditor({ month: "next", id: e.id })} />
          ))}
        </div>
        <button className="ann-add ann-add-wide" onClick={() => setEditor({ month: "next", id: null })}>
          ＋ 追加
        </button>
      </section>
      </>
      )}
      </div>

      {recurEditor && (
        <RecurEditor
          existing={(data.recurring || []).find((t) => t.id === recurEditor.id) || null}
          tasks={data.recurring || []}
          onSave={saveRecur}
          onDelete={recurEditor.id ? () => deleteRecur(recurEditor.id) : null}
          onClose={() => setRecurEditor(null)}
        />
      )}

      {calPick && (
        <CalPicker
          year={activeYear}
          m={calPick.m}
          day={calPick.day}
          current={calState(data.cal || {}, activeYear, calPick.m, calPick.day)}
          onSelect={(state) => { setDayState(activeYear, calPick.m, calPick.day, state); setCalPick(null); }}
          onAddEvent={() => {
            const dd = `${String(calPick.m).padStart(2, "0")}/${String(calPick.day).padStart(2, "0")}`;
            setCalPick(null);
            setEditor({ month: calPick.m, id: null, presetDate: dd });
          }}
          onClose={() => setCalPick(null)}
        />
      )}

      {editor && (
        <Editor
          month={editor.month}
          year={activeYear}
          presetDate={editor.presetDate}
          existing={editing}
          onSave={saveEvent}
          onSoftDelete={editing && !editing.deletedAt ? () => softDelete(editor.month, editor.id) : null}
          onRestore={editing && editing.deletedAt ? () => restore(editor.month, editor.id) : null}
          onHardDelete={editing && editing.deletedAt ? () => hardDelete(editor.month, editor.id) : null}
          onClose={() => setEditor(null)}
        />
      )}

      {showPrint && (
        <PrintMenu
          year={activeYear}
          onPrint={doPrint}
          onClose={() => setShowPrint(false)}
        />
      )}

      {showName && (
        <NameModal current={myName} onSave={saveName} onClose={() => setShowName(false)} />
      )}

      {toast && (
        <div className="ann-toast">
          <span>{toast.msg}</span>
          <button
            className="ann-toast-undo"
            onClick={() => {
              undoRecur(toast.undoId);
              clearTimeout(toastTimer.current);
              setToast(null);
            }}
          >
            取消
          </button>
        </div>
      )}

      <footer className="ann-foot">
        このリンクを知っている人は誰でも閲覧・編集できます。削除した予定は取り消し線で残り、2週間後に自動で消えます。
      </footer>

      {printMode.mode === "monthly" && (
        <PrintSheet yd={yd} year={activeYear} tasks={data.recurring || []} cal={data.cal || {}} />
      )}
      {printMode.mode === "list" && (
        <PrintList yd={yd} year={activeYear} cal={data.cal || {}} />
      )}
      {printMode.mode === "yearcal" && (
        <PrintYearCal yd={yd} year={activeYear} cal={data.cal || {}} recur={recurMap} />
      )}
      {printMode.mode === "cal3" && (
        <PrintCal3 yd={yd} year={activeYear} cal={data.cal || {}} startM={printMode.startM} />
      )}
      {printMode.mode === "recur" && (
        <PrintRecur tasks={data.recurring || []} year={activeYear} />
      )}
    </div>
  );
}

// Googleカレンダーに追加するためのURL（終日の予定として）
// 日付欄に2つ以上の日付があれば「連休（複数日)」とみなす
const rangeDates = (dateStr) =>
  String(dateStr || "").match(/(\d{1,2})\D+(\d{1,2})/g) || [];
const isRangeDate = (dateStr) => rangeDates(dateStr).length >= 2;

function gcalUrl(e, year) {
  const all = rangeDates(e.date);
  if (all.length === 0) return null;
  const parse = (s) => {
    const m = s.match(/(\d{1,2})\D+(\d{1,2})/);
    return { mo: Number(m[1]), da: Number(m[2]) };
  };
  const a = parse(all[0]);
  const b = all.length >= 2 ? parse(all[all.length - 1]) : a; // 連休なら最後の日まで
  const pad = (n) => String(n).padStart(2, "0");
  const start = `${year}${pad(a.mo)}${pad(a.da)}`;
  const end = new Date(year, b.mo - 1, b.da + 1); // 終日は終了日を翌日に
  const endStr = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;
  const text = encodeURIComponent(e.text || "予定");
  const details = encodeURIComponent(
    [
      e.importance ? `重要度: ${e.importance}` : "",
      e.author ? `追加: ${e.author}` : "",
      "（年間予定表より）",
    ].filter(Boolean).join("\n")
  );
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${start}/${endStr}&details=${details}`;
}

function EventRow({ e, onClick, wide, myName, year, added, onCalMark, onCalUnmark }) {
  // 期限の近さで色を変える（今年の予定のみ）
  const escalation = (() => {
    if (e.deletedAt || !e.date) return "";
    const nowY = new Date().getFullYear();
    if (year !== nowY) return "";
    const mm = String(e.date).match(/(\d{1,2})\D+(\d{1,2})/);
    if (!mm) return "";
    const due = rMid(new Date(nowY, Number(mm[1]) - 1, Number(mm[2])));
    const days = Math.round((due - rMid(new Date())) / 86400000);
    if (days === 0) return " is-due0";
    if (days > 0 && days <= 3) return " is-due3";
    if (days < 0) return " is-pastday";
    return "";
  })();
  const lv = levelOf(e.importance);
  const isOther = e.author && e.author !== myName;
  const isDeleted = !!e.deletedAt;
  const isRange = isRangeDate(e.date);
  const cal = !isDeleted && e.date ? gcalUrl(e, year) : null;
  const wi = e.date && !isRange ? weekdayInfo(e.date, year) : null; // 連休のときは曜日を出さない
  let cls = "ann-ev" + escalation;
  if (wide) cls += " ann-ev-wide";
  if (isOther) cls += " ann-ev-other";
  if (isDeleted) cls += " ann-ev-deleted";
  if (isRange) cls += " ann-ev-range";
  if (e.clinic) cls += " ann-ev-clinic";
  return (
    <div className={cls}>
      <button className="ann-ev-main" onClick={onClick}>
        {e.clinic && <span className="ann-clinic-tag" title="日曜診療日">🏥診</span>}
        {e.tag === "daishin" && <span className="ann-tag-daishin">🩺代診</span>}
        {e.tag === "nenkyu" && <span className="ann-tag-nenkyu">🏖年休</span>}
        {lv ? (
          <span className="ann-badge" style={{ background: lv.bg, color: lv.color }}>
            {lv.label}
          </span>
        ) : (
          <span className="ann-badge ann-badge-none">−</span>
        )}
        {e.date
          ? (
            <span className="ann-date">
              {e.date}
              {wi && (
                <span
                  className={
                    "ann-wd" +
                    (wi.dow === 0 ? " ann-wd-sun" : wi.dow === 6 ? " ann-wd-sat" : "")
                  }
                >
                  （{wi.wd}）
                </span>
              )}
            </span>
          )
          : <span className={"ann-undated" + (e.pendingDate ? " is-pending" : "")}>
              {e.pendingDate ? "📌 日付未定" : "未定"}
            </span>}
        <span className="ann-text">
          {e.annual && <span className="ann-annual-mark" title="毎年恒例">🔁</span>}
          {e.text}
        </span>
        {e.author && <span className="ann-author">{e.author}</span>}
      </button>
      {cal && (added ? (
        <button
          className="ann-cal ann-cal-done"
          title="カレンダー追加済み（クリックで解除）"
          onClick={(ev) => { ev.stopPropagation(); onCalUnmark(); }}
        >
          ✅
        </button>
      ) : (
        <a
          className="ann-cal"
          href={cal}
          target="_blank"
          rel="noopener noreferrer"
          title="Googleカレンダーに追加"
          onClick={(ev) => { ev.stopPropagation(); onCalMark(); }}
        >
          📅
        </a>
      ))}
    </div>
  );
}

function CalendarView({ yd, year, cal, recur, onPick, onJump }) {
  let aOpen = 0, aOff = 0, aNenkyu = 0, aSun = 0;
  for (let m = 1; m <= 12; m++) {
    const c = monthCounts(cal, year, m);
    aOpen += c.open; aOff += c.off; aNenkyu += c.nenkyu; aSun += c.sunClinic;
  }
  const aStaff = aOpen - aSun;
  return (
    <div className="ann-cal-wrap">
      <div className="ann-cal-summary">
        <div className="ann-cal-stat"><span className="n">{aOpen}</span><span className="l">年間診療日</span></div>
        <div className="ann-cal-stat"><span className="n">{aOff}</span><span className="l">休診日</span></div>
        <div className="ann-cal-stat"><span className="n">{aStaff}</span><span className="l">スタッフ労働日</span></div>
        <div className="ann-cal-stat"><span className="n">{aNenkyu}</span><span className="l">計画年休</span></div>
      </div>
      <div className="ann-cal-legend">
        {DAY_STATES.filter((s) => s.key !== "open").map((s) => (
          <span key={s.key} className="ann-cal-leg">
            <span className={"ann-cal-swatch " + s.cls} />
            {s.label}
          </span>
        ))}
        <span className="ann-cal-leg"><span className="ann-cal-dot-leg" />予定あり</span>
        <span className="ann-cal-leg"><span className="ann-cal-dot-leg recur" />定期タスク</span>
      </div>
      <div className="ann-cal-grid">
        {MONTHS.map((mo) => (
          <MiniMonth
            key={mo.n}
            year={year}
            m={mo.n}
            en={mo.en}
            events={yd.months[mo.n]}
            cal={cal}
            recur={recur || {}}
            onPick={onPick}
            onJump={onJump}
          />
        ))}
      </div>
    </div>
  );
}

function MiniMonth({ year, m, en, events, cal, recur, onPick, onJump }) {
  const daysInMonth = new Date(year, m, 0).getDate();
  const firstDow = new Date(year, m - 1, 1).getDay(); // 0=日
  const lead = (firstDow + 6) % 7; // 月曜始まりの先頭空白

  const evDays = new Set();
  for (const e of events) {
    if (e.deletedAt || !e.date) continue;
    for (const tok of e.date.match(/(\d{1,2})\D+(\d{1,2})/g) || []) {
      const mm = tok.match(/(\d{1,2})\D+(\d{1,2})/);
      if (Number(mm[1]) === m) evDays.add(Number(mm[2]));
    }
  }

  const { open: openCount, off: offCount, nenkyu: nenkyuCount, staff: staffCount, staffOff: staffOffCount } =
    monthCounts(cal, year, m);

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const WDH = ["月", "火", "水", "木", "金", "土", "日"];

  return (
    <section className="ann-mini">
      <div className="ann-mini-head">
        <button className="ann-mini-title" onClick={() => onJump(m)} title="この月の予定リストへ">
          {m}月 <span className="ann-mini-en">{en}</span>
        </button>
        <span className="ann-mini-count">
          診療{openCount}{staffCount !== openCount ? `(${staffCount})` : ""}・
          <span className="off">休{offCount}{staffOffCount !== offCount ? `(${staffOffCount})` : ""}</span>
          {nenkyuCount > 0 ? `・年休${nenkyuCount}` : ""}
        </span>
      </div>
      <div className="ann-mini-grid">
        {WDH.map((w, i) => (
          <div key={"h" + i} className={"ann-mini-wd" + (i === 5 ? " sat" : i === 6 ? " sun" : "")}>
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="ann-mini-cell empty" />;
          const dow = new Date(year, m - 1, d).getDay();
          const st = dayStateOf(calState(cal, year, m, d));
          let cc = "ann-mini-cell";
          if (st && st.cls) cc += " " + st.cls;
          if (dow === 0) cc += " sun";
          else if (dow === 6) cc += " sat";
          return (
            <button
              key={i}
              className={cc}
              onClick={() => onPick(m, d)}
              title={
                (st ? st.label : "") +
                (recur[`${m}-${d}`] ? `｜定期: ${recur[`${m}-${d}`].join("、")}` : "")
              }
            >
              {d}
              <span className="ann-mini-dots">
                {evDays.has(d) && <span className="ann-mini-dot" />}
                {recur[`${m}-${d}`] && <span className="ann-mini-dot recur" />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CalPicker({ year, m, day, current, onSelect, onAddEvent, onClose }) {
  const dow = new Date(year, m - 1, day).getDay();
  const wd = ["日", "月", "火", "水", "木", "金", "土"][dow];
  return (
    <div className="ann-modal-bg" onClick={onClose}>
      <div className="ann-modal ann-modal-narrow" onClick={(e) => e.stopPropagation()}>
        <div className="ann-modal-head">
          <span>{m}月{day}日（{wd}）</span>
          <span className="ann-modal-sub">区分を選ぶ</span>
        </div>
        <div className="ann-state-pick">
          {DAY_STATES.map((s) => (
            <button
              key={s.key}
              className={"ann-state " + (s.cls || "st-open") + (current === s.key ? " is-on" : "")}
              onClick={() => onSelect(s.key)}
            >
              <span className="ann-state-sw" />
              {s.label}
              {current === s.key && <span className="ann-state-now">現在</span>}
            </button>
          ))}
        </div>
        <button className="ann-cp-add" onClick={onAddEvent}>
          ＋ この日に予定を追加
        </button>
      </div>
    </div>
  );
}


function MonthSpecials({ cal, year, m }) {
  const dim = new Date(year, m, 0).getDate();
  const sun = [], dai = [], nen = [];
  for (let d = 1; d <= dim; d++) {
    const s = calState(cal, year, m, d);
    const dow = new Date(year, m - 1, d).getDay();
    if (s === "open" && dow === 0) sun.push(d);
    else if (s === "daishin") dai.push(d);
    else if (s === "nenkyu") nen.push(d);
  }
  if (!sun.length && !dai.length && !nen.length) return null;
  const fmt = (arr) => arr.map((d) => `${m}/${d}`).join("・");
  return (
    <span className="ann-mh-sum">
      {sun.length > 0 && (
        <span className="ann-mh-item">
          <span className="ann-clinic-tag">🏥診</span>{fmt(sun)}
        </span>
      )}
      {dai.length > 0 && (
        <span className="ann-mh-item">
          <span className="ann-tag-daishin">🩺代診</span>{fmt(dai)}
        </span>
      )}
      {nen.length > 0 && (
        <span className="ann-mh-item">
          <span className="ann-tag-nenkyu">🏖年休</span>{fmt(nen)}
        </span>
      )}
    </span>
  );
}

function ClinicSummary({ yd, year }) {
  const days = [];
  for (let m = 1; m <= 12; m++) {
    for (const e of yd.months[m]) {
      if (e.clinic && !e.deletedAt && e.date) days.push(e);
    }
  }
  if (days.length === 0) return null;
  days.sort((a, b) => dateOrder(a.date) - dateOrder(b.date));
  return (
    <div className="ann-clinic-bar">
      <span className="ann-clinic-ico">🏥</span>
      <span className="ann-clinic-lbl">{year}年の日曜診療日</span>
      <span className="ann-clinic-days">
        {days.map((e) => {
          const wi = weekdayInfo(e.date, year);
          return (
            <span key={e.id} className="ann-clinic-day">
              {e.date}{wi ? `（${wi.wd}）` : ""}
            </span>
          );
        })}
      </span>
    </div>
  );
}

function Editor({ month, existing, onSave, onSoftDelete, onRestore, onHardDelete, onClose, year, presetDate }) {
  const [importance, setImportance] = useState(existing?.importance ?? "");
  const [date, setDate] = useState(existing?.date ?? presetDate ?? "");
  const [text, setText] = useState(existing?.text ?? "");
  const [clinic, setClinic] = useState(existing?.clinic ?? false);
  const [annual, setAnnual] = useState(existing?.annual ?? false);
  const [annualRule, setAnnualRule] = useState(existing?.annualRule ?? "same");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = month === "next" ? "来年に向けて" : `${month}月の予定`;
  const submit = () =>
    onSave({ month, id: existing?.id ?? null, importance, date, text, clinic, annual, annualRule });
  const nw = nthWeekdayOf(date, year || new Date().getFullYear());
  const WDJ = ["日", "月", "火", "水", "木", "金", "土"];
  const isDeleted = existing?.deletedAt;

  return (
    <div className="ann-modal-bg" onClick={onClose}>
      <div className="ann-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ann-modal-head">
          <span>{existing ? "予定を編集" : "予定を追加"}</span>
          <span className="ann-modal-sub">{title}</span>
        </div>

        {isDeleted && (
          <div className="ann-deleted-note">
            この予定は削除済みです（取り消し線表示）。2週間後に自動で消えます。
          </div>
        )}

        <label className="ann-field-label">重要度</label>
        <div className="ann-lv-pick">
          <button className={"ann-lv" + (importance === "" ? " is-on" : "")} onClick={() => setImportance("")}>
            なし
          </button>
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={"ann-lv" + (importance === l.key ? " is-on" : "")}
              style={
                importance === l.key
                  ? { background: l.color, borderColor: l.color, color: "#fff" }
                  : { color: l.color, borderColor: l.color }
              }
              onClick={() => setImportance(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>

        <label className="ann-field-label">日付（任意・例 04/15）</label>
        <input
          className="ann-input"
          value={date}
          placeholder="MM/DD　未定なら空欄でOK"
          onChange={(e) => setDate(e.target.value)}
        />

        <label className="ann-field-label">内容</label>
        <textarea
          className="ann-textarea"
          value={text}
          rows={3}
          placeholder="例）ひたちなか歯科医師会総会"
          onChange={(e) => setText(e.target.value)}
        />

        {month !== "next" && (
          <>
            <label className="ann-annual-toggle">
              <input type="checkbox" checked={annual} onChange={(e) => setAnnual(e.target.checked)} />
              🔁 毎年恒例の行事（「来年へ展開」でコピーされます）
            </label>
            {annual && (
              <div className="ann-annual-rules">
                <div className="ann-field-label">来年の日付の決め方</div>
                <label className="ann-annual-rule">
                  <input type="radio" checked={annualRule === "same"} onChange={() => setAnnualRule("same")} />
                  同じ日付（{date || "MM/DD"}）
                </label>
                <label className={"ann-annual-rule" + (nw ? "" : " is-dim")}>
                  <input type="radio" disabled={!nw} checked={annualRule === "nthWeekday"} onChange={() => setAnnualRule("nthWeekday")} />
                  同じ「第{nw ? nw.nth : "◯"} {nw ? WDJ[nw.dow] : "◯"}曜日」{nw ? "" : "（日付を入れると選べます）"}
                </label>
                <label className="ann-annual-rule">
                  <input type="radio" checked={annualRule === "tbd"} onChange={() => setAnnualRule("tbd")} />
                  未定（日付なしでコピーし、ホームでリマインド）
                </label>
              </div>
            )}
          </>
        )}

        <div className="ann-modal-actions">
          {onSoftDelete && (
            <button className="ann-btn ann-btn-del" onClick={onSoftDelete}>削除</button>
          )}
          {onRestore && (
            <button className="ann-btn ann-btn-restore" onClick={onRestore}>元に戻す</button>
          )}
          {onHardDelete && (
            <button className="ann-btn ann-btn-del" onClick={onHardDelete}>今すぐ完全に削除</button>
          )}
          <div className="ann-spacer" />
          <button className="ann-btn ann-btn-ghost" onClick={onClose}>キャンセル</button>
          <button className="ann-btn ann-btn-save" onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}

function NameModal({ current, onSave, onClose }) {
  const [name, setName] = useState(current || "");
  return (
    <div className="ann-modal-bg" onClick={onClose}>
      <div className="ann-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ann-modal-head">
          <span>お名前を設定</span>
        </div>
        <p className="ann-name-text">
          追加した予定が「誰のものか」を色分けするために、お名前（ニックネーム)を入れてください。
          この端末にだけ保存されます。
        </p>
        <input
          className="ann-input"
          value={name}
          placeholder="例）かしむら"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && onSave(name)}
        />
        <div className="ann-modal-actions">
          <div className="ann-spacer" />
          <button className="ann-btn ann-btn-save" onClick={() => onSave(name)}>保存</button>
        </div>
      </div>
    </div>
  );
}

const SOON_DAYS = 14; // 期限の何日前から表示するか

/* 今年の実施率: 今日までに発生した回数と、doneLogのうち今年の件数 */
function recurRateThisYear(t) {
  if (t.freq === "none") return null;
  const today = rMid(new Date());
  const year = today.getFullYear();
  let expected = 0;
  let cur = occOnOrAfter(t, new Date(year, 0, 1));
  let guard = 0;
  while (cur && cur <= today && cur.getFullYear() === year && guard < 420) {
    expected++;
    cur = occOnOrAfter(t, rAddDays(cur, 1));
    guard++;
  }
  const done = (t.doneLog || []).filter((s) => s.startsWith(String(year))).length;
  return { expected, done: Math.min(done, expected) || done };
}

function RecurCard({ row, isChild, onEdit, onComplete, onUndo }) {
  const { t, due, days } = row;
  const rate = recurRateThisYear(t);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const overdue = due && days < 0;
  const soon = due && days >= 0 && days <= SOON_DAYS;
  const later = due && days > SOON_DAYS;
  const lv = levelOf(t.importance);
  const cls =
    "ann-recur-card" +
    (isChild ? " is-child" : "") +
    (overdue ? " is-over" : soon ? " is-soon" : later ? " is-later" : "");
  return (
    <div className={cls}>
      <button className="ann-recur-main" onClick={() => onEdit(t.id)}>
        <div className="ann-recur-top">
          {lv && (
            <span className="ann-badge" style={{ background: lv.bg, color: lv.color }}>
              {lv.label}
            </span>
          )}
          <span className="ann-recur-name">{t.title || "（無題)"}</span>
        </div>
        <div className="ann-recur-sub">
          <span className="ann-recur-freq">{recurLabel(t)}</span>
          {due && (
            <span className={"ann-recur-due" + (overdue ? " over" : soon ? " soon" : "")}>
              {due.getMonth() + 1}/{due.getDate()}（{WD[due.getDay()]})・
              {overdue ? `期限切れ（${-days}日経過)` : days === 0 ? "今日" : `あと${days}日`}
            </span>
          )}
        </div>
        {t.memo && <div className="ann-recur-memo">{t.memo}</div>}
        {t.lastDone && (
          <div className="ann-recur-last">前回完了 {t.lastDone.slice(5).replace("-", "/")}</div>
        )}
        {rate && rate.expected > 0 && (
          <div className={"ann-recur-rate" + (rate.done < rate.expected ? " is-short" : "")}>
            今年 {rate.done}/{rate.expected}回 完了
          </div>
        )}
      </button>
      <div className="ann-recur-actions">
        {t.freq !== "none" && (
          <button className="ann-recur-done" onClick={() => onComplete(t.id)}>✓ 完了</button>
        )}
        {t.lastDone && (
          <button className="ann-recur-undo" onClick={() => onUndo(t.id)}>取消</button>
        )}
      </div>
    </div>
  );
}

function RecurGroup({ g, onEdit, onComplete, onUndo }) {
  return (
    <div className="ann-recur-group">
      <RecurCard row={{ t: g.parent, ...g.pInfo }} isChild={false}
        onEdit={onEdit} onComplete={onComplete} onUndo={onUndo} />
      {g.kids.length > 0 && (
        <div className="ann-recur-kids">
          {g.kids.map((k) => (
            <RecurCard key={k.t.id} row={k} isChild={true}
              onEdit={onEdit} onComplete={onComplete} onUndo={onUndo} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecurView({ tasks, onAdd, onEdit, onComplete, onUndo }) {
  const today = rMid(new Date());
  const [showLater, setShowLater] = useState(false);

  const info = (t) => {
    const due = nextDue(t, today);
    const days = due ? Math.round((rMid(due) - today) / 86400000) : null;
    return { t, due, days };
  };
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const tops = tasks.filter((t) => !t.parentId || !byId[t.parentId]);
  const groups = tops.map((parent) => {
    const kids = tasks
      .filter((c) => c.parentId === parent.id)
      .map(info)
      .sort((a, b) => (a.due && b.due ? a.due - b.due : a.due ? -1 : 1));
    const pInfo = info(parent);
    const allDays = [pInfo.days, ...kids.map((k) => k.days)].filter((d) => d != null);
    const groupDays = allDays.length ? Math.min(...allDays) : 99999;
    return { parent, pInfo, kids, groupDays };
  });
  groups.sort((a, b) => a.groupDays - b.groupDays);

  const active = groups.filter((g) => g.groupDays <= SOON_DAYS);
  const later = groups.filter((g) => g.groupDays > SOON_DAYS);

  return (
    <div className="ann-recur">
      <div className="ann-recur-head">
        <div>
          <h2 className="ann-recur-title">定期タスク</h2>
          <p className="ann-recur-note">
            期限の{SOON_DAYS}日前から表示されます。過ぎたものは「期限切れ」。終わったら「完了」で次回へ。
          </p>
        </div>
        <button className="ann-add" onClick={onAdd}>＋ 追加</button>
      </div>

      {tasks.filter((t) => t.freq !== "none").length > 0 && (() => {
        let exp = 0, done = 0;
        for (const t of tasks) {
          const r = recurRateThisYear(t);
          if (r) { exp += r.expected; done += r.done; }
        }
        if (exp === 0) return null;
        return (
          <div className="ann-recur-year-sum">
            📊 今年の実施状況: <b>{done}/{exp}回</b> 完了
            {done < exp && <span className="is-short">（{exp - done}回 未実施）</span>}
            <span className="ann-recur-sum-note">※「✓完了」を押した記録から集計（今日以降の分）</span>
          </div>
        );
      })()}

      {groups.length === 0 && (
        <div className="ann-recur-empty">
          まだ登録がありません。「＋ 追加」から、毎月のレセプト送信や毎年の更新などを登録してください。
        </div>
      )}

      {groups.length > 0 && active.length === 0 && (
        <div className="ann-recur-empty">
          直近{SOON_DAYS}日以内にやることはありません。先の予定は下の「まだ先の予定」から見られます。
        </div>
      )}

      <div className="ann-recur-list">
        {active.map((g) => (
          <RecurGroup key={g.parent.id} g={g}
            onEdit={onEdit} onComplete={onComplete} onUndo={onUndo} />
        ))}
      </div>

      {later.length > 0 && (
        <div className="ann-recur-later">
          <button className="ann-recur-later-toggle" onClick={() => setShowLater((v) => !v)}>
            {showLater ? "▾" : "▸"} まだ先の予定（{later.length}件)
          </button>
          {showLater && (
            <div className="ann-recur-list ann-recur-list-faded">
              {later.map((g) => (
                <RecurGroup key={g.parent.id} g={g}
                  onEdit={onEdit} onComplete={onComplete} onUndo={onUndo} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecurEditor({ existing, tasks, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(existing?.title || "");
  const [parentId, setParentId] = useState(existing?.parentId || "");
  const [freq, setFreq] = useState(existing?.freq || "monthly");
  const [day, setDay] = useState(existing?.day ?? 1);
  const [month, setMonth] = useState(existing?.month ?? 1);
  const [ivl, setIvl] = useState(existing?.interval ?? 3);
  const [weekday, setWeekday] = useState(existing?.weekday ?? 1);
  const [importance, setImportance] = useState(existing?.importance || "");
  const [memo, setMemo] = useState(existing?.memo || "");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () =>
    onSave({
      id: existing?.id ?? null,
      title, parentId, freq,
      day: Number(day), month: Number(month), interval: Number(ivl), weekday: Number(weekday),
      importance, memo,
      baseYear: existing?.baseYear ?? null, baseMonth: existing?.baseMonth ?? null,
    });

  // 親候補：トップ階層のタスク（自分自身・自分の子は除く)。2階層までに制限
  const hasChildren = (tasks || []).some((t) => t.parentId === existing?.id);
  const parentOptions = (tasks || []).filter(
    (t) => !t.parentId && t.id !== existing?.id
  );

  const FREQS = [
    { key: "monthly", label: "毎月" },
    { key: "yearly", label: "毎年" },
    { key: "everyN", label: "数ヶ月ごと" },
    { key: "weekly", label: "毎週" },
    { key: "none", label: "まとめ（期限なし)" },
  ];
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  return (
    <div className="ann-modal-bg" onClick={onClose}>
      <div className="ann-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ann-modal-head">
          <span>{existing ? "定期タスクを編集" : "定期タスクを追加"}</span>
        </div>

        <label className="ann-field-label">やること</label>
        <input
          className="ann-input"
          value={title}
          placeholder="例）レセプト送信"
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="ann-field-label">親タスク（任意・グループ分け)</label>
        {hasChildren ? (
          <p className="ann-recur-hint">このタスクは子タスクを持っているため、親のままにします（2階層まで)。</p>
        ) : (
          <select className="ann-input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">なし（トップに表示)</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.title || "（無題)"}</option>
            ))}
          </select>
        )}

        <label className="ann-field-label">周期</label>
        <div className="ann-lv-pick">
          {FREQS.map((f) => (
            <button
              key={f.key}
              className={"ann-lv" + (freq === f.key ? " is-on" : "")}
              onClick={() => setFreq(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {freq === "none" ? (
          <p className="ann-recur-hint">「まとめ」は期限なしの見出しです。下に子タスクをぶら下げて整理できます。</p>
        ) : (
        <div className="ann-recur-when">
          {freq === "monthly" && (
            <label className="ann-recur-when-row">
              毎月
              <input className="ann-num" type="number" min="1" max="31" value={day}
                onChange={(e) => setDay(e.target.value)} />
              日
            </label>
          )}
          {freq === "yearly" && (
            <label className="ann-recur-when-row">
              毎年
              <input className="ann-num" type="number" min="1" max="12" value={month}
                onChange={(e) => setMonth(e.target.value)} />
              月
              <input className="ann-num" type="number" min="1" max="31" value={day}
                onChange={(e) => setDay(e.target.value)} />
              日
            </label>
          )}
          {freq === "everyN" && (
            <label className="ann-recur-when-row">
              <input className="ann-num" type="number" min="2" max="12" value={ivl}
                onChange={(e) => setIvl(e.target.value)} />
              ヶ月ごと・
              <input className="ann-num" type="number" min="1" max="31" value={day}
                onChange={(e) => setDay(e.target.value)} />
              日
            </label>
          )}
          {freq === "weekly" && (
            <div className="ann-recur-when-row">
              毎週
              <div className="ann-wd-pick">
                {WD.map((w, i) => (
                  <button key={i}
                    className={"ann-wd-btn" + (Number(weekday) === i ? " is-on" : "")}
                    onClick={() => setWeekday(i)}>
                    {w}
                  </button>
                ))}
              </div>
            </div>
          )}
          {freq === "everyN" && (
            <p className="ann-recur-hint">※登録した月を起点に数えます（例：今月＋3ヶ月ごと)。</p>
          )}
        </div>
        )}

        <label className="ann-field-label">重要度</label>
        <div className="ann-lv-pick">
          <button className={"ann-lv" + (importance === "" ? " is-on" : "")} onClick={() => setImportance("")}>
            なし
          </button>
          {LEVELS.map((l) => (
            <button
              key={l.key}
              className={"ann-lv" + (importance === l.key ? " is-on" : "")}
              style={
                importance === l.key
                  ? { background: l.color, borderColor: l.color, color: "#fff" }
                  : { color: l.color, borderColor: l.color }
              }
              onClick={() => setImportance(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>

        <label className="ann-field-label">メモ（任意)</label>
        <textarea
          className="ann-textarea"
          value={memo}
          rows={2}
          placeholder="例）社保・国保の請求分"
          onChange={(e) => setMemo(e.target.value)}
        />

        <div className="ann-modal-actions">
          {onDelete && <button className="ann-btn ann-btn-del" onClick={onDelete}>削除</button>}
          <div className="ann-spacer" />
          <button className="ann-btn ann-btn-ghost" onClick={onClose}>キャンセル</button>
          <button className="ann-btn ann-btn-save" onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}

function HomeView({ data, onComplete, onGoMonth, onGoRecur }) {
  const today = rMid(new Date());
  const year = today.getFullYear();
  const yd = data.years[year] || null;
  const tasks = (data.recurring || []).filter((t) => t.freq !== "none");
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  // 定期タスクは行としては出さず、期限切れの件数だけ小さく知らせる
  const recurOverdueCount = tasks.filter((t) => {
    const due = nextDue(t, today);
    return due && Math.round((rMid(due) - today) / 86400000) < 0;
  }).length;

  const evItems = [];
  const pendingItems = []; // 恒例なのに日付未定
  const scanYear = (y, ydata) => {
    if (!ydata) return;
    for (let m = 1; m <= 12; m++) {
      for (const e of ydata.months[m]) {
        if (e.deletedAt) continue;
        if (e.pendingDate && !e.date) {
          pendingItems.push({ e, m, year: y });
          continue;
        }
        if (!e.date || y !== year) continue;
        const mm = String(e.date).match(/(\d{1,2})\D+(\d{1,2})/);
        if (!mm) continue;
        const due = rMid(new Date(year, Number(mm[1]) - 1, Number(mm[2])));
        const days = Math.round((due - today) / 86400000);
        evItems.push({ kind: "event", e, m: Number(mm[1]), due, days });
      }
    }
  };
  scanYear(year, yd);
  scanYear(year + 1, data.years[year + 1]); // 来年分の「日付未定」も拾う

  const todayItems = evItems.filter((r) => r.days === 0).sort((a, b) => a.due - b.due);
  const weekItems = evItems
    .filter((r) => r.days > 0 && r.days <= 7)
    .sort((a, b) => a.due - b.due);

  const renderRow = (it, key) => {
    const lv = levelOf(it.kind === "recur" ? it.t.importance : it.e.importance);
    const title = it.kind === "recur" ? it.t.title || "（無題)" : it.e.text || "（無題)";
    const dd = it.due;
    return (
      <div className="ann-home-row" key={key}>
        <span className={"ann-home-ico " + it.kind}>{it.kind === "recur" ? "🔁" : "📅"}</span>
        <button
          className="ann-home-main"
          onClick={() => (it.kind === "event" ? onGoMonth(it.m) : onGoRecur())}
        >
          <span className="ann-home-rowtop">
            {lv && (
              <span className="ann-badge" style={{ background: lv.bg, color: lv.color }}>{lv.label}</span>
            )}
            <span className="ann-home-name">{title}</span>
          </span>
          <span className={"ann-home-date" + (it.days < 0 ? " over" : "")}>
            {dd.getMonth() + 1}/{dd.getDate()}（{WD[dd.getDay()]})
            {it.days < 0 ? `・期限切れ（${-it.days}日経過)` : it.days === 0 ? "・今日" : `・あと${it.days}日`}
          </span>
        </button>
        {it.kind === "recur" && (
          <button className="ann-home-done" onClick={() => onComplete(it.t.id)} title="完了">✓</button>
        )}
      </div>
    );
  };

  const empty = !todayItems.length && !weekItems.length && !pendingItems.length;

  return (
    <div className="ann-home">
      <div className="ann-home-greet">
        {today.getMonth() + 1}月{today.getDate()}日（{WD[today.getDay()]})・直近の予定
      </div>
      {recurOverdueCount > 0 && (
        <button className="ann-home-recur-alert" onClick={onGoRecur}>
          🔁 期限切れの定期タスクが <b>{recurOverdueCount}件</b> → 定期タスクへ
        </button>
      )}
      {empty && (
        <div className="ann-recur-empty">直近1週間の予定はありません。お疲れさまです。</div>
      )}
      {pendingItems.length > 0 && (
        <section className="ann-home-sec is-pending">
          <h3 className="ann-home-h">📌 日付が未定の恒例行事（{pendingItems.length}）</h3>
          {pendingItems.map((it, i) => (
            <div className="ann-home-row" key={"p" + i}>
              <span className="ann-home-ico event">📌</span>
              <button className="ann-home-main" onClick={() => onGoMonth(it.m)}>
                <span className="ann-home-rowtop">
                  <span className="ann-home-name">{it.e.text || "（無題)"}</span>
                </span>
                <span className="ann-home-date">
                  {it.year}年{it.m}月・日付を決めてください
                </span>
              </button>
            </div>
          ))}
        </section>
      )}
      {todayItems.length > 0 && (
        <section className="ann-home-sec">
          <h3 className="ann-home-h">今日</h3>
          {todayItems.map((it, i) => renderRow(it, "t" + i))}
        </section>
      )}
      {weekItems.length > 0 && (
        <section className="ann-home-sec">
          <h3 className="ann-home-h">今週（これから7日)</h3>
          {weekItems.map((it, i) => renderRow(it, "w" + i))}
        </section>
      )}
    </div>
  );
}

/* 印刷メニュー */
function PrintMenu({ year, onPrint, onClose }) {
  const [startM, setStartM] = useState(new Date().getMonth() + 1);
  const Item = ({ icon, title, desc, onClick }) => (
    <button className="ann-print-item" onClick={onClick}>
      <span className="ann-print-item-ico">{icon}</span>
      <span className="ann-print-item-body">
        <span className="ann-print-item-title">{title}</span>
        <span className="ann-print-item-desc">{desc}</span>
      </span>
    </button>
  );
  return (
    <div className="ann-modal-bg" onClick={onClose}>
      <div className="ann-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ann-modal-head"><span>🖨 印刷（{year}年）</span></div>
        <Item icon="🗓" title="年間カレンダー" desc="12ヶ月をA4 1枚に。診療/休診/年休/代診を色分け"
          onClick={() => onPrint("yearcal")} />
        <div className="ann-print-item ann-print-item-3m">
          <span className="ann-print-item-ico">🗓</span>
          <span className="ann-print-item-body">
            <span className="ann-print-item-title">3ヶ月カレンダー</span>
            <span className="ann-print-item-desc">選んだ月から3ヶ月をA4 1枚に。予定も日枠に印字</span>
            <span className="ann-print-3m-row">
              <select className="ann-input ann-print-3m-sel" value={startM}
                onChange={(e) => setStartM(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>{m}月から</option>
                ))}
              </select>
              <button className="ann-btn ann-btn-save" onClick={() => onPrint("cal3", startM)}>印刷</button>
            </span>
          </span>
        </div>
        <Item icon="📋" title="予定リスト" desc="1年分の予定を一覧で（1〜2枚）"
          onClick={() => onPrint("list")} />
        <Item icon="🔁" title="定期タスク一覧" desc="タスク×月のチェック表。壁貼り用"
          onClick={() => onPrint("recur")} />
        <Item icon="📄" title="月別ページ（詳細）" desc="1ヶ月1枚×12枚。日ごとの予定＋定期"
          onClick={() => onPrint("monthly")} />
        <div className="ann-modal-actions">
          <div className="ann-spacer" />
          <button className="ann-btn ann-btn-ghost" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

/* 印刷用: 重要度の色 */
const P_IMP = { "高": "#C7402F", "中": "#C77100", "低": "#5B6873", "家": "#0E9F8E" };
const PImp = ({ imp }) =>
  imp ? <span className="pimp" style={{ color: P_IMP[imp] || "#333", borderColor: P_IMP[imp] || "#333" }}>{imp}</span> : null;

/* 日付にあたる予定を取り出す(印刷共通) */
function printEvForDay(events, m, d) {
  return (events || []).filter((e) => {
    if (e.deletedAt) return false;
    const toks = String(e.date || "").match(/(\d{1,2})\D+(\d{1,2})/g) || [];
    return toks.some((tok) => {
      const mm = tok.match(/(\d{1,2})\D+(\d{1,2})/);
      return Number(mm[1]) === m && Number(mm[2]) === d;
    });
  });
}

/* 📋 予定リスト印刷 */
function PrintList({ yd, year, cal }) {
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  return (
    <div className="ann-print">
      <div className="ann-print-page ann-plist">
        <div className="ann-print-head">
          <span className="ann-print-month">予定一覧</span>
          <span className="ann-print-year">{year}年</span>
        </div>
        <div className="ann-plist-cols">
          {MONTHS.map((mo) => {
            const list = yd.months[mo.n].filter((e) => !e.deletedAt);
            return (
              <div className="ann-plist-month" key={mo.n}>
                <div className="ann-plist-mh">{mo.n}月 <span className="ann-plist-en">{mo.en}</span></div>
                {list.length === 0 && <div className="ann-plist-empty">―</div>}
                {list.map((e) => {
                  const wi = e.date && !isRangeDate(e.date) ? weekdayInfo(e.date, year) : null;
                  return (
                    <div className="ann-plist-row" key={e.id}>
                      <span className="ann-plist-date">
                        {e.date || "未定"}{wi ? `(${wi.wd})` : ""}
                      </span>
                      <span className="ann-plist-text">
                        <PImp imp={e.importance} />
                        {e.clinic && <span className="pimp" style={{ color: "#0E9F8E", borderColor: "#0E9F8E" }}>診</span>}
                        <span style={e.importance ? { color: P_IMP[e.importance] } : undefined}>{e.text}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* 🗓 年間カレンダー(12ヶ月を1枚): ミニカレンダー+その月の全予定 */
function PrintYearCal({ yd, year, cal }) {
  const WD1 = ["日", "月", "火", "水", "木", "金", "土"];
  return (
    <div className="ann-print">
      <div className="ann-print-page ann-ycal">
        <div className="ann-ycal-head">
          <span className="ann-ycal-title">{year}年 年間カレンダー</span>
          <span className="ann-ycal-legend">
            <span className="lg lg-off">休診・祝日</span>
            <span className="lg lg-nenkyu">計画年休</span>
            <span className="lg lg-daishin">代診</span>
            <span className="lg lg-kentou">検討中</span>
            <span className="lg lg-dot">●予定あり</span>
          </span>
        </div>
        <div className="ann-ycal-grid">
          {MONTHS.map((mo) => {
            const m = mo.n;
            const dim = new Date(year, m, 0).getDate();
            const first = new Date(year, m - 1, 1).getDay();
            const cells = [];
            for (let i = 0; i < first; i++) cells.push(null);
            for (let d = 1; d <= dim; d++) cells.push(d);
            while (cells.length % 7 !== 0) cells.push(null);
            const weeks = [];
            for (let w = 0; w < cells.length / 7; w++) weeks.push(cells.slice(w * 7, w * 7 + 7));
            const evs = yd.months[m].filter((e) => !e.deletedAt && e.text);
            return (
              <div className="ann-ycal-month" key={m}>
                <div className="ann-ycal-cal">
                  <div className="ann-ycal-mh">{m}月</div>
                  <table className="ann-ycal-table">
                    <thead>
                      <tr>
                        {WD1.map((w, i) => (
                          <th key={i} className={i === 0 ? "sun" : i === 6 ? "sat" : ""}>{w}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {weeks.map((row, wi) => (
                        <tr key={wi}>
                          {row.map((d, di) => {
                            if (d == null) return <td key={di} />;
                            const s = calState(cal, year, m, d);
                            const hasEv = printEvForDay(yd.months[m], m, d).length > 0;
                            const cls =
                              (s === "off" || s === "holiday" ? "c-off" :
                               s === "nenkyu" ? "c-nenkyu" :
                               s === "daishin" ? "c-daishin" :
                               s === "kentou" ? "c-kentou" : "") +
                              (di === 0 ? " sun" : di === 6 ? " sat" : "");
                            return (
                              <td key={di} className={cls}>
                                {d}
                                {hasEv && <i className="ev-dot" />}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="ann-ycal-evs">
                  {evs.length === 0 && <span className="ann-ycal-ev none">予定なし</span>}
                  {evs.map((e) => (
                    <span
                      className="ann-ycal-ev"
                      key={e.id}
                      style={e.importance ? { color: P_IMP[e.importance] } : undefined}
                    >
                      <b>{e.date || "未定"}</b> {e.text}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* 🗓 3ヶ月カレンダー(1枚・予定入り) */
function PrintCal3({ yd, year, cal, startM }) {
  const WD1 = ["日", "月", "火", "水", "木", "金", "土"];
  const months = [0, 1, 2].map((i) => {
    const m0 = startM + i;
    return { m: ((m0 - 1) % 12) + 1, y: year + Math.floor((m0 - 1) / 12) };
  });
  return (
    <div className="ann-print">
      <div className="ann-print-page ann-c3">
        <div className="ann-c3-head">
          <span className="ann-c3-title">
            {year}年 {months[0].m}月〜{months[2].m}月{months[2].y !== year ? `（〜${months[2].y}年）` : ""}
          </span>
          <span className="ann-ycal-legend">
            <span className="lg lg-off">休診・祝日</span>
            <span className="lg lg-nenkyu">計画年休</span>
            <span className="lg lg-daishin">代診</span>
            <span className="lg lg-kentou">検討中</span>
          </span>
        </div>
        {months.map(({ m, y }) => {
          const dim = new Date(y, m, 0).getDate();
          const first = new Date(y, m - 1, 1).getDay();
          const cells = [];
          for (let i = 0; i < first; i++) cells.push(null);
          for (let d = 1; d <= dim; d++) cells.push(d);
          while (cells.length % 7 !== 0) cells.push(null);
          const weeks = [];
          for (let w = 0; w < cells.length / 7; w++) weeks.push(cells.slice(w * 7, w * 7 + 7));
          const evsrc = (y === year ? yd.months[m] : []) || [];
          // 1枚に3ヶ月を収めるため、週数からマスの高さを逆算
          const cellH = ((72 - 4) / weeks.length).toFixed(1);
          return (
            <div className="ann-c3-month" key={m + "-" + y}>
              <div className="ann-c3-band">
                <span className="ann-c3-m">{m}</span>
                <span className="ann-c3-gatsu">月</span>
                {y !== year && <span className="ann-c3-y">{y}年</span>}
              </div>
              <table className="ann-c3-table">
                <thead>
                  <tr>
                    {WD1.map((w, i) => (
                      <th key={i} className={i === 0 ? "sun" : i === 6 ? "sat" : ""}>{w}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((row, wi) => (
                    <tr key={wi} style={{ height: `${cellH}mm` }}>
                      {row.map((d, di) => {
                        if (d == null) return <td key={di} className="empty" />;
                        const s = y === year ? calState(cal, y, m, d) : defaultDayState(y, m, d);
                        const evs = printEvForDay(evsrc, m, d);
                        const cls =
                          (s === "off" || s === "holiday" ? "c-off" :
                           s === "nenkyu" ? "c-nenkyu" :
                           s === "daishin" ? "c-daishin" :
                           s === "kentou" ? "c-kentou" : "") +
                          (di === 0 ? " sun" : di === 6 ? " sat" : "");
                        return (
                          <td key={di} className={cls}>
                            <span className="ann-c3-d">{d}</span>
                            {evs.slice(0, 3).map((e) => (
                              <span
                                className="ann-c3-ev"
                                key={e.id}
                                style={e.importance ? { color: P_IMP[e.importance], fontWeight: 700 } : undefined}
                              >
                                {e.text}
                              </span>
                            ))}
                            {evs.length > 3 && <span className="ann-c3-ev">他{evs.length - 3}件</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* 🔁 定期タスク一覧(タスク×月チェック表) */
function PrintRecur({ tasks, year }) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const tops = tasks.filter((t) => !t.parentId || !byId[t.parentId]);
  const rows = [];
  for (const p of tops) {
    rows.push({ t: p, child: false });
    for (const c of tasks.filter((x) => x.parentId === p.id)) rows.push({ t: c, child: true });
  }
  const occMonths = (t) => {
    const set = new Set();
    if (t.freq === "none") return set;
    for (let m = 1; m <= 12; m++) {
      if (recurInMonth([t], year, m).length > 0) set.add(m);
    }
    return set;
  };
  return (
    <div className="ann-print">
      <div className="ann-print-page ann-prec">
        <div className="ann-print-head">
          <span className="ann-print-month">定期タスク一覧</span>
          <span className="ann-print-year">{year}年</span>
        </div>
        <table className="ann-prec-table">
          <thead>
            <tr>
              <th className="c-title">やること</th>
              <th className="c-freq">周期</th>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <th key={m} className="c-m">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, child }) => {
              const set = occMonths(t);
              return (
                <tr key={t.id} className={child ? "is-child" : ""}>
                  <td className="c-title">
                    {child ? "└ " : ""}
                    <PImp imp={t.importance} />
                    {t.title}
                    {t.memo && <span className="c-memo">　{t.memo}</span>}
                  </td>
                  <td className="c-freq">{recurLabel(t)}</td>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <td key={m} className="c-m">{set.has(m) ? "☐" : ""}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="ann-prec-note">☐＝その月に発生。終わったらチェック。</p>
      </div>
    </div>
  );
}

function PrintSheet({ yd, year, tasks, cal }) {
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const evForDay = (events, m, d) =>
    events.filter((e) => {
      if (e.deletedAt) return false;
      const toks = String(e.date || "").match(/(\d{1,2})\D+(\d{1,2})/g) || [];
      return toks.some((tok) => {
        const mm = tok.match(/(\d{1,2})\D+(\d{1,2})/);
        return Number(mm[1]) === m && Number(mm[2]) === d;
      });
    });
  return (
    <div className="ann-print">
      {MONTHS.map((mo) => {
        const m = mo.n;
        const dim = new Date(year, m, 0).getDate();
        const todo = recurInMonth(tasks, year, m);
        return (
          <div className="ann-print-page" key={m}>
            <div className="ann-print-head">
              <span className="ann-print-month">{m}月</span>
              <span className="ann-print-en">{mo.en}</span>
              <span className="ann-print-year">{year}</span>
            </div>
            <table className="ann-print-table">
              <thead>
                <tr><th className="c-d">日</th><th>予定・やること</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: dim }, (_, i) => i + 1).map((d) => {
                  const dow = new Date(year, m - 1, d).getDay();
                  const evs = evForDay(yd.months[m], m, d);
                  const todos = todo.filter((x) => x.day === d);
                  return (
                    <tr key={d} className={dow === 0 ? "sun" : dow === 6 ? "sat" : ""}>
                      <td className="c-d">{d}<span className="c-wd">{WD[dow]}</span></td>
                      <td>
                        {evs.map((e) => (
                          <span key={e.id} className="ann-print-ev">
                            <PImp imp={e.importance} />
                            <span style={e.importance ? { color: P_IMP[e.importance] } : undefined}>{e.text}</span>
                          </span>
                        ))}
                        {todos.map((x) => (
                          <span key={x.id + "-" + x.day} className="ann-print-ev ann-print-ev-todo">
                            ☐ <PImp imp={x.importance} />🔁{x.title}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
