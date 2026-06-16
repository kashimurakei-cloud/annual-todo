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
        list.map(cleanEvent).filter((e) => !(e.auto && e.text === "日曜診療"))
      );
    }
    years[Number(y)] = {
      months,
      nextYear: sortByDate(
        (src.nextYear || []).map(cleanEvent).filter((e) => !(e.auto && e.text === "日曜診療"))
      ),
    };
  }
  const yearOrder = (raw.yearOrder || Object.keys(years).map(Number))
    .map(Number)
    .sort((a, b) => a - b);
  return { yearOrder, years, cal: raw.cal || {} };
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
  const [view, setView] = useState("list"); // "list" | "cal"
  const [pendingScroll, setPendingScroll] = useState(null);
  const [calPick, setCalPick] = useState(null); // {m, day}
  const [editor, setEditor] = useState(null);
  const [synced, setSynced] = useState(false);
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

  const update = (mut) => {
    const next = structuredClone(data);
    mut(next);
    persist(next);
  };

  const saveName = (name) => {
    const n = name.trim();
    setMyName(n);
    localStorage.setItem(NAME_KEY, n);
    setShowName(false);
  };

  useEffect(() => {
    if (view === "list" && pendingScroll != null) {
      const el = document.getElementById("ann-m" + pendingScroll);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingScroll(null);
    }
  }, [view, pendingScroll]);

  if (!data) {
    return (
      <div className="ann-root">
        <div className="ann-loading">読み込んでいます…</div>
        {showName && <NameModal current={myName} onSave={saveName} onClose={() => setShowName(false)} />}
      </div>
    );
  }

  const yd = data.years[activeYear] || emptyYear();

  const addYear = () => {
    const last = Math.max(...data.yearOrder);
    const ny = last + 1;
    update((d) => {
      d.yearOrder = [...d.yearOrder, ny].sort((a, b) => a - b);
      d.years[ny] = emptyYear();
    });
    setActiveYear(ny);
  };

  const saveEvent = ({ month, id, importance, date, text, clinic }) => {
    if (!text.trim() && !date.trim()) { setEditor(null); return; }
    update((d) => {
      const y = d.years[activeYear];
      const target = month === "next" ? y.nextYear : y.months[month];
      if (id) {
        const i = target.findIndex((e) => e.id === id);
        if (i >= 0) target[i] = { ...target[i], importance, date, text, clinic: !!clinic };
      } else {
        target.push(ev(importance, date, text, myName, clinic));
      }
      sortByDate(target);
    });
    setEditor(null);
  };

  // カレンダーの日の区分を設定（デフォルトと同じなら保存しない)。
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
        </div>

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

      {view === "cal" && (
        <CalendarView
          yd={yd}
          year={activeYear}
          cal={data.cal || {}}
          onPick={(m, day) => setCalPick({ m, day })}
          onJump={jumpToMonth}
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

      {calPick && (
        <CalPicker
          year={activeYear}
          m={calPick.m}
          day={calPick.day}
          current={calState(data.cal || {}, activeYear, calPick.m, calPick.day)}
          onSelect={(state) => { setDayState(activeYear, calPick.m, calPick.day, state); setCalPick(null); }}
          onClose={() => setCalPick(null)}
        />
      )}

      {editor && (
        <Editor
          month={editor.month}
          existing={editing}
          onSave={saveEvent}
          onSoftDelete={editing && !editing.deletedAt ? () => softDelete(editor.month, editor.id) : null}
          onRestore={editing && editing.deletedAt ? () => restore(editor.month, editor.id) : null}
          onHardDelete={editing && editing.deletedAt ? () => hardDelete(editor.month, editor.id) : null}
          onClose={() => setEditor(null)}
        />
      )}

      {showName && (
        <NameModal current={myName} onSave={saveName} onClose={() => setShowName(false)} />
      )}

      <footer className="ann-foot">
        このリンクを知っている人は誰でも閲覧・編集できます。削除した予定は取り消し線で残り、2週間後に自動で消えます。
      </footer>
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
  const lv = levelOf(e.importance);
  const isOther = e.author && e.author !== myName;
  const isDeleted = !!e.deletedAt;
  const isRange = isRangeDate(e.date);
  const cal = !isDeleted && e.date ? gcalUrl(e, year) : null;
  const wi = e.date && !isRange ? weekdayInfo(e.date, year) : null; // 連休のときは曜日を出さない
  let cls = "ann-ev";
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
          : <span className="ann-undated">未定</span>}
        <span className="ann-text">{e.text}</span>
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

function CalendarView({ yd, year, cal, onPick, onJump }) {
  return (
    <div className="ann-cal-wrap">
      <div className="ann-cal-legend">
        {DAY_STATES.filter((s) => s.key !== "open").map((s) => (
          <span key={s.key} className="ann-cal-leg">
            <span className={"ann-cal-swatch " + s.cls} />
            {s.label}
          </span>
        ))}
        <span className="ann-cal-leg"><span className="ann-cal-dot-leg" />予定あり</span>
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
            onPick={onPick}
            onJump={onJump}
          />
        ))}
      </div>
    </div>
  );
}

function MiniMonth({ year, m, en, events, cal, onPick, onJump }) {
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

  let openCount = 0, offCount = 0, nenkyuCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const s = calState(cal, year, m, d);
    if (s === "open" || s === "daishin") openCount++;
    else if (s === "nenkyu") nenkyuCount++;
    else offCount++; // off, holiday
  }

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
          診療{openCount}・<span className="off">休{offCount}</span>
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
              title={st ? st.label : ""}
            >
              {d}
              {evDays.has(d) && <span className="ann-mini-dot" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CalPicker({ year, m, day, current, onSelect, onClose }) {
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

function Editor({ month, existing, onSave, onSoftDelete, onRestore, onHardDelete, onClose }) {
  const [importance, setImportance] = useState(existing?.importance ?? "");
  const [date, setDate] = useState(existing?.date ?? "");
  const [text, setText] = useState(existing?.text ?? "");
  const [clinic, setClinic] = useState(existing?.clinic ?? false);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = month === "next" ? "来年に向けて" : `${month}月の予定`;
  const submit = () => onSave({ month, id: existing?.id ?? null, importance, date, text, clinic });
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

        <button
          className={"ann-clinic-toggle" + (clinic ? " is-on" : "")}
          onClick={() => setClinic((v) => !v)}
        >
          <span className="ann-clinic-check">{clinic ? "✓" : ""}</span>
          🏥 日曜診療日にする
        </button>

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
          onKeyDown={(e) => e.key === "Enter" && onSave(name)}
        />
        <div className="ann-modal-actions">
          <div className="ann-spacer" />
          <button className="ann-btn ann-btn-save" onClick={() => onSave(name)}>保存</button>
        </div>
      </div>
    </div>
  );
}
