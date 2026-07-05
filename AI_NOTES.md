# AI向け作業メモ（annual-todo / 年間予定表）

このリポジトリの改修をAIに依頼するときは、このファイルを読ませること。

## プロジェクト概要
- 歯科医院の年間予定表アプリ。React 18 + Vite 5 + Firebase 10。Vercelでデプロイ。
- ログイン不要。Firestoreの単一ドキュメント `shared/annualTodo` を全員で共同編集（onSnapshotでリアルタイム同期）。
- コードは `src/App.jsx`（単一ファイル）+ `src/styles.css`。
- 利用者は院長と妻。iPhone/Mac。ホームは「予定だけをスッキリ見せる」方針。

## データ構造（shared/annualTodo）
- `{ yearOrder: [年...], years: { 年: { months: {1..12: [event]}, nextYear: [event] } }, cal: {年:{"m-d": state}}, recurring: [task] }`
- event: `{id, importance(高/中/低/家), date "MM/DD", text, author, clinic, createdAt}`
  - 追加フィールド: `annual`(毎年恒例), `annualRule`("same"|"nthWeekday"|"tbd"), `pendingDate`(日付未定), `copiedFrom`(展開元id), `deletedAt`(ソフト削除), `auto`/`calDay`/`tag`(カレンダー自動反映)
- recurring task: `{id, title, parentId(2階層まで), freq(monthly|yearly|everyN|weekly|none), day, month, interval, weekday, importance, memo, lastDone, doneLog[], createdAt}`
- 保存は `update(mut)` → structuredClone → `persist`(350msデバウンスでsetDoc)。undoStackに変更前を積む。

## 主要機能（壊してはいけないもの）
- 4ビュー: ホーム / リスト(月別) / カレンダー / 定期タスク（横スワイプでも切替）
- ホーム: 予定のみ表示（定期タスクは期限切れ件数の小バッジのみ）、📌日付未定の恒例行事リマインド
- 日分類（診療/休診/祝日/計画年休/代診/検討中）と祝日自動計算、代診・年休はリストへ自動反映
- 🔁恒例行事: 展開ボタンで翌年へ複製（same/第N曜日/未定の3ルール、copiedFromで二重展開防止）
- 期限エスカレーション（3日前黄 is-due3 / 当日赤 is-due0 / 過去薄 is-pastday）
- 🔍横断検索、↩️Undo(直近10回)、📤.ics書き出し、実施率(doneLog集計)
- ソフト削除は取り消し線で2週間残る。A4印刷(PrintSheet)

## 作業ルール
1. 変更前に方針を短く説明し、承認を得てからコードを書く。
2. 変更後は必ず `npm run build` と `npm test` を実行し、`✅ all passed` を確認してから納品する。
3. 新機能を足したら対応するチェックを `tests/ui-test.mjs` にも追加する。
4. 納品は完全なファイルで（差分ではなく丸ごと）。反映手順はターミナルコピペ形式で提示。

## ハマりどころ
- 日本語IME: Enter処理は必ず `!e.nativeEvent.isComposing` でガード。
- Firestoreは単一ドキュメントなので、フィールド追加時は `cleanEvent`/`cleanRecur`/`normalize` の正規化も更新する（undefinedは書けない）。
- 日付は "MM/DD" 文字列。年をまたぐ計算は activeYear を明示的に渡す。
- テストは日付に依存しないよう、モックを new Date() から相対的に組み立てる。
