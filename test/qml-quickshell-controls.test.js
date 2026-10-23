// Opt-in comparison against the genuine binary; no Quickshell implementation source.
import { test, expect } from 'bun:test';
import { withQuickshellFixture } from './helpers/quickshell-fixture.js';
test.skipIf(!process.env.BUNINU_QS_ROOT)(
  'real Quickshell DialogButton activates by click, Enter and Space; disabled stays inert',
  async () => {
    await withQuickshellFixture(
      'button.qml',
      async ({ land, title, until, click, key }) => {
        await until(() => title() === 'Flea buttons | 0');
        await Bun.sleep(300);
        await click(50, 36);
        await until(() => title() === 'Flea buttons | 1');
        await key('Enter', 'Enter');
        await until(() => title() === 'Flea buttons | 2');
        await key(' ', 'Space');
        await until(() => title() === 'Flea buttons | 3');
        await click(50, 86);
        expect(title()).toBe('Flea buttons | 3');
        await Bun.write(
          '/tmp/quickshell-flea-buttons.png',
          Buffer.from(
            await land.context.screenshot({ format: 'png' }),
            'base64',
          ),
        );
      },
    );
  },
  30000,
);

test.skipIf(!process.env.BUNINU_QS_ROOT)(
  'real Quickshell DialogField forwards edits, Enter, Tab and Shift-Tab',
  async () => {
    await withQuickshellFixture('field.qml', async ({ title, until, key }) => {
      await until(() => title() === 'Flea field | first | 0:0:0');
      await key('a', 'KeyA', 2);
      await key('h', 'KeyH');
      await until(() => title() === 'Flea field | h | 1:0:0');
      await key('Enter', 'Enter');
      await key('Tab', 'Tab');
      await until(() => title() === 'Flea field | h | 1:1:1');
      await key('Tab', 'Tab', 8);
      await until(() => title() === 'Flea field | h | 1:1:0');
    });
  },
  30000,
);

test.skipIf(!process.env.BUNINU_QS_ROOT)(
  'real Quickshell reports empty and clipped multiline Text counts',
  async () => {
    await withQuickshellFixture(
      'text-metrics.qml',
      async ({ title, until }) => {
        await until(() => title()?.startsWith('Text metrics | 0:'));
        const fields = title().split(' | ')[1].split(':');
        expect(Number(fields[1])).toBeGreaterThan(0);
        expect(fields.slice(2).join(':')).toBe('1:1:2:2:true');
      },
    );
  },
  30000,
);
