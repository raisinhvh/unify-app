; Custom NSIS hooks for the Windows installer (electron-builder includes this via nsis.include).
; Show the file list while installing, so a long step is visibly progressing instead of looking stuck.
!macro customHeader
  ShowInstDetails show
!macroend

; Windows 11 power-throttles (EcoQoS) processes whose window is in the background, so an unfocused
; installer could sit at one step for minutes and then finish in seconds once it was brought forward.
; Opt this process out of execution-speed throttling: SetProcessInformation(GetCurrentProcess(),
; ProcessPowerThrottling = 4, { Version = 1, ControlMask = EXECUTION_SPEED (1), StateMask = 0 }).
; Older Windows versions reject the call, which is harmless.
!macro unifyDisablePowerThrottling
  Push $0
  Push $1
  System::Call '*(i 1, i 1, i 0) p .r0'
  System::Call 'kernel32::SetProcessInformation(p -1, i 4, p r0, i 12) i .r1'
  System::Free $0
  Pop $1
  Pop $0
!macroend

!macro customInit
  !insertmacro unifyDisablePowerThrottling
!macroend

; The uninstaller also runs during every update (it removes the old version's files).
!macro customUnInit
  !insertmacro unifyDisablePowerThrottling
!macroend
