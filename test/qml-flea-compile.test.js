// Coverage inventory against unchanged sources. Compilation is not a runtime claim.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadQmlGraphSync } from '../lib/qml/loader.js';
import { createQmlDocument } from '../lib/qml/document.js';
import { parseQml } from '../lib/qml/parser.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const flea = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea || !omarchy)(
  'Flea source inventory parses every QML file and reports known unsupported modules',
  () => {
    const sandbox = fleaSandbox(flea, omarchy);
    try {
      const dir = join(sandbox.flea, 'ui');
      let parsed = 0,
        compiled = 0;
      const blocked = [];
      const parseDirectory = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) parseDirectory(file);
          else if (entry.name.endsWith('.qml')) {
            parseQml(readFileSync(file, 'utf8'));
            parsed++;
          }
        }
      };
      parseDirectory(dir);
      for (const name of readdirSync(dir).filter((name) =>
        name.endsWith('.qml'),
      )) {
        const file = join(dir, name),
          url = Bun.pathToFileURL(file).href,
          source = readFileSync(file, 'utf8');
        try {
          const graph = loadQmlGraphSync(
            source,
            url,
            (href) => ({ body: readFileSync(new URL(href)) }),
            {
              importRoots: [
                Bun.pathToFileURL(sandbox.values.QML_IMPORT_PATH + '/').href,
              ],
            },
          );
          const result = createQmlDocument(source, url, {
            graph,
            component: true,
          });
          const error = result.document.querySelector('p')?.textContent;
          if (error) throw Error(error);
          compiled++;
        } catch (error) {
          blocked.push([name, error.message]);
        }
      }
      const expected = {
        PdfViewer: 'QtQuick.Pdf',
        PreviewPdf: 'QtQuick.Pdf',
        PreviewAnimation: 'AnimatedImage',
        PreviewMedia: 'QtMultimedia',
      };
      for (const [file, message] of blocked) {
        expect(expected[file.slice(0, -4)]).toBeDefined();
        expect(message).toContain(expected[file.slice(0, -4)]);
      }
      expect(parsed).toBeGreaterThanOrEqual(239);
      expect(compiled).toBeGreaterThanOrEqual(231);
      console.log(
        `Flea: ${parsed} QML parsed; ${compiled} top-level components compiled; ${blocked.length} explicitly blocked. This is not full runtime coverage.`,
      );
    } finally {
      sandbox.close();
    }
  },
  60000,
);
