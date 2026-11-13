import { describe, it, expect } from 'vitest';
import * as store from '../src/services/session-store.js';

describe('reusable router task binding CAS', () => {
  it('rotates task identity in SQLite and rejects stale metadata or stale CAS', () => {
    store.init('router-task-cas-test');
    const session = store.createSession('chat', 'root', 'pool', 'group');
    session.ownerOpenId = 'owner'; store.updateSession(session);
    const a = { taskId: 'A', attemptId: 'a', sourceMessageId: 'm1', title: 'A' };
    const b = { taskId: 'B', attemptId: 'b', sourceMessageId: 'm2', title: 'B' };
    store.updateRouterTask(session, undefined, a);
    const stale = structuredClone(session);
    store.updateRouterTask(session, a, b);
    store.updateSession(stale);
    expect(store.getSessionFresh(session.sessionId)?.routerTask).toEqual(b);
    expect(() => store.updateRouterTask(session, a, undefined)).toThrow();
    store.updateRouterTask(session, b, a);
    expect(store.getSessionFresh(session.sessionId)?.routerTask).toEqual(a);
    store.updateRouterTask(session, a, undefined);
    store.updateSession(stale);
    expect(store.getSessionFresh(session.sessionId)?.routerTask).toBeUndefined();
  });
});
