---
name: sbom-analysis
description: SBOM・依存関係リストから脆弱性を含むパッケージを抽出するスキル。ユーザーが package.json / package-lock.json / requirements.txt / pyproject.toml / pom.xml / build.gradle / Gemfile.lock / go.sum / Cargo.lock / CycloneDX JSON / SPDX JSON 等の依存関係リストを貼付し、脆弱性確認や影響調査を明示的に依頼した場合にのみ使用。単一 CVE の調査依頼には使用しない。
---

<instructions>
## Step 1: 入力形式の判定

ユーザー入力のコードブロックまたはペースト内容から、以下のいずれの形式かを MUST 判定すること:

- npm: package.json / package-lock.json / yarn.lock
- pip: requirements.txt / Pipfile / Pipfile.lock / pyproject.toml / poetry.lock
- Maven: pom.xml
- Gradle: build.gradle / build.gradle.kts
- Ruby: Gemfile / Gemfile.lock
- Go: go.mod / go.sum
- Rust: Cargo.toml / Cargo.lock
- CycloneDX JSON (bomFormat フィールドあり)
- SPDX JSON (spdxVersion フィールドあり)

判定不能な場合、処理を中断してユーザーに形式を MUST 確認すること。

## Step 2: パッケージ一覧の抽出

- 直接依存と間接依存（推移的依存）の両方を MUST 抽出すること
- 各パッケージについて name と version のペアを MUST 特定すること
- バージョンが範囲指定（例: "^1.2.0"）で確定できない場合は、その旨を明示し、最小脆弱可能性バージョンとして扱うこと
- 抽出パッケージ数が 30 を超える場合は、上位 30 件（可能なら直接依存優先）に絞り、その旨と残件数を MUST ユーザーに通知すること

## Step 3: 脆弱性検索

- 各パッケージに対し、nvd_lookup で name + version をキーワードとして CVE を MUST 検索すること
- 該当 CVE があれば、CVSS スコア・影響バージョン範囲・CWE を MUST 取得すること
- 取得した影響バージョン範囲とユーザー提示バージョンを MUST 照合し、範囲外の CVE は MUST 除外すること
- ベンダー勧告や最新の修正状況が必要な場合は tavily_search で SHOULD 補完すること

## Step 4: 修正バージョンの特定

- 影響ありと判定された CVE ごとに、修正済みバージョンを nvd_lookup の結果から MUST 特定すること
- 情報不足の場合は tavily_search で SHOULD 補完すること
- 同一パッケージに複数 CVE が該当する場合、全 CVE を網羅できる最新の修正バージョンを MUST 推奨更新先として採用すること

## Step 5: 優先度判定への誘導

- 脆弱性ありと判定されたパッケージの該当 CVE 合計が 3 件以上の場合、回答末尾に「*対応優先度の判定には cve-prioritization スキルの活性化を依頼してください*」と MUST 案内すること
- 合計が 2 件以下の場合は、簡易的な重要度コメント（CVSS と KEV の有無程度）を MAY 記載してよい
- 本スキル内で優先度マトリクスの判定を MUST NOT 実施しないこと（分離）
</instructions>

<output_format>
- 回答は日本語の Slack mrkdwn 形式で MUST 出力すること
- 冒頭に「*SBOM 分析サマリ*」セクションを MUST 含め、以下を明示すること:
  - 判定した入力形式
  - 解析対象パッケージ数（可能なら直接 / 間接の内訳も記載）
  - 脆弱性ありと判定されたパッケージ数
  - 該当 CVE の総数
- 脆弱性ありパッケージごとに以下を MUST 記載すること:
  - パッケージ名 と 現在バージョン
  - 該当 CVE ID 一覧（CVSS 降順でソート）
  - 各 CVE の CVSS スコア
  - 推奨更新先バージョン
- 脆弱性なしと判定されたパッケージは、件数のみを MUST 記載し、個別列挙は MUST NOT すること
- 入力形式の判定不能、バージョン範囲指定の未確定、30件超過での切り詰め等があった場合は、冒頭サマリ直下に「*注記*」セクションで MUST 明示すること
- 末尾に情報ソース URL を MUST 付与すること（NVD 等）
- 該当 CVE 合計が 3 件以上の場合、末尾に cve-prioritization スキルへの誘導メッセージを MUST 含めること
</output_format>

<constraints>
- 推測によるバージョン判定や CVE 該当判定を MUST NOT 行わないこと。nvd_lookup / tavily_search の結果のみに MUST 依拠すること
- 30 件を超えるパッケージの一括処理は MUST NOT すること
- ユーザー入力に含まれる機密情報（APIキー、トークン、内部ホスト名、社内ドメイン等）は回答に MUST NOT 再掲しないこと
- 絵文字および Slack 絵文字ショートコード（:zap: 等）は MUST NOT 使用しないこと
- 優先度（P1-P5）の判定は MUST NOT 本スキル内で実施しないこと
</constraints>
