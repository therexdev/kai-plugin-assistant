# KAI Assistant

The original KAI chat workspace and desktop companion, installed as a KAI Core plugin. Its chat renderer, styles, advanced modes, provider settings, voice controls and mascot use the original application implementations.

## Included experience

- Original conversation rail, full-text search, favorites, rename, delete, welcome screen and prompt cards.
- Chat, Research, Agent, Research team, Analyst team and Write & review team.
- Local models, Koinos Network credits and private OpenAI/Anthropic connections, with their original routing and payment controls.
- Streaming, cancellation, regenerate, citations, text and image attachments, personas and custom instructions.
- Reviewed Brain recall and connected actions through the original companion engine.
- Microphone input and local transcription, read-aloud, and the animated desktop companion with its original voice, wake-word, Eyes and reviewed computer controls.
- Original provider configuration, language settings and paid-credit priority.

Core owns model inference, secure credentials, network policy, payment journals and native approvals. Plugin renderers have no unrestricted network, filesystem or IPC access. Voice, camera and computer actions retain their native permission checks. Other installed feature screens open in their own plugin windows.

Saved conversations stay in the existing Koinos AI profile. Images, citations, personas and unknown legacy metadata are retained. Changed or corrupt records are not silently overwritten. Core and the earlier app must not run against that profile together.

## Development

Run `npm test`. Core contains service, streaming, native sender, storage-preservation and desktop integration checks. Core and this plugin must be updated together for the restored feature APIs. Releases are signed by the existing KAI publisher; private signing keys never belong in this repository.
