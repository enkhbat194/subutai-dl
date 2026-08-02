import { readFile, writeFile } from 'node:fs/promises';

async function replaceRequired(path, before, after, alreadyApplied) {
  const source = (await readFile(path, 'utf8')).replace(/\r\n/gu, '\n');
  if (source.includes(before)) {
    await writeFile(path, source.replace(before, after), 'utf8');
    return;
  }
  if (alreadyApplied && source.includes(alreadyApplied)) {
    await writeFile(path, source, 'utf8');
    return;
  }
  throw new Error(`Required N4 TypeScript block was not found in ${path}`);
}

const servicePath = 'apps/desktop/src/main/engines/native-engine-service.ts';

await replaceRequired(
  servicePath,
  `    task.status = {
      ...task.status,
      status: 'waiting',
      downloadSpeed: '0',
      connections: '0',
      errorCode: undefined,
      errorMessage: undefined,
    };
    await this.startTask(task);`,
  `    const resumedStatus: NativeEngineTaskStatus = {
      ...task.status,
      status: 'waiting',
      downloadSpeed: '0',
      connections: '0',
    };
    delete resumedStatus.errorCode;
    delete resumedStatus.errorMessage;
    task.status = resumedStatus;
    await this.startTask(task);`,
  'const resumedStatus: NativeEngineTaskStatus',
);

await replaceRequired(
  servicePath,
  `    task.status = {
      ...task.status,
      status: 'removed',
      downloadSpeed: '0',
      connections: '0',
      errorCode: undefined,
      errorMessage: undefined,
    };`,
  `    const removedStatus: NativeEngineTaskStatus = {
      ...task.status,
      status: 'removed',
      downloadSpeed: '0',
      connections: '0',
    };
    delete removedStatus.errorCode;
    delete removedStatus.errorMessage;
    task.status = removedStatus;`,
  'const removedStatus: NativeEngineTaskStatus',
);

await replaceRequired(
  servicePath,
  `function cloneStatus(status: NativeEngineTaskStatus): NativeEngineTaskStatus {
  return {
    ...status,
    files: status.files?.map((file) => ({ ...file })),
  };
}`,
  `function cloneStatus(status: NativeEngineTaskStatus): NativeEngineTaskStatus {
  const clone: NativeEngineTaskStatus = { ...status };
  if (status.files) clone.files = status.files.map((file) => ({ ...file }));
  return clone;
}`,
  'const clone: NativeEngineTaskStatus',
);

await replaceRequired(
  'apps/desktop/src/main/engines/native-engine-protocol.ts',
  '  push(chunk: Buffer): NativeFrame[] {',
  '  push(chunk: Uint8Array): NativeFrame[] {',
  'push(chunk: Uint8Array)',
);

console.log('N4 TypeScript fixes applied.');
