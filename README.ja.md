# GLB Label Editor Codex Plugin

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語** | [Français](README.fr.md)

GLB Label Editor は、ブランド、パッケージデザイン、EC コンテンツの各チームが、既存の化粧品パッケージ GLB をレビュー・修正・納品可能なラベル案へ素早く変換するためのプラグインです。容器モデル、コピー、ロゴ、基本的なブランドガイドラインだけでも、Codex がラベル面の特定、表裏ラベルのレイアウト、効果のプレビュー、最終アセットの整理を実行できます。

新製品発売前のパッケージ提案、既存パッケージの改訂、香りや容量が異なる SKU 展開、多言語ラベル、法規・成分表示の更新、表ラベルと裏ラベルの比較、顧客・社内向けの迅速なレビューに適しています。既存の 3D パッケージには、モデル全体を作り直すことなく、巻きラベル、ネックラベル、透明ステッカー、箔、エンボス、マット、スポット UV などの表現を追加できます。

制作中は Web のライブプレビューが自動的に開きます。デザインの更新は同じページへ反映されるため、ユーザーは確認しながら進められます。完了後は、ラベル適用済み GLB、再編集可能なプロジェクト、3D プレビュー、各ラベル面の画像と PBR チャンネル、印刷仕様とアセット整合性を確認するためのマニフェストを取得できます。

## 1 コマンドで Codex にインストール

```bash
npx --yes --package=https://github.com/rendylong/label-editer/archive/refs/heads/main.tar.gz glb-label-editor-install
```

事前に必要なのは Node.js 22+ と Codex CLI だけです。インストーラーは Node.js 付属の npm を使ってロック済み依存関係と Playwright Chromium をインストールし、エディターをビルドして、実行可能なプラグインを `~/.codex/glb-label-editor` に配置します。その後、`label-editer` marketplace を追加し、`glb-label-editor@label-editer` をインストールして有効化します。

インストールまたは更新後は、新しい Codex セッションを開始して Skill を再読み込みしてください。プラグインの状態は次のコマンドで確認できます。

```bash
codex plugin list --json
```

インストール済みローカル CLI ランチャーは `~/.codex/glb-label-editor/plugin/bin/label-cli.mjs` にあります。インストーラーはこのランチャーに対して実際に `schema --json` を実行して検証し、MCP 設定は生成しません。

Agent にインストールを任せる場合は、[`INSTALL_WITH_AGENT.md`](INSTALL_WITH_AGENT.md) のプロンプトをコピーしてください。インストーラーは `curl | sh` を実行せず、`~/.codex/glb-label-editor` だけを管理します。

## ローカル開発

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

このリポジトリには `label-editer-dev` という開発用 marketplace が含まれています。

```bash
codex plugin marketplace add /absolute/path/to/label-editer
codex plugin add glb-label-editor@label-editer-dev
```

プラグインマニフェストは [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) にあります。インストール時には [`cosmetic-label`](skills/cosmetic-label/SKILL.md) と [`cosmetic-label-editor`](skills/cosmetic-label-editor/SKILL.md) の両方が導入され、管理対象ランタイムを指すローカル CLI ランチャーも生成されます。

## 2 段階ワークフロー

必須の順序は `$cosmetic-label` → `$cosmetic-label-editor` です。

1. `$cosmetic-label` が要件を明確化し、参考根拠を集め、レイアウト・書体・加工・内容の 4 観点でラベルを設計し、表裏のモックアップと Editor Handoff を作成します。
2. ユーザーが方向性を承認します。中断しない高速実行をユーザーが明示した場合、引き継ぎ状態を `assumed_for_fast_run` とし、すべての前提を開示します。
3. `$cosmetic-label-editor` が引き継ぎを読み、GLB を検査し、安定した mesh を解決し、Label Spec v2 を生成・検証して、成果物一式を公開します。

設計段階では mesh、`stableSelector`、UV を推測しません。制作段階ではブランド、コピー、書体、色、加工、内容階層を無断で再設計しません。Editor Handoff の契約は [`skills/cosmetic-label/references/editor_handoff.md`](skills/cosmetic-label/references/editor_handoff.md) にあります。

## Agent コントロール面

