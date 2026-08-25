# GLB Label Editor Codex Plugin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **Français**

GLB Label Editor aide les équipes de marque, de design packaging et de contenu e-commerce à transformer rapidement des fichiers GLB de packaging cosmétique existants en propositions d’étiquettes prêtes à être évaluées, modifiées et livrées. À partir d’un modèle de contenant, de textes, d’un logo et de quelques règles de marque, Codex peut identifier les surfaces d’étiquetage, composer les étiquettes avant et arrière, prévisualiser le résultat et organiser les ressources finales.

Le plugin convient aux propositions packaging avant lancement, aux refontes de packagings existants, aux déclinaisons de SKU par parfum ou contenance, aux étiquettes multilingues, aux mises à jour réglementaires ou de listes d’ingrédients, aux comparaisons de versions avant/arrière ainsi qu’aux validations rapides avec les clients et les équipes internes. Un asset 3D existant peut aussi recevoir une étiquette enveloppante, une étiquette de col, un autocollant transparent, une dorure, un embossage, une finition mate ou un vernis UV sélectif sans devoir reconstruire tout le modèle.

Pendant la production, le plugin ouvre automatiquement un aperçu web en direct. Chaque modification apparaît sur la même page afin que l’utilisateur puisse contrôler le résultat en continu. Une exécution terminée peut livrer le GLB étiqueté, un projet modifiable, un aperçu 3D, les images et canaux PBR de chaque surface, ainsi que les manifestes nécessaires au contrôle des spécifications d’impression et de l’intégrité des ressources.

## Installer dans Codex avec une seule commande

```bash
npx --yes --package=https://github.com/rendylong/label-editer/archive/refs/heads/main.tar.gz glb-label-editor-install
```

Les seuls prérequis sont Node.js 22+ et Codex CLI. À l’aide du npm fourni avec Node.js, l’installateur installe les dépendances verrouillées et Playwright Chromium, compile l’éditeur, puis place le plugin exécutable dans `~/.codex/glb-label-editor`. Il ajoute ensuite la marketplace `label-editer`, puis installe et active `glb-label-editor@label-editer`.

Après une installation ou une mise à jour, démarrez une nouvelle session Codex afin de recharger les Skills. Vérifiez l’état du plugin avec :

```bash
codex plugin list --json
```

Le lanceur CLI local installé se trouve dans `~/.codex/glb-label-editor/plugin/bin/label-cli.mjs`. L’installateur exécute réellement `schema --json` avec ce lanceur pour le valider et ne génère aucune configuration MCP.

Pour confier l’installation à un Agent, copiez le prompt de [`INSTALL_WITH_AGENT.md`](INSTALL_WITH_AGENT.md). L’installateur n’exécute pas `curl | sh` et ne gère que `~/.codex/glb-label-editor`.

## Développement local

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

Le dépôt contient une marketplace de développement nommée `label-editer-dev` :

```bash
codex plugin marketplace add /absolute/path/to/label-editer
codex plugin add glb-label-editor@label-editer-dev
```

Le manifeste du plugin se trouve dans [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json). L’installation inclut [`cosmetic-label`](skills/cosmetic-label/SKILL.md) et [`cosmetic-label-editor`](skills/cosmetic-label-editor/SKILL.md), puis génère un lanceur CLI local pointant vers le runtime géré.

## Workflow en deux étapes

L’ordre obligatoire est `$cosmetic-label` → `$cosmetic-label-editor` :

1. `$cosmetic-label` clarifie la demande, rassemble les références, conçoit l’étiquette selon la mise en page, la typographie, les finitions et le contenu, produit les maquettes avant/arrière et crée l’Editor Handoff.
2. L’utilisateur valide l’orientation. S’il demande explicitement une exécution rapide sans interruption, le handoff est marqué `assumed_for_fast_run` et toutes les hypothèses sont exposées.
3. `$cosmetic-label-editor` lit le handoff, inspecte le GLB, résout les meshes stables, génère et valide le Label Spec v2, puis publie l’ensemble des livrables.

L’étape de conception ne devine ni mesh, ni `stableSelector`, ni UV. L’étape de production ne redéfinit pas silencieusement la marque, les textes, la typographie, les couleurs, les finitions ou la hiérarchie du contenu. Le contrat Editor Handoff est décrit dans [`skills/cosmetic-label/references/editor_handoff.md`](skills/cosmetic-label/references/editor_handoff.md).

## Surface de contrôle Agent

