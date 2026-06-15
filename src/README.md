# 年間やることリスト

Excel「年間やることリスト」をアプリ化したものです。
React + Vite で作成し、Firebase Firestore に保存することで
iPhone・iPad・Mac のどの端末からでも同じ内容を見られます。

---

## できること

- 年度タブ（2026〜、＋ボタンで翌年を追加）
- 12ヶ月グリッド表示。今月は枠が光ります
- 重要度の色分け（高=赤 / 中=橙 / 低=グレー / 家=緑）と絞り込み
- 月ごとに予定を追加・編集・削除（追加すると日付順に自動整列）
- 「来年に向けて」メモ欄
- Googleログインで、全端末リアルタイム同期
- オフラインでも閲覧・編集でき、オンライン復帰時に自動同期

---

## セットアップ手順

### 1. Firebase プロジェクトを用意

まちがい問題ノートと同じ Firebase プロジェクトを使い回しても、
新しく作っても構いません。新規の場合は次の通りです。

1. https://console.firebase.google.com/ で「プロジェクトを追加」
2. 左メニュー **Firestore Database** → 「データベースを作成」（本番モードでOK）
3. 左メニュー **Authentication** → 「始める」→ **Google** を有効化
4. プロジェクトの設定（⚙️）→ 「マイアプリ」で **ウェブアプリ（</>）** を追加
   → 表示される `firebaseConfig` の各値を控えておく

### 2. 環境変数を設定

`.env.example` を `.env.local` という名前でコピーし、控えた値を入れます。

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### 3. ローカルで動作確認

```bash
npm install
npm run dev
```

表示された `http://localhost:5173` を開き、Googleログイン → 2026年のデータが出ればOKです。

### 4. Firestore セキュリティルール

Firebase コンソール → Firestore → 「ルール」を次に置き換えて公開します。
（本人だけが自分のデータを読み書きできる設定）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 共有リストの1ドキュメントだけ、誰でも読み書き可（ログイン不要）
    match /shared/annualTodo {
      allow read, write: if true;
    }
  }
}
```

### 5. GitHub に push

```bash
git init
git add .
git commit -m "初回コミット 年間やることリスト"
git branch -M main
git remote add origin https://github.com/＜ユーザー名＞/＜リポジトリ名＞.git
git push -u origin main
```

### 6. Vercel にデプロイ

1. https://vercel.com/ → 「Add New… → Project」で上記リポジトリを Import
2. Framework は **Vite** が自動検出されます（そのままでOK）
3. **Environment Variables** に、`.env.local` と同じ6つの変数を登録
4. 「Deploy」

### 7. ログインを許可するドメインを追加

Firebase コンソール → Authentication → Settings → 「承認済みドメイン」に
Vercel の本番URL（例 `your-app.vercel.app`）を追加します。
これを忘れると本番でGoogleログインがエラーになります。

---

## メモ

- データは Firestore の `users/（あなたのUID）` ドキュメントに1件で保存されます。
- 最初は空の状態で始まります。各月の「＋追加」から予定を入れてください。
- 予定を追加・編集すると、その月の中で日付（MM/DD）順に自動で並べ替わります。
  日付が空欄（未定）のものは末尾にまとまります。
