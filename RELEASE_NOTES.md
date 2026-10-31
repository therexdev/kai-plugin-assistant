# KAI Assistant 0.3.2

Requires KAI Core 0.7.3 or later. Update Core before installing this plugin update.

Fixes Windows launch failures reporting “Plugin code contains an unverified file” after voice or turn detection had been used. These engines now find existing Windows or Electron runtime libraries through their isolated process environment instead of copying DLLs into the signed plugin package. Filesystem caching is also disabled for local speech-model reads.

Updating installs a freshly verified code snapshot while keeping Assistant conversations, settings, connected providers and downloaded voices in the same plugin data folder. Earlier code snapshots and unknown files are not deleted or trusted.

Release checks now run native dependency loading and turn inference twice from read-only runtime files, verify every file remains unchanged, and repeat desktop companion startup using the real Electron utility process. These checks use temporary profiles and synthetic audio; they do not access live accounts, microphones or user data.

The release uses the existing universal payload build and external detached-signature review. Runtime dependencies and native-helper build versions are unchanged.
