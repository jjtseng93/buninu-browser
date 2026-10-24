import {createBrowser} from '../../../lib/headless-shell.js';
const b=await createBrowser({spareRenderer:false});
try {
 await b.context.navigate(new URL('main.qml',import.meta.url).href);
 console.log(JSON.stringify(await b.context.evaluate('localeResult')));
} finally {b.close();}