| Commande CLI | Fonction | Écrit des fichiers |
| --- | --- | --- |
| `inspect` | Inspecter le GLB et lister les sélecteurs de mesh stables, surfaces candidates, dimensions et état des codecs | Non |
| `project` | Lire Label Spec v2 / Label Project v3 et renvoyer les ID stables, les valeurs complètes et la revision SHA-256 | Non |
| `patch` | Appliquer atomiquement un ensemble d’opérations protégé par revision sur les ID d’area/layer | Oui |
| `validate` | Valider le Label Spec, les ressources, les cibles et les problèmes de design ou d’impression | Non |
| `live` | Ouvrir automatiquement un aperçu web en lecture seule et surveiller le même working spec | Non |
| `preview` | Générer un PNG pour le contrôle visuel de l’Agent | Oui |
| `apply` / `export` | Cuire les ressources, vérifier le GLB et publier l’ensemble des livrables | Oui |
| `open` | Prise en main humaine explicite ; renvoie une URL locale modifiable protégée par jeton | Non |

La séquence recommandée est `inspect` → création/validation du working spec → `live` → boucle `project` / `patch --force` → `validate` → `apply`. Ne devinez jamais une cible à partir d’un nom de nœud ressemblant ; utilisez le `stableSelector` renvoyé par l’inspection. `open` ne fait pas partie du workflow Agent par défaut.

## CLI

Toutes les commandes renvoient la même enveloppe Agent. Avec `--json`, stdout contient exactement un enregistrement JSON ; la progression et les diagnostics sont écrits sur stderr.

```bash
# Afficher le JSON Schema complet de Label Spec v2
node scripts/label-cli.mjs schema --json

# Inspecter un modèle et ses surfaces d’étiquetage candidates
node scripts/label-cli.mjs inspect model.glb --json

# Inspecter le working spec et obtenir ses ID stables et sa revision
node scripts/label-cli.mjs project spec.json --json

# Construire operations.json à partir du résultat project, puis mettre à jour atomiquement le même working spec
node scripts/label-cli.mjs patch spec.json \
  --operations operations.json --output spec.json --force --json

# Valider uniquement la spécification ; ajouter --glb pour valider aussi les cibles du modèle
node scripts/label-cli.mjs validate spec.json --glb model.glb --json

# Ouvrir l’aperçu web visible en lecture seule et rester au premier plan jusqu’à réception d’un signal
node scripts/label-cli.mjs live spec.json --glb model.glb --json

# Appliquer le design et publier le répertoire de sortie complet
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --json

# Utiliser --force uniquement après autorisation explicite d’écraser ; --open est réservé à une prise en main humaine explicite
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --force --open --json

# Produire un seul fichier d’aperçu
node scripts/label-cli.mjs preview spec.json \
  --glb model.glb --output preview.png --view 3d --json

# Réexporter depuis un projet modifiable
node scripts/label-cli.mjs export result/project.lbl.json \
  --glb model.glb --output exported --json

# Maintenir une session locale jusqu’à Ctrl+C
node scripts/label-cli.mjs open spec.json --glb model.glb
```

Codes de sortie : `0` succès ; `2` arguments invalides ; `3` chemin hors des racines autorisées ; `4` Label Spec/projet invalide ; `5` cible absente ou ambiguë ; `6` navigateur indisponible ; `7` échec de reconstruction GLB ; `8` codec non pris en charge ; `9` conflit de sortie ; `10` conflit de revision ; `11` opération patch invalide ; `1` autre erreur interne.

## Label Spec v2

La source unique du schéma est [`src/agent/label-spec-v2.schema.json`](src/agent/label-spec-v2.schema.json), également accessible via `label-cli schema`. Un exemple réel avant/arrière est disponible dans [`tests/fixtures/specs/perfume-front-back-v2.json`](tests/fixtures/specs/perfume-front-back-v2.json).

Structure principale :

```json
{
  "version": 2,
  "assets": {
    "logo": { "path": "./logo.png", "mimeType": "image/png" }
  },
  "areas": [
    {
      "id": "front",
      "name": "Étiquette avant",
      "target": { "stableSelector": "mesh:0/node:2" },
      "surfaceMode": "overlay",
      "side": "front",
      "range": { "uStart": 0.35, "uWidth": 0.3, "vStart": 0.2, "vHeight": 0.6 },
      "layers": []
    }
  ]
}
```

