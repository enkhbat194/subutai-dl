import type { ReactElement } from 'react';
import { BatchDownloadLauncher } from './BatchDownloadLauncher';
import { MediaLauncher } from './MediaLauncher';
import { ResilienceLauncher } from './ResilienceLauncher';
import { QueueSchedulerLauncher } from './QueueSchedulerLauncher';
import { SubutaiApp } from './SubutaiApp';
import { TransferSettingsLauncher } from './TransferSettingsLauncher';

export function RootApp(): ReactElement {
  return (
    <>
      <SubutaiApp />
      <ResilienceLauncher />
      <BatchDownloadLauncher />
      <TransferSettingsLauncher />
      <QueueSchedulerLauncher />
      <MediaLauncher />
    </>
  );
}