| CLI コマンド | 用途 | ファイル書き込み |
| --- | --- | --- |
| `inspect` | GLB を検査し、安定した mesh selector、ラベル候補面、寸法、codec 状態を一覧化 | なし |
| `project` | Label Spec v2 / Label Project v3 を読み、安定 ID、完全な値、SHA-256 revision を返す | なし |
| `patch` | area/layer ID に対して revision 保護された操作セットを原子的に適用 | あり |
| `validate` | Label Spec、アセット、対象、デザイン・印刷上の問題を検証 | なし |
| `live` | 読み取り専用 Web プレビューを自動で開き、同じ working spec を継続監視 | なし |
| `preview` | Agent の視覚確認用 PNG を生成 | あり |
| `apply` / `export` | ベイク、GLB クロスチェック、成果物一式の公開 | あり |
| `open` | 明示的な人手引き継ぎ。ローカルのトークン付き編集 URL を返す | なし |

推奨制作順序は `inspect` → working spec の作成・検証 → `live` → `project` / `patch --force` の反復 → `validate` → `apply` です。似たノード名から対象を推測せず、検査結果の `stableSelector` を使用してください。`open` は標準の Agent ワークフローには含まれません。

## CLI

すべてのコマンドは共通の Agent envelope を返します。`--json` 使用時、stdout には JSON レコードを 1 件だけ出力し、進捗と診断は stderr に出力します。

```bash
# 完全な Label Spec v2 JSON Schema を取得
node scripts/label-cli.mjs schema --json

# モデルとラベル候補面を検査
node scripts/label-cli.mjs inspect model.glb --json

# working spec を検査し、安定 ID と revision を取得
node scripts/label-cli.mjs project spec.json --json

# project の結果から operations.json を作り、同じ working spec を原子的に更新
node scripts/label-cli.mjs patch spec.json \
  --operations operations.json --output spec.json --force --json

# 仕様のみを検証。--glb を追加するとモデル対象も検証
node scripts/label-cli.mjs validate spec.json --glb model.glb --json

# 読み取り専用 Web ライブプレビューを表示し、シグナルを受けるまでフォアグラウンドで待機
node scripts/label-cli.mjs live spec.json --glb model.glb --json

# デザインを適用して完全な出力ディレクトリを公開
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --json

# 上書きが明示許可された場合のみ --force を使用。--open は明示的な人手引き継ぎ専用
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --force --open --json

# 単一プレビューファイルを出力
node scripts/label-cli.mjs preview spec.json \
  --glb model.glb --output preview.png --view 3d --json

# 編集可能プロジェクトから再エクスポート
node scripts/label-cli.mjs export result/project.lbl.json \
  --glb model.glb --output exported --json

# Ctrl+C までローカルセッションを維持
node scripts/label-cli.mjs open spec.json --glb model.glb
```

終了コード：`0` 成功、`2` 引数エラー、`3` 許可ルート外のパス、`4` 無効な Label Spec/プロジェクト、`5` 対象の欠落または曖昧さ、`6` ブラウザー利用不可、`7` GLB 再構築失敗、`8` 未対応 codec、`9` 出力競合、`10` revision 競合、`11` 無効な patch 操作、`1` その他の内部エラー。

## Label Spec v2

Schema の唯一の正本は [`src/agent/label-spec-v2.schema.json`](src/agent/label-spec-v2.schema.json) で、`label-cli schema` からも取得できます。実際の表裏ラベル例は [`tests/fixtures/specs/perfume-front-back-v2.json`](tests/fixtures/specs/perfume-front-back-v2.json) にあります。

基本構造：

```json
{
  "version": 2,
  "assets": {
    "logo": { "path": "./logo.png", "mimeType": "image/png" }
  },
  "areas": [
    {
      "id": "front",
      "name": "表ラベル",
      "target": { "stableSelector": "mesh:0/node:2" },
      "surfaceMode": "overlay",
      "side": "front",
      "range": { "uStart": 0.35, "uWidth": 0.3, "vStart": 0.2, "vHeight": 0.6 },
      "layers": []
    }
  ]
}
```

