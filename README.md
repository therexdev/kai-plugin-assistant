# KAI Assistant

Private text conversations with the local models installed in KAI Core. This plugin requires **KAI Core 0.2.0 or later** and an installed, ready text model.

## What it does

- Opens the existing KAI chat history from the shared profile, including conversations created by the previous app.
- Generates real replies through Core's local inference broker. There is no cloud fallback or direct network access.
- Saves conversations automatically before requesting a reply and after receiving it. Failed requests can be retried without duplicating the question.
- Finds conversations by title, renames them, favorites them, and deletes them after a native confirmation.
- Stores the preferred local model and reply limit in this plugin's private storage.

Saved attachments and citation metadata are preserved when a legacy chat is continued. This version displays and sends **text only**; image attachments, microphone input, voice output, Brain access, connected accounts, tools, and remote agents are not supported. Long conversations use the latest messages that fit within Core's 16,000-character prompt limit, with a visible context notice; the full saved history remains unchanged.

## Install and use

1. Install KAI Core 0.2.0 or later, then download this repository's signed `.kaiplugin` asset from Releases.
2. In Core, open Plugins → Install package, choose the downloaded file, and review the publisher and requested capabilities before installing.
3. Open KAI Assistant. Select an installed model or install one in Core → Models and refresh the plugin's model list.
4. Start a conversation or open an existing one. Use **Ctrl/⌘ + Enter** to send.

Both Core and the legacy app use the same underlying chat folder. Close the other app before starting Core. Deleting a conversation also deletes it from that shared history. Uninstalling this plugin does not delete saved conversations.

If a save fails, the visible text stays in the current window. Use **Save again** before switching chats or closing the window. If the saved record changed elsewhere, **Save text as new chat** keeps the visible text in a separate conversation while leaving the original and its attachments unchanged. A corrupt or unsafe legacy file is reported and never silently replaced. Very large histories may need to be opened in the legacy app; their original files remain intact.

## Capabilities

| Permission | Purpose |
| --- | --- |
| `models.read` | List ready local models |
| `inference.local` | Request a text reply from the selected local model |
| `assistant.read` | List and read the shared saved conversation history |
| `assistant.write` | Append messages, rename/favorite, and confirm deletion of a conversation |
| `storage.read`, `storage.write` | Save plugin model and reply-limit preferences |

The renderer has no Node.js, filesystem, microphone, wallet, account-token, or direct network access. The reviewed Assistant broker in Core performs bounded, revision-checked, atomic edits to shared history and preserves unknown legacy fields.

## Development

The plugin is plain HTML, CSS, and JavaScript with no build dependencies. Run `npm test` to verify context selection and local model filtering. `plugin/manifest.json` defines the entry point and permissions; every file in `plugin/` is part of the signed package.

A Core checkout is needed only for native integration tests and package signing. Core's Assistant service tests exercise real temporary ChatStore files, corruption refusal, stale revisions, preserved attachments, symlink rejection, and confirmation behavior. The release workflow verifies the pre-signed package against the publisher key and exact source contents before publishing. Never place publisher private keys in source control.
