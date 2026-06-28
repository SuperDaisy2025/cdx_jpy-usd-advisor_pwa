# USD/JPY Advisor PWA

100万円を元手に、毎朝8時のルールベース予測で円からドルへ動かす比率を決め、1時間ごとの含み損益を確認するためのPWA初期版です。実売買は行わず、シミュレーション専用です。

## 初期仕様

- 主表示は `USD/JPY`
- 補助的に `JPY/USD` へ拡張可能
- 取引は円現金とドル現金の交換のみ
- レバレッジなし
- 1日の最大移動比率は資金の50%
- IMM円ポジションを売買比率スコアに明示的に組み込む
- 評価額は1時間ごとに更新する前提

## おすすめデータソース

- 為替の日次・履歴: Frankfurter API。APIキー不要で運用しやすいです。
- 為替の1時間足: Alpha Vantage FX_INTRADAY。無料枠はありますがAPIキーと制限があります。
- IMM/COT: CFTC公式のCommitments of Tradersデータ。週次更新です。
- ニュース: NewsAPI、GDELT、または信頼できるRSS。GitHub ActionsではAPIキーをSecretsに入れる運用が現実的です。

## GitHub Actions運用案

`.github/workflows/update-advisor.yml` は毎日08:00 JST相当のスケジュールで `scripts/update-data.mjs` を実行する想定です。GitHub ActionsのcronはUTCなので、JST 08:00はUTC 23:00です。

## ローカル確認

静的ファイルなので、`index.html` をブラウザで開けば確認できます。Service Workerまで確認する場合はローカルサーバーで配信してください。
