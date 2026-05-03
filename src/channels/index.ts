// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail — retired 2026-04-21; mailroom now owns Gmail ingestion + exposes
// mcp__messages__* for reads via mailroom-subscriber.

// protonmail — retired 2026-04-21; same as gmail.

// slack

// telegram
import './telegram.js';

// mailroom-subscriber (drains inbox:new events from the mailroom stack
// at ~/containers/data/mailroom/ipc-out/ and dispatches them into the
// configured email target group via the existing onMessage pipeline).
import './mailroom-subscriber.js';

// agentmail — per-group AgentMail inboxes. Each registered group folder may
// own one inbox via AGENTMAIL_INBOX_<FOLDER>=... in .env. Inbound mail comes
// in over a single WebSocket; outbound is via agentmail-mcp inside the
// container. Disabled when AGENTMAIL_API_KEY is absent.
import './agentmail.js';

// whatsapp
