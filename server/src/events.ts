import { EventEmitter } from 'node:events';

/** In-process pub/sub used to push live updates to SSE clients. State itself always lives in the DB. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const channels = {
  campaign: (id: number) => `campaign:${id}`,
  discovery: (id: number) => `discovery:${id}`,
};
