# Assistant 0.3.0 — Foundation architecture

Assistant now ships its own chat storage, provider connections, speech engines, desktop companion, native controls, assets and dependencies. It uses Foundation's documented services and runs while KAI remains open or in the tray.

Brain, connected accounts, saved workflows, and tool execution communicate through explicit plugin services. Selected conversation sharing and workflow-output grants are reviewable and revocable in Assistant Settings.

This is a fresh architecture and data profile. Existing application data is untouched; no migration is performed. Native Assistant code requires full computer/application trust. Renderers remain sandboxed, with exact frame checks and native reviews for sensitive operations.

A universal release requires the dependency build, all supported platform helpers, signature verification, and native checks. The source checkout alone is not an installable native payload.
