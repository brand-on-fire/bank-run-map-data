#!/usr/bin/env node
// The collector runs on the runner's preinstalled Node.js; nothing is installed.
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 22)) {
  console.error(`Node.js 22 or later is required; found ${process.versions.node}`);
  process.exit(1);
}
console.log(`Node.js ${process.versions.node}; no packages installed.`);
