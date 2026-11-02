# KAI Assistant for Foundation

KAI Assistant is an independently installed native plugin. It owns chat history, advanced chat and research UI, private model providers, speech and listening engines, desktop controls, the animated desktop companion, its assets and its dependencies. Core does not contain Assistant engines or serve its assets.

Requires Foundation package schema 2 / API 3 and native API v1. Version 0.3.0 uses a fresh plugin data directory; it does not migrate or change an older Koinos AI profile.

## Trust and data

Assistant uses the **native** runtime and requires explicit full computer/application trust. Its UI and floating companion remain sandboxed, but the installed native service itself is not confined from same-user files. Provider credentials and action receipts use OS encryption in Assistant's own data directory. Conversation files also remain in this plugin's directory.

Brain memories, connected accounts, workflows, and tool servers belong to their respective plugins. Assistant uses declared `kai.brain`, `kai.connections`, `kai.workflows`, and `kai.tools` services. Missing optional plugins produce a useful installation message; basic local chat and desktop launch work independently. Paid agent execution belongs to Tools. Core performs shared model inference, network policy, and payment authorization.

The floating desktop companion uses a plugin-owned loopback server with a random session token, a private Electron session, a fixed asset map, and exact frame checks. Unauthenticated local HTTP requests are refused.

## Shared conversation service

`kai.assistant` exports `models.privateEligible`, `chats.list`, `chats.get`/`chats.read`, `chats.save`, `chats.grant`, `chats.grantWrite`, `chats.restrict`, and `chats.revoke`. The host supplies the authenticated calling plugin ID. Remote execution contexts are refused.

Reading chat metadata or an ungranted chat requires attended native approval. `chats.grant({ids})` permits only selected conversations to be read by that caller in the background. `chats.grantWrite({scope,name})` permits new conversations for an exact reviewed workflow scope; it cannot overwrite an existing chat. Users revoke grants under Assistant Settings → Conversation access.

## Build and verification

```sh
npm ci --ignore-scripts
npm test
node scripts/build-windows-voice.js      # Windows build job
node scripts/build-windows-computer.js   # Windows build job
node --max-old-space-size=4096 scripts/prepare-runtime.js
node --max-old-space-size=4096 scripts/assemble-unsigned.js
```

The Windows job uploads the two helpers. Universal assembly uses that artifact, lockfile-pinned runtime dependencies, and integrity-checked native packages for Windows x64, Linux x64, and macOS x64/arm64. No installation scripts are run on the client. Voice model downloads remain explicit plugin actions and are hash-pinned.

Generated `.build/plugin` is the package input. The source `plugin/` folder alone is not a complete release: it intentionally excludes generated native dependencies and voice assets. CI uploads `assistant-unsigned-payload`, containing `unsigned-plugin.json`, `unsigned-metadata.json`, and `runtime-build.json`.

A reviewer downloads and signs that exact artifact outside CI. Commit only `release-signature.json` with `{schema:1,buildRunId,sourceCommit,payloadSha256,publicKey,signature}`. The release workflow checks that the referenced build completed successfully in this repository at that source commit, downloads that exact build, and verifies its metadata, payload digest and Ed25519 signature over the versioned manifest/file-digest table. It also compares every current plugin source file against the reviewed payload and checks required native assets before publishing the `.kaiplugin`. The release commit may add packaging or review metadata, but cannot change plugin runtime files after review. It does not overwrite an existing release.

For a local author-only build using already installed dependencies, `--deps /path/to/dependency-project --current-platform --offline` is available. The resulting package contains its own dependency files and never uses that path at runtime.

`npm run test:native` exercises the real desktop companion against `.build/plugin` with synthetic local models and a temporary profile. It does not test microphones, paid requests, external account actions, or Windows native automation on Linux.

## Interface language

This plugin follows the language saved in KAI Core Settings and applies changes to open views. English, Spanish, Brazilian Portuguese, French and German are supported through bundled offline catalogs. User content and identifiers stay literal. These source changes require Core 0.7.17+ for the live locale API; release the Core update before publishing a new signed plugin package and catalog entry. See the [public localization API](https://github.com/therexdev/kai-core/blob/main/docs/foundation/PLUGIN_AUTHOR_GUIDE.md#shared-language-and-localization-core-0717).