- Utilisez `overlay` pour l’impression directe sur le flacon, les décals transparents et les surfaces du contenant. Réservez `replace` aux meshes d’étiquette indépendants déjà présents dans le modèle.
- Prend en charge les étiquettes avant, arrière et latérales, les tours cylindriques, les flacons plans, les tubes, les couvercles de pot et les bandes de col ou de scellage.
- Le texte prend en charge les zones redimensionnables, le retour automatique, plusieurs lignes, RTL, les balises de langue, la police, la graisse, l’approche, l’interligne, l’alignement et l’écriture horizontale ou verticale.
- Les calques prennent en charge le texte, les images, les formes simples ou décoratives, le réordonnancement par glisser-déposer, le verrouillage, la visibilité et la suppression.
- Les finitions comprennent la dorure, l’embossage, le débossage, le mat, le vernis UV sélectif et le contour, avec génération des canaux Color, Metalness, Roughness et Bump.
- `print` peut enregistrer les dimensions en millimètres, le fond perdu, le rayon des angles, la hauteur minimale du texte, le type de découpe et les tons directs. Les problèmes sont inclus dans les résultats de validation et le manifeste d’impression.

## Répertoire de sortie

Une exécution réussie de `apply` ou `export` publie l’ensemble du résultat uniquement si le répertoire cible n’existe pas encore. Un échec intermédiaire ne laisse aucun livrable partiel. Les répertoires existants ne sont pas écrasés par défaut.

```text
result/
├── labeled.glb
├── project.lbl.json
├── label-spec.normalized.json      # Généré lors de l’application d’un Label Spec
├── print-manifest.json
├── preview-3d.png
├── manifest.json                   # SHA-256, dimensions, validation et contrôle croisé GLB
└── areas/
    ├── front/
    │   ├── color.png
    │   ├── metalness.png
    │   ├── roughness.png
    │   └── bump.png
    └── back/
        └── ...
```

`labeled.glb` embarque les métadonnées complètes du projet `.lbl`. Le GLB exporté est réanalysé indépendamment avec three.js, puis comparé aux meshes cibles et aux UV complets. Le fichier source n’est jamais modifié.

## Limites de sécurité

- Par défaut, les lectures et écritures sont limitées au répertoire de travail courant ; l’appelant peut ajouter explicitement des racines de workspace.
- Les URL distantes d’images et de polices sont désactivées par défaut. Les ressources doivent être des fichiers locaux situés dans une racine autorisée.
- Le navigateur écoute uniquement sur un port aléatoire de `127.0.0.1`. Chaque session utilise un jeton aléatoire de 32 octets vérifié par les routes du modèle, du bootstrap et des livrables.
- `live` lance automatiquement le Chromium fourni par le plugin en mode visible. La page est un aperçu de production en lecture seule que l’Agent n’a ni besoin ni le droit de contrôler.
- La CSP interdit `unsafe-eval` et n’autorise que les scripts de même origine. Les connexions `blob:` sont autorisées uniquement pour le GLB en mémoire du runtime.
- Les répertoires et fichiers individuels sont publiés atomiquement par création temporaire dans le même parent, puis rename. `patch` verrouille l’entrée et la sortie et relit la revision sous verrou afin d’éviter la perte d’écritures concurrentes. Aucun résultat existant n’est écrasé sans `force` explicite.
- L’URL de prise en main humaine est un jeton de capacité local de courte durée et ne doit pas être transmise à des tiers non fiables.

## Limites des codecs et des livrables

- Les GLB standards sont traités directement. Les GLB Draco sont décompressés et normalisés dans le runtime Node.js ; la sortie actuelle ne conserve pas la compression Draco.
- `EXT_meshopt_compression` et `KHR_texture_basisu` renvoient explicitement `UNSUPPORTED_CODEC` au lieu de produire silencieusement un résultat incomplet.
- Les finitions sont des aperçus écran/PBR et des données de séparation, pas une preuve de faisabilité fournisseur. La couleur, le repérage, l’adhérence, le toucher et la découpe doivent être validés par des essais physiques.
- Le plugin ne génère pas actuellement de formes de découpe PDF/AI prêtes pour l’imprimeur et ne remplace pas la validation réglementaire, des codes-barres ou des allégations.

## Développement et vérification du frontend

Le plugin conserve un éditeur autonome complet pour le développement et le design manuel :

```bash
pnpm dev
pnpm test
pnpm build
GLB_LABEL_E2E_MODEL=/absolute/path/to/model.glb pnpm test:plugin-e2e
pnpm plugin:verify
```

Le frontend web utilise React 19, three.js, Konva et `@gltf-transform`. Le runtime navigateur de l’Agent charge le même `dist/` ; le frontend et le plugin ne maintiennent donc pas deux implémentations distinctes de la logique d’étiquetage.
