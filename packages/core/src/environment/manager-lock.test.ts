import { describe, expect, it } from 'vitest';
import { TargetConfigSchema } from '../schema/target.js';
import { silentLogger } from '../util/logger.js';
import { EnvironmentManager } from './manager.js';

describe('environment locking', () => {
  it('fails fast when another run or exploration holds the target', async () => {
    const manager = new EnvironmentManager({
      rootDir: process.cwd(),
      logger: silentLogger,
      lockTimeoutMs: 50,
    });
    const target = TargetConfigSchema.parse({ id: 'busy', kind: 'web' });
    const first = await manager.start(target);
    await expect(manager.start(target)).rejects.toMatchObject({
      code: 'ENVIRONMENT_FAILED',
      message: expect.stringContaining('busy'),
    });
    await first.stop();
    const second = await manager.start(target);
    await second.stop();
  });
});
