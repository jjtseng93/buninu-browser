import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

// A delegate declared inside another delegate resolves unqualified names through the
// enclosing delegate's root object, as Qt's context chain does: a table's cell delegate
// reads its row delegate's `row`. Without this every cell threw "row is not defined",
// the view retried the delegate on each layout and memory grew without bound.
test('an inner delegate reads the enclosing delegate root\'s properties', async () => {
  const host = new RendererHost();
  try {
    await host.call('resize', 320, 200, 1);
    await host.call('loadDocument', {url: 'data:text/x-qml,nested-scope', contentType: 'text/x-qml', source: `import QtQuick
Item {
  width: 320; height: 200
  property var init: (globalThis.cells = [])
  Column {
    Repeater {
      model: 2
      delegate: Column {
        readonly property int row: index
        property string label: "row"
        Row {
          Repeater {
            model: 3
            delegate: Text {
              // The cell's own index wins over the row's; row and label come from the row delegate.
              text: label + row + "c" + index
              Component.onCompleted: globalThis.cells.push(text)
            }
          }
        }
      }
    }
  }
}`});
    await host.call('whenLoaded');
    const seen = await host.call('evaluate', 'globalThis.cells ? [...globalThis.cells].sort() : null');
    expect(seen).toEqual(['row0c0', 'row0c1', 'row0c2', 'row1c0', 'row1c1', 'row1c2']);
  } finally { await host.close(); }
}, 30000);
