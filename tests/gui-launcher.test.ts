import { describe, expect, test } from 'bun:test';
import { delimiter } from 'node:path';
import {
  guiBinaryCandidates,
  guiLaunchPath,
  resolveGuiBinary,
} from '../src/run/gui';

describe('native GUI launcher', () => {
  test('prefers explicit binary then source build and packaged app', () => {
    expect(
      guiBinaryCandidates('/repo', {
        LAVALAMP_GUI_BINARY: '/custom/lavalamp-gui',
      }),
    ).toEqual([
      '/custom/lavalamp-gui',
      '/repo/gui/zig-out/bin/lavalamp-gui',
      '/repo/gui/zig-out/Lavalamp.app/Contents/MacOS/lavalamp-gui',
    ]);
  });

  test('returns first existing executable candidate', () => {
    const existing = new Set(['/repo/gui/zig-out/bin/lavalamp-gui']);
    expect(
      resolveGuiBinary('/repo', {}, (path) => existing.has(path)),
    ).toBe('/repo/gui/zig-out/bin/lavalamp-gui');
  });

  test('returns null when GUI has not been built', () => {
    expect(resolveGuiBinary('/repo', {}, () => false)).toBeNull();
  });

  test('launcher prepends repo bin so the native host can resolve lavalamp', () => {
    const path = guiLaunchPath('/repo', { PATH: '/custom/bin' });
    const entries = path.split(delimiter);
    expect(entries[0]).toBe('/repo/bin');
    expect(entries).toContain('/custom/bin');
  });
});
