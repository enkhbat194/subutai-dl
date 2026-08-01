import type { ReactElement } from 'react';
import { MediaLauncher } from './MediaLauncher';
import { QueueSchedulerLauncher } from './QueueSchedulerLauncher';
import { SubutaiApp } from './SubutaiApp';

export function RootApp(): ReactElement {
  return (
    <>
      <SubutaiApp />
      <QueueSchedulerLauncher />
      <MediaLauncher />
    </>
  );
}
