import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../src/pi.js';

describe('Pi adapter', () => {
  it('reports native RPC capabilities without claiming OS sandbox enforcement', async () => {
    const adapter = new PiAdapter({ command: 'pi' });
    const capabilities = await adapter.probe({
      launch: { kind: 'managed' },
      env: { PATH: process.env.PATH ?? '/usr/bin' },
    });
    expect(capabilities).toMatchObject({
      protocol: 'rpc',
      supports: {
        cancel: true,
        permissionRequests: true,
      },
      enforcement: {
        filesystem: 'engine',
        network: 'none',
        shell: 'engine',
        gitPush: 'none',
      },
    });
  });
});
