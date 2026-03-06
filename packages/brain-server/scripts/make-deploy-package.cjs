#!/usr/bin/env node
// Generates a production package.json in dist/ that strips workspace/file dependencies.
// Only external deps (pg, nats) remain — everything else is bundled by esbuild.
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const deploy = {
  name: p.name,
  version: p.version,
  type: p.type,
  scripts: { start: p.scripts.start },
  dependencies: {
    nats: p.dependencies.nats,
    pg: p.dependencies.pg,
  },
};
fs.writeFileSync('./dist/package.json', JSON.stringify(deploy, null, 2));
console.log(`Generated dist/package.json for ${p.name}@${p.version}`);
