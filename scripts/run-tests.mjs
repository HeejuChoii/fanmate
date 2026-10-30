// scripts/*.test.ts 를 하나씩 실행한다 (실패해도 나머지는 계속 돌리고, 마지막에 실패 목록과 함께 종료 코드 1).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && (!only.length || only.some((o) => f.includes(o)))).sort();
const failed = [];
for (const file of files) {
  console.log(`\n▶ ${file}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(file);
}
console.log(failed.length ? `\n실패 ${failed.length}개: ${failed.join(', ')}` : `\n모두 통과 (${files.length}개)`);
process.exit(failed.length ? 1 : 0);
