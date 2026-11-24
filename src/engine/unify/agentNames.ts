/**
 * Names for agent instances, so agents (and the user) can tell them apart when they message each other.
 *
 * Every running agent gets one word from AGENT_NAME_WORDS ("Kernel", "Arp", "Fiber"). A name is exclusive: no two
 * running agents share it (the bus checks the roster when it registers an agent, see agentBusImpl.ts). A chat keeps
 * its name across restarts when it is still free; otherwise it gets a new one.
 */
import { AGENT_NAME_WORDS } from './agentNameWords';

/** Random attempts before scanning the whole pool, which only happens once nearly every name is in use. */
const RANDOM_ATTEMPTS = 64;

function randomWord(): string {
  return AGENT_NAME_WORDS[Math.floor(Math.random() * AGENT_NAME_WORDS.length)];
}

/**
 * A name that is not taken: `preferred` when it is free, else a random word from the pool. If every word is in use,
 * a word with a number ("Kernel 2").
 */
export function pickAgentName(isTaken: (name: string) => boolean, preferred?: string): string {
  const wanted = preferred?.trim();
  if (wanted && !isTaken(wanted)) {
    return wanted;
  }
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
    const word = randomWord();
    if (!isTaken(word)) {
      return word;
    }
  }
  const free = AGENT_NAME_WORDS.filter(word => !isTaken(word));
  if (free.length) {
    return free[Math.floor(Math.random() * free.length)];
  }
  const base = randomWord();
  for (let number = 2; ; number++) {
    const numbered = `${base} ${number}`;
    if (!isTaken(numbered)) {
      return numbered;
    }
  }
}
