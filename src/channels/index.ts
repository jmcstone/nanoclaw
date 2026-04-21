// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail
import './gmail.js';

// protonmail
import './protonmail.js';

// slack

// telegram
import './telegram.js';

// mailroom-subscriber (drains inbox:new events from the mailroom stack
// at ~/containers/data/mailroom/ipc-out/ and dispatches them into the
// configured email target group via the existing onMessage pipeline).
import './mailroom-subscriber.js';

// whatsapp
