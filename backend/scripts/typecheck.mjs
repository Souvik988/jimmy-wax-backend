import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const configs=['apps','packages'].flatMap(group=>readdirSync(join(root,group),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>join(group,x.name,'tsconfig.json')).filter(x=>existsSync(join(root,x))));
if(!configs.length)throw new Error('Typecheck refused: no workspace tsconfigs were discovered.');
let failed=0;
for(const config of configs){const result=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',config,'--noEmit'],{cwd:root,stdio:'inherit'});console.log(`${result.status===0?'PASS':'FAIL'} ${config}`);if(result.status!==0)failed++;}
console.log(`Checked ${configs.length} workspace projects; ${failed} failed.`);
process.exitCode=failed?1:0;
