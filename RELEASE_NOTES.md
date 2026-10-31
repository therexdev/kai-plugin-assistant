# KAI Assistant 0.3.3

Restores the robot artwork and gradient **Open KAI** button in the upper-right corner. Buttons throughout Assistant use consistent typography, spacing, focus states and gradients while keeping the existing workspace layout.

Fixes chat streams that stop updating when the model briefly has no output. Cancellation also reaches requests waiting for response headers, and late responses are cleaned up without affecting other work.

Use KAI Core Beta 0.7.9 or later for the matching shared-model queue, preparation and startup responsiveness fixes. Conversations, provider settings and downloaded voices stay in the same plugin data folder.

This release retains the reviewed universal native payload, external publisher signature and cross-platform native companion checks. No live accounts, microphones or user data are used in release tests.
