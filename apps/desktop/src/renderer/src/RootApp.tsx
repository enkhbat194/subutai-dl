import type { ReactElement } from 'react';
import { BatchDownloadLauncher } from './BatchDownloadLauncher';
import { MediaLauncher } from './MediaLauncher';
import { QueueSchedulerLauncher } from './QueueSchedulerLauncher';
import { SubutaiApp } from './SubutaiApp';
import { TransferSettingsLauncher } from './TransferSettingsLauncher';

export function RootApp(): ReactElement {
  return (
    <>
      <SubutaiApp />
      <BatchDownloadLauncher />
      <TransferSettingsLauncher />
      <QueueSchedulerLauncher />
      <MediaLauncher />
    </>
  );
}
