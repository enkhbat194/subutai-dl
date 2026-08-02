!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\updater\cache-current-installer.ps1" -InstallerPath "$EXEPATH" -Version "${VERSION}"'
  Pop $0
  StrCmp $0 "0" +2
  Abort "Subutai rollback package cache failed. Installation was not committed."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\native-messaging\register-native-host.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  StrCmp $0 "0" +2
  Abort "Subutai browser integration registration failed. Installation was not committed."
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\native-messaging\unregister-native-host.ps1"'
!macroend
