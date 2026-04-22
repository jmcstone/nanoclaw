import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional: a channel can request the engine spawn a container for a
  // group immediately, bypassing the main loop's POLL_INTERVAL. Used by
  // mailroom-subscriber for `inbox:urgent` events so urgent surfacing
  // doesn't wait the (worst case) 2s polling latency. No-op when the
  // group is already active or at concurrency limit — engine handles
  // the queueing semantics.
  requestImmediateProcessing?: (chatJid: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
