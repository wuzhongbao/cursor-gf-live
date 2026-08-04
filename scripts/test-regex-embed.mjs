const embedded = `if (/怎么|为什么|吗|[？?]/.test(t)) prefer.push('curious', 'thoughtful');`;
console.log(embedded);
try {
  // eslint-disable-next-line no-new-func
  new Function(embedded);
  console.log('syntax ok');
} catch (e) {
  console.log('syntax fail', e.message);
}
const broken = `if (/怎么|为什么|吗|？|?/.test(t)) prefer.push('curious', 'thoughtful');`;
try {
  new Function(broken);
  console.log('broken unexpectedly ok');
} catch (e) {
  console.log('broken as expected:', e.message);
}
