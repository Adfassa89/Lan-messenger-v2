; Lets LAN Messenger 2 through Windows Firewall so other PCs can reach it.
; Works when the installer runs with administrator rights ("Install for all
; users"); otherwise Windows asks the first time the app starts.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Messenger"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Messenger 2"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LAN Messenger 2" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Messenger 2"'
!macroend
