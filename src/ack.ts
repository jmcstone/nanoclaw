// Random "I'm on it" ack sent when a user message kicks off a fresh agent run.
// The agent itself can take 5-15+ minutes on briefing/research tasks, so an
// instant orchestrator-side reply tells the user "received, working on it".

const ACK_PHRASES: readonly string[] = [
  'On it! 🫡',
  'Got it — diving in. 🤿',
  'Heard you, working on it... 👂',
  'Reading and thinking... 🤔',
  'On the case. 🔍',
  'Coming right up. 🍳',
  'Cooking something up... 👩‍🍳',
  'Roger that — give me a sec. 📡',
  'Hold tight, I am on it. 🤞',
  'Loud and clear, working... 📻',
  'Got it! Let me dig in. ⛏️',
  'Right on it... 🏃‍♀️',
  'Spinning up — back in a sec. 🌀',
  'Brain engaged, working... 🧠',
  'Pulling on my thinking cap... 🎩',
  'On it like a bonnet. 🎀',
  'Reading your note, will reply shortly. 📖',
  'Wheels turning... ⚙️',
  'Mulling it over... 🍷',
  'One moment — chewing on this. 🦷',
];

export function pickAckPhrase(): string {
  return ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
}
