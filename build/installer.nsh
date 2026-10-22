; Lets LAN Messenger through Windows Firewall so other PCs can reach it.
; Works when the installer runs with administrator rights ("Install for all
; users"); otherwise Windows asks the first time the app starts.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Messenger"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LAN Messenger" dir=in action=allow program="$INSTDIR\LAN Messenger.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LAN Messenger"'
!macroend
