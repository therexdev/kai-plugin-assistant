# KAI Assistant 0.3.1

Requires KAI Core 0.7.3 or later. Update Core before installing this plugin update.

Tool approvals, Analyst execution consent, voice setup approval and memory-save errors now use Core’s styled dialogs. Confirmations wait for the actual answer, and cancelling leaves the requested approval off. Voice setup cannot open duplicate approval dialogs while a response is pending.

The language dialog now matches the app’s light colors and font. The run-budget dialog has a clear close button and grouped actions. Closing or pressing Escape after reopening a budget review cannot reuse an earlier approval.

Chat, agents and research, desktop providers, speech engines and the desktop companion retain their existing features and plugin-owned data. Native execution still requires explicit full computer/application trust; renderer sandboxing and sensitive-action reviews remain in place.

The release uses the existing universal payload build and external detached-signature review. Runtime dependencies and native-helper build versions are unchanged.
