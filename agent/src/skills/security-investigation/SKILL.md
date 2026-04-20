---
name: security-investigation
description: セキュリティ脆弱性の詳細調査スキル。ユーザーが「詳しく調査して」「詳細を教えて」「レポートにして」「深掘りして」等、明示的に詳細調査を依頼した場合にのみ使用。CVE ID や製品名だけの入力では使用しない。
---

<instructions>
## ツールの使い分け

- CVE ID が指定された場合: nvd_lookup と shodan_cve の両方で MUST 詳細を取得すること
- 製品・キーワード検索の場合: shodan_cve で概要リストを取得し、必要に応じて nvd_lookup で SHOULD 補完すること
- AWS サービス固有の脆弱性の場合: aws_bulletin で AWS 公式 Security Bulletins を MUST 確認すること。詳細が必要なら tavily_extract でリンク先を SHOULD 取得すること
- 対策・ニュースが必要な場合: tavily_search でベンダー勧告やセキュリティブログを SHOULD 検索すること
- 可能な限り複数ソースをクロスリファレンスし、情報の信頼性を SHOULD 高めること

## 重要度の判断

以下の指標を総合的に判断し、優先度を MUST 付けること（CVSS を主指標とする）:

1. CVSS スコア — 脆弱性の技術的深刻度
2. EPSS スコア — 今後30日間に悪用される確率
3. KEV ステータス — CISA が実際の攻撃で確認済みか

優先度ラベル（P1-P5）と SLA を厳密に判定する必要がある場合は、cve-prioritization スキルを SHOULD 活性化して判定ルールを適用すること。
</instructions>

<output_format>
- 回答は日本語の Markdown 形式で MUST 出力すること
- 各情報にはソース URL を MUST 付与すること
- 複数の CVE を報告する場合は、重要度順（CVSS 降順）で MUST ソートすること
- 冒頭に「## 要約」セクション（3行以内）を MUST 含めること
- 要約は最も重要な情報（CVE ID、CVSS、対策の要点）に MUST 絞ること
</output_format>

<constraints>
- 推測や古い知識に基づく情報は MUST NOT 提供しないこと。ツールで取得できた情報のみを MUST 報告すること
- ツールの呼び出しに失敗した場合は、失敗したソースを MUST 明示し、取得できた情報のみで MUST 回答すること
</constraints>
