// Simulate how the HTML string is built from panelProvider template
const built = `return /\\.(webm|mp4|mov)(\\?|$)/i.test(url || '');`;
console.log('built for browser:', built);

// If the template incorrectly kept double backslashes in the HTML:
const broken = `return /\\\\.(webm|mp4|mov)(\\\\?|$)/i.test(url || '');`;
console.log('broken for browser:', broken);

const url = 'https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/x/idle.webm';
const good = /\.(webm|mp4|mov)(\?|$)/i;
const bad = /\\.(webm|mp4|mov)(\\?|$)/i;
console.log('good', good.test(url));
console.log('bad', bad.test(url));

// What Node produces when evaluating the exact characters from out/panelProvider.js template
const fromOutJs = eval('`' + 'return /\\\\.(webm|mp4|mov)(\\\\?|$)/i.test(url || \'\');' + '`');
console.log('fromOutJs:', fromOutJs);
const reMatch = fromOutJs.match(/\/.+\/i/);
console.log('regex literal text in HTML:', reMatch && reMatch[0]);
console.log('eval that regex vs url:', eval(reMatch[0]).test(url));
