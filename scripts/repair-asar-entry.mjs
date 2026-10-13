import {createRequire} from 'node:module';import fs from 'node:fs';import crypto from 'node:crypto';
const require=createRequire(new URL('../vendor/codex-plus-plus/patch/package.json',import.meta.url));const asar=require('@electron/asar');
const archive=process.argv[2];if(!archive)throw Error('Specify a staged archive');
const {header,headerString}=asar.getRawHeader(archive);const entry=header.files['package.json'];
const data=asar.extractFile(archive,'package.json');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blocks=[];for(let n=0;n<data.length;n+=entry.integrity.blockSize)blocks.push(sha(data.subarray(n,n+entry.integrity.blockSize)));
entry.integrity.hash=sha(data);entry.integrity.blocks=blocks;
const replacement=Buffer.from(JSON.stringify(header));const original=Buffer.from(headerString);
if(replacement.length!==original.length)throw Error('Header size changed; refuse in-place rewrite');
const fd=fs.openSync(archive,'r+');try {const before=Buffer.alloc(original.length);fs.readSync(fd,before,0,before.length,16);if(!before.equals(original))throw Error('Unexpected header offset');fs.writeSync(fd,replacement,0,replacement.length,16);fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
console.log('Staged package.json integrity metadata repaired; validation retained.');
