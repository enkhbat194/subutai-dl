import { readFile, writeFile } from 'node:fs/promises';

const path = 'apps/desktop/src/main/subutai-runtime.ts';
const source = await readFile(path, 'utf8');
const before = "    if (job.engine !== 'media') await rm(join(job.destination, `${job.filename}.aria2`), { force: true });";
const after = `    if (job.engine !== 'media') {
      const destinationPath = join(job.destination, job.filename);
      await Promise.all([
        \`${'${destinationPath}'}.subutai.part\`,
        \`${'${destinationPath}'}.subutai.job\`,
        \`${'${destinationPath}'}.subutai.job.a\`,
        \`${'${destinationPath}'}.subutai.job.b\`,
      ].map((path) => rm(path, { force: true })));
    }`;

if (!source.includes(before)) {
  if (source.includes('.subutai.job.b')) {
    console.log('N4 runtime cleanup is already applied.');
    process.exit(0);
  }
  throw new Error('N4 legacy cleanup line was not found.');
}

await writeFile(path, source.replace(before, after), 'utf8');
console.log('N4 runtime cleanup applied.');
