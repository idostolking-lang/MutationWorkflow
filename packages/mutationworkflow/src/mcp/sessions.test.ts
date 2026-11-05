import type { ExplorationHandle, ExplorationSession } from '@mutationworkflow/core';
import { silentLogger } from '@mutationworkflow/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplorationRegistry } from './sessions.js';

function fakeHandle(id: string, targetId = 'app') {
  const close = vi.fn(async () => ({ workflows: [], questions: [] }));
  const callTool = vi.fn(async () => ({ content: 'ok' }));
  const handle = {
    id,
    targetId,
    instructions: { system: '', task: '' },
    session: { callTool } as unknown as ExplorationSession,
    openedAt: new Date().toISOString(),
    close,
  } satisfies ExplorationHandle;
  return { handle, close, callTool };
}

describe('ExplorationRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('closes sessions that stay idle, and calls keep them alive', async () => {
    const registry = new ExplorationRegistry({ logger: silentLogger, idleMs: 1000 });
    const { handle, close } = fakeHandle('ses_a');
    registry.add(handle);
    await vi.advanceTimersByTimeAsync(800);
    await registry.call('ses_a', 'observe', {});
    await vi.advanceTimersByTimeAsync(800);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(() => registry.get('ses_a')).toThrow(/No open exploration session ses_a/);
  });

  it('closes every session once on shutdown and refuses new ones', async () => {
    const registry = new ExplorationRegistry({ logger: silentLogger });
    const a = fakeHandle('ses_a', 'one');
    const b = fakeHandle('ses_b', 'two');
    registry.add(a.handle);
    registry.add(b.handle);
    expect(registry.forTarget('two')?.id).toBe('ses_b');
    await Promise.all([registry.closeAll(), registry.closeAll()]);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    const late = fakeHandle('ses_c');
    expect(() => registry.add(late.handle)).toThrow(/shutting down/);
    expect(late.close).toHaveBeenCalledOnce();
  });
});
