---
name: mitre-attack-mapping
description: 脆弱性・攻撃事例・脅威アクターを MITRE ATT&CK Enterprise フレームワークの戦術・技術 ID にマッピングするスキル。ユーザーが「ATT&CK で分類」「MITRE マッピング」「TTP で整理」「技術IDを教えて」「攻撃チェーンを戦術別に」等、MITRE 分類を明示的に依頼した場合にのみ使用。
---

<instructions>
## Step 1: マッピング対象の特定

ユーザー入力から以下のいずれかを MUST 特定すること:
- CVE ID (例: CVE-2021-44228)
- 事例名・インシデント名 (例: MOVEit 侵害、SolarWinds)
- 攻撃手法の説明文
- 脅威アクター名 (例: APT29, Cl0p, Lazarus)

複数が混在する場合は、それぞれ独立して MUST マッピングすること。

## Step 2: 情報収集

- CVE の場合: nvd_lookup で CWE・影響・悪用手法を MUST 取得すること
- 事例・インシデントの場合: tavily_search で攻撃チェーンの一次情報（ベンダーレポート、CISA 勧告等）を MUST 取得すること
- 脅威アクターの場合: tavily_search で公開されている TTP 情報を MUST 取得すること
- 取得できた情報のみを根拠に MUST マッピングすること。一次情報が得られなかった部分は「情報不足」と MUST 明示すること

## Step 3: ATT&CK マッピング

### 戦術 (Tactic) の選択

MITRE ATT&CK Enterprise Matrix の 14 戦術から該当するものを MUST 選択すること:

- Reconnaissance (TA0043)
- Resource Development (TA0042)
- Initial Access (TA0001)
- Execution (TA0002)
- Persistence (TA0003)
- Privilege Escalation (TA0004)
- Defense Evasion (TA0005)
- Credential Access (TA0006)
- Discovery (TA0007)
- Lateral Movement (TA0008)
- Collection (TA0009)
- Command and Control (TA0011)
- Exfiltration (TA0010)
- Impact (TA0040)

### 技術 (Technique) の特定

- 各戦術に対し、具体的な技術 ID を MUST 特定すること（例: T1190 Exploit Public-Facing Application）
- サブ技術が存在する場合は、サブ技術 ID も MUST 記載すること（例: T1059.001 PowerShell）
- 攻撃チェーンが複数段階にわたる場合は、各段階の T コードを時系列順に MUST 配列すること

### 検証

- マッピングの根拠（CVE の CWE / 公開された攻撃手法の記述等）を各技術 ID に MUST 付記すること
- 推測に基づくマッピングを MUST NOT 含めないこと。不明な段階は「情報不足」と MUST 明示すること
- T コード・TA コードの捏造を MUST NOT すること。不確かな場合は tavily_search で MUST 裏取りし、裏取り不能なら該当エントリを MUST 除外すること
</instructions>

<output_format>
- 回答は日本語の Slack mrkdwn 形式で MUST 出力すること
- 冒頭に「*MITRE ATT&CK マッピング*」セクションを MUST 含め、以下を明示すること:
  - 対象（CVE ID / 事例名 / 脅威アクター名）
  - 参照した ATT&CK のバージョン（不明な場合は「Enterprise 最新」）
  - 参照日（今日の日付）
- 攻撃チェーンを戦術（日本語訳 + TA コード）ごとにグループ化し、時系列順に MUST 記載すること
- 各技術エントリは以下を MUST 含めること:
  - 技術 ID (例: T1190)
  - 技術名（日本語訳 + 英語原名）
  - マッピング根拠（CWE や公開情報のどの部分から導いたか）
- 情報不足の戦術・技術は「情報不足」と MUST 明示し、推測で埋めないこと
- 末尾に ATT&CK 公式ドキュメントへのリンクを MUST 付与すること（https://attack.mitre.org/techniques/<技術ID>/ 形式、サブ技術は https://attack.mitre.org/techniques/<親ID>/<サブID>/ 形式）
</output_format>

<constraints>
- T コード・TA コード・サブ技術 ID を MUST NOT 捏造しないこと
- ATT&CK for ICS や ATT&CK for Mobile と Enterprise を MUST NOT 混同しないこと。本スキルは Enterprise を MUST 既定とする
- 絵文字および Slack 絵文字ショートコード（:zap: 等）は MUST NOT 使用しないこと
- 推測で攻撃チェーン全体を補完 MUST NOT 。観測されていない戦術は空欄にするか「情報不足」と明示すること
</constraints>
