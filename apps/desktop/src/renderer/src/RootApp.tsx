import type { ReactElement } from 'react';
import { MediaLauncher } from './MediaLauncher';
import { SubutaiApp } from './SubutaiApp';

export function RootApp(): ReactElement {
  return (
    <>
      <SubutaiApp />
      <MediaLauncher />
    </>
  );
}
