import electronUpdater from 'electron-updater';
import {
  configureRealUpdateAcceptanceUpdater,
  driveRealUpdateAcceptance,
} from './real-update-acceptance';

const { autoUpdater } = electronUpdater;
let started = false;

export function startRealUpdateAcceptanceDriver(): void {
  if (started) return;
  const config = configureRealUpdateAcceptanceUpdater(autoUpdater);
  if (!config || config.phase !== 'ready') return;
  started = true;
  void driveRealUpdateAcceptance(autoUpdater);
}
