// Khronos glTF validator on each file: errors, warnings and the first messages.
import validator from 'gltf-validator';
import fs from 'node:fs';
for (const f of process.argv.slice(2)) {
  const r = await validator.validateBytes(new Uint8Array(fs.readFileSync(f)), { maxIssues: 50 });
  const i = r.issues;
  console.log(f.split('/').pop(), `errors ${i.numErrors} warnings ${i.numWarnings} infos ${i.numInfos}`);
  for (const m of i.messages.filter((m) => m.severity <= 1).slice(0, 12)) console.log('   ', m.severity === 0 ? 'ERR' : 'WARN', m.code, m.message.slice(0, 160), m.pointer || '');
}