- `overlay` はボトル本体への直接印刷、透明デカール、本体表面に使用します。`replace` はモデル内に独立して存在するラベル mesh にだけ使用します。
- 表・裏・側面ラベル、円筒巻き、平面ボトル、チューブ、ジャー蓋、ネック・封緘帯に対応します。
- テキストはサイズ変更可能なテキストボックス、自動折り返し、複数行、RTL、言語タグ、フォント、ウェイト、字間、行間、配置、横書き・縦書きに対応します。
- レイヤーはテキスト、画像、基本・装飾図形、ドラッグ並べ替え、ロック、表示・非表示、削除に対応します。
- 加工表現は箔、エンボス、デボス、マット、スポット UV、ストロークに対応し、Color、Metalness、Roughness、Bump チャンネルを生成します。
- `print` にはミリ単位寸法、塗り足し、角丸、最小文字高、抜き型、特色版を記録できます。問題は検証結果と印刷マニフェストへ反映されます。

## 出力ディレクトリ

成功した `apply` または `export` は、対象ディレクトリが存在しない場合に限り成果物全体を公開します。途中で失敗しても半端な成果物は残しません。既存ディレクトリは標準では上書きしません。

```text
result/
├── labeled.glb
├── project.lbl.json
├── label-spec.normalized.json      # Label Spec 適用時に生成
├── print-manifest.json
├── preview-3d.png
├── manifest.json                   # SHA-256、寸法、検証、GLB クロスチェック
└── areas/
    ├── front/
    │   ├── color.png
    │   ├── metalness.png
    │   ├── roughness.png
    │   └── bump.png
    └── back/
        └── ...
```

`labeled.glb` には完全な `.lbl` プロジェクトメタデータが埋め込まれます。出力 GLB は three.js で独立して再解析され、対象 mesh と完全な UV が照合されます。入力ファイル自体は変更されません。

## セキュリティ境界

- 既定では現在の作業ディレクトリ内だけを読み書きします。呼び出し側は workspace root を明示的に追加できます。
- リモート画像・フォント URL は既定で無効です。アセットは許可ルート内のローカルファイルである必要があります。
- ブラウザーはランダムな `127.0.0.1` ポートだけにバインドします。各セッションにランダムな 32 バイトトークンを使用し、モデル、bootstrap、成果物の各ルートで検証します。
- `live` はプラグイン付属 Chromium を headful で自動起動します。ページは読み取り専用の制作プレビューであり、Agent は操作する必要も権限もありません。
- ページ CSP は `unsafe-eval` を禁止し、同一オリジンのスクリプトだけを許可します。`blob:` 接続はランタイム自身のメモリ内 GLB にだけ許可します。
- ディレクトリと単一ファイルの成果物は、同じ親ディレクトリ内の一時ファイル・ディレクトリから rename して原子的に公開します。`patch` は入力と出力の両方をロックし、ロック中に revision を再読込して並行書き込みの消失を防ぎます。`force` が明示されない限り既存結果を上書きしません。
- 人手引き継ぎ URL は短時間だけ有効なローカル capability token です。信頼できない第三者に共有しないでください。

## Codec と納品上の境界

- 標準 GLB は直接処理します。Draco GLB は Node.js ランタイムで展開・標準化され、現在の出力は Draco 圧縮を維持しません。
- `EXT_meshopt_compression` と `KHR_texture_basisu` は、不完全な出力を黙って生成せず、明示的な `UNSUPPORTED_CODEC` を返します。
- 加工表現は画面・PBR プレビューと分版データであり、サプライヤーでの実現性を証明するものではありません。色、見当、接着、触感、抜き型は実物校正が必要です。
- 現在、印刷所で直接製版できる PDF/AI 抜き型は生成せず、法規、バーコード、表示文言の審査も代替しません。

## フロントエンド開発と検証

開発と手動設計のため、完全なスタンドアロンエディターも維持しています。

```bash
pnpm dev
pnpm test
pnpm build
GLB_LABEL_E2E_MODEL=/absolute/path/to/model.glb pnpm test:plugin-e2e
pnpm plugin:verify
```

Web フロントエンドは React 19、three.js、Konva、`@gltf-transform` を使用します。Agent ブラウザーランタイムも同じ `dist/` を読み込むため、フロントエンドとプラグインが別々のラベル処理ロジックを保有することはありません。
